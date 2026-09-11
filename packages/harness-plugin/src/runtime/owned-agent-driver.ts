import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { type Session, SessionId } from "@deepseek-ai/dsh-session";
import type { HarnessAgentRegistry } from "../harness/types.js";
import type { OwnedIntent } from "../store/owned-intent.js";
import type {
  LocalTerminalBinding,
  TerminalCommitResult,
} from "../store/owned-terminal.js";
import type { TerminalPluginStore } from "../store/plugin-store.js";
import type {
  ConnectorEpoch,
  TerminalConnectorClient,
} from "../transport/connector-client.js";
import type { CancellationOwner, JobCancelMessage } from "./cancel-handler.js";
import {
  admitCoordinationTiming,
  type CoordinationClockSample,
} from "./coordination-deadlines.js";
import {
  admitInitialStart,
  type InitialStartMode,
} from "./initial-start-admission.js";
import type {
  JobOfferMessage,
  OwnedJobStarter,
  RepositoryAliasResolver,
} from "./job-command-coordinator.js";
import type { JobStateClient } from "./job-state-client.js";
import {
  beginTerminalAuthority,
  type TerminalAuthority,
  type TerminalAuthorityIssuer,
} from "./terminal-authority.js";

export type OwnedDriverErrorCode =
  | "HARNESS_PERSISTENCE_UNAVAILABLE"
  | "HARNESS_INITIAL_INPUT_UNPROVEN"
  | "HARNESS_SESSION_ID_MISMATCH"
  | "HARNESS_OWNED_ATTEMPT_UNAVAILABLE";

export class OwnedDriverError extends Error {
  constructor(readonly code: OwnedDriverErrorCode) {
    super(code);
    this.name = "OwnedDriverError";
  }
}

export type OwnedAgentDriverOptions = Readonly<{
  agents: Pick<HarnessAgentRegistry, "create">;
  store: TerminalPluginStore;
  states: Pick<JobStateClient, "observe">;
  authority: Pick<TerminalAuthorityIssuer, "issue">;
  terminal: Pick<
    TerminalConnectorClient,
    "commitTerminal" | "reconcileTerminal"
  >;
  epoch: () => ConnectorEpoch | undefined;
  repositories: RepositoryAliasResolver;
  /** Durable, ordered publication of `job.claim` for this exact offer. The
   * following state exchange proves consumption; a resolved send is not a grant. */
  publishClaim: (offer: JobOfferMessage) => Promise<void>;
  /** Real native persistence checkpoint for the session. Must resolve true only
   * when an actual durability listener participated and every listener settled. */
  flush: (session: Session) => Promise<boolean>;
  agentOptions?: AgentOptions;
  setup?: AgentSetup;
  /** Per-Agent composition (for example the policy guard) derived from the
   * preallocated SessionId and the owned attempt identity. Takes precedence
   * over a static `setup`. */
  setupFactory?: (
    sessionId: string,
    context: Readonly<{
      jobId: string;
      attempt: number;
      repositoryId: string;
      repositoryPath: string;
    }>,
  ) => AgentSetup;
  /** Terminal/cancel/teardown hook: revoke the per-Agent trusted projection. */
  onAttemptEnded?: (agent: Agent) => void;
  now?: () => number;
  randomUUID?: () => string;
  signal?: AbortSignal;
}>;

const attemptKey = (jobId: string, attempt: number): string =>
  `${jobId}\u0000${attempt}`;

type LiveCancellation = Readonly<{
  revision: number;
  authority: TerminalAuthority;
  binding: LocalTerminalBinding;
}>;

type LiveAttempt = {
  intent: OwnedIntent;
  readonly handle: AgentHandle;
  /** Ends permanently with this attempt; fences every issued authority. */
  readonly operationLifetime: AbortController;
  /** Normal work and pending approvals; aborted by cancellation. */
  readonly normalWork: AbortController;
  terminalWork: Promise<void>;
  cancellation?: LiveCancellation;
};

/** Inspect the agent's own durable history for the exact preallocated initial
 * user message. A caller-supplied proof is not a flush; this only reads what the
 * session already committed. */
export function initialEventSequence(
  session: Session,
  messageId: string,
): number | undefined {
  try {
    for (const event of session.ownEvents()) {
      if (event.type !== "user/message") continue;
      const data = event.data as { id?: unknown } | null;
      if (data !== null && data?.id === messageId) return Number(event.seq);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** ADR 0006/0007 native driver for one owned attempt. It owns exactly one
 * preallocated SessionId per offer/attempt, persists the intent before any
 * factory effect, commits submitting before the single initial followup, records
 * started only after a real own-session persistence flush, and routes every
 * terminal outcome (native result, confirmed cancellation) through the one
 * owned-terminal boundary. Remote reconciliation and session-event projection
 * remain separate integration slices. */
export class OwnedAgentDriver implements OwnedJobStarter {
  readonly #options: OwnedAgentDriverOptions;
  readonly #starting = new Map<string, Promise<void>>();
  readonly #live = new Map<string, LiveAttempt>();
  #disposed = false;

  constructor(options: OwnedAgentDriverOptions) {
    this.#options = options;
  }

  async start(offer: JobOfferMessage): Promise<void> {
    if (this.#disposed || this.#options.signal?.aborted) return;
    if (Date.parse(offer.expires_at) <= this.#now()) return;
    const repositoryPath = this.#options.repositories.resolve(
      offer.payload.repository_id,
    );
    if (repositoryPath === undefined) return;
    const key = attemptKey(offer.payload.job_id, offer.payload.attempt);
    const inFlight = this.#starting.get(key);
    if (inFlight !== undefined) return inFlight;
    const task = this.#start(offer, repositoryPath, key);
    this.#starting.set(key, task);
    return task;
  }

  /** Confirm the exact cancelling revision from a fresh state exchange and issue
   * the one cancellation authority for the live attempt. False means no
   * cancellation authority exists; the caller must not treat the command as
   * admitted and must not arm a later cancellation. */
  async admitCancellation(command: JobCancelMessage): Promise<boolean> {
    const live = this.#live.get(
      attemptKey(command.payload.job_id, command.payload.attempt),
    );
    if (!live || live.operationLifetime.signal.aborted) return false;
    if (live.cancellation?.revision === command.payload.job_revision)
      return true;
    const current = this.#options.store.ownedIntent(
      command.payload.job_id,
      command.payload.attempt,
    );
    if (current?.phase !== "started") return false;
    const binding: LocalTerminalBinding = {
      owner: current.owner,
      expectedVersion: current.version,
      operation: {
        kind: "cancel",
        cancelRevision: command.payload.job_revision,
      },
    };
    let authority: TerminalAuthority;
    try {
      authority = await this.#options.authority.issue({
        ...binding,
        command,
        signal: live.operationLifetime.signal,
      });
    } catch {
      return false;
    }
    live.cancellation = Object.freeze({
      revision: command.payload.job_revision,
      authority,
      binding,
    });
    return true;
  }

  /** Stable owner for the CancelHandler. It never arms future work: it exists
   * only while this exact attempt and admitted cancellation authority are live. */
  cancellationOwner(command: JobCancelMessage): CancellationOwner | undefined {
    const live = this.#live.get(
      attemptKey(command.payload.job_id, command.payload.attempt),
    );
    const cancellation = live?.cancellation;
    if (!live || !cancellation || live.operationLifetime.signal.aborted)
      return undefined;
    if (cancellation.revision !== command.payload.job_revision)
      return undefined;
    return {
      jobId: command.payload.job_id,
      attempt: command.payload.attempt,
      revision: cancellation.revision,
      agent: live.handle.agent,
      approval: live.normalWork,
      hasTerminal: () =>
        this.#options.store.readTerminal(live.intent.owner)?.kind === "local",
      isCurrent: () =>
        !live.operationLifetime.signal.aborted &&
        this.#options.epoch() !== undefined,
      drainTerminals: () => live.terminalWork,
      commitCancelled: () => {
        const result = this.#options.terminal.commitTerminal(
          cancellation.binding,
          cancellation.authority,
        );
        if (result.kind === "remote")
          throw new Error("CONNECTOR_TERMINAL_RECONCILIATION_REQUIRED");
        const won = result.kind === "committed" || result.relation === "same";
        if (won) this.#endAttempt(live);
        return won;
      },
    };
  }

  /** Synchronous pre-effect fence for the cancellation owner: consume the issued
   * authority and withdraw normal work/approvals. */
  beginCancellation(owner: CancellationOwner): undefined {
    const live = this.#live.get(attemptKey(owner.jobId, owner.attempt));
    const cancellation = live?.cancellation;
    if (live && cancellation) {
      beginTerminalAuthority(cancellation.authority, cancellation.binding);
      live.normalWork.abort();
    }
    return undefined;
  }

  /** Route one native terminal outcome through the shared durable sink. The
   * native projection is redacted by the transport's commit path. */
  async commitNativeOutcome(
    input: Readonly<{
      jobId: string;
      attempt: number;
      outcome: "succeeded" | "failed";
      eventSequence: number;
      projection?: unknown;
    }>,
  ): Promise<TerminalCommitResult> {
    const live = this.#live.get(attemptKey(input.jobId, input.attempt));
    if (!live || live.operationLifetime.signal.aborted)
      throw new OwnedDriverError("HARNESS_OWNED_ATTEMPT_UNAVAILABLE");
    const current = this.#options.store.ownedIntent(input.jobId, input.attempt);
    if (current?.phase !== "started")
      throw new OwnedDriverError("HARNESS_OWNED_ATTEMPT_UNAVAILABLE");
    const binding: LocalTerminalBinding = {
      owner: current.owner,
      expectedVersion: current.version,
      operation: {
        kind: "native",
        outcome: input.outcome,
        eventSequence: input.eventSequence,
      },
    };
    const work = (async () => {
      const authority = await this.#options.authority.issue({
        ...binding,
        signal: live.operationLifetime.signal,
      });
      beginTerminalAuthority(authority, binding);
      return this.#options.terminal.commitTerminal(
        binding,
        authority,
        input.projection,
      );
    })();
    live.terminalWork = live.terminalWork.then(() =>
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    const result = await work;
    this.#endAttempt(live);
    return result;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const live = [...this.#live.values()];
    for (const attempt of live) {
      attempt.operationLifetime.abort();
      attempt.normalWork.abort();
      this.#endAttempt(attempt);
    }
    await Promise.allSettled(live.map((attempt) => attempt.handle.dispose()));
    await Promise.allSettled(live.map((attempt) => attempt.terminalWork));
    this.#live.clear();
  }

  async #start(
    offer: JobOfferMessage,
    repositoryPath: string,
    key: string,
  ): Promise<void> {
    try {
      if (
        this.#options.store.ownedIntent(
          offer.payload.job_id,
          offer.payload.attempt,
        ) !== undefined
      )
        return;
      const sessionId = this.#uuid();
      const ownerGeneration = this.#uuid();
      const message = createUserMessage({
        content: [{ type: "text", text: offer.payload.request }],
        source: { kind: "user" },
      });
      const initialMessageId = String(message.id);
      let intent = this.#options.store.prepareOwnedIntent({
        offer,
        sessionId,
        initialMessageId,
        ownerGeneration,
      });
      await this.#options.publishClaim(offer);
      const mode = await this.#admit(intent, offer);
      if (mode === undefined) return;
      intent = this.#options.store.advanceOwnedIntent(
        intent.owner,
        intent.version,
        { phase: "creating", mode },
      );
      const handle = await this.#options.agents.create({
        sessionId: SessionId(intent.owner.sessionId),
        meta: { cwd: repositoryPath },
        agentOptions: this.#options.agentOptions,
        setup:
          this.#options.setupFactory !== undefined
            ? this.#options.setupFactory(intent.owner.sessionId, {
                jobId: intent.owner.jobId,
                attempt: intent.owner.attempt,
                repositoryId: intent.owner.repositoryId,
                repositoryPath,
              })
            : this.#options.setup,
      });
      try {
        if (String(handle.agent.id) !== intent.owner.sessionId)
          throw new OwnedDriverError("HARNESS_SESSION_ID_MISMATCH");
        intent = this.#options.store.advanceOwnedIntent(
          intent.owner,
          intent.version,
          { phase: "submitting" },
        );
        handle.agent.followup(message);
        const flushed = await this.#options.flush(handle.agent.session);
        if (flushed !== true)
          throw new OwnedDriverError("HARNESS_PERSISTENCE_UNAVAILABLE");
        const eventSequence = initialEventSequence(
          handle.agent.session,
          initialMessageId,
        );
        if (eventSequence === undefined)
          throw new OwnedDriverError("HARNESS_INITIAL_INPUT_UNPROVEN");
        const started = this.#options.store.advanceOwnedIntent(
          intent.owner,
          intent.version,
          {
            phase: "started",
            evidence: {
              sessionId: intent.owner.sessionId,
              messageId: initialMessageId,
              requestDigest: intent.requestDigest,
              eventSequence,
            },
          },
        );
        this.#live.set(key, {
          intent: started,
          handle,
          operationLifetime: new AbortController(),
          normalWork: new AbortController(),
          terminalWork: Promise.resolve(),
        });
      } catch (error) {
        await this.#disposeHandle(handle);
        throw error;
      }
    } finally {
      if (this.#starting.get(key) !== undefined) this.#starting.delete(key);
    }
  }

  async #admit(
    intent: OwnedIntent,
    offer: JobOfferMessage,
  ): Promise<InitialStartMode | undefined> {
    let exchange: Awaited<ReturnType<JobStateClient["observe"]>>;
    try {
      exchange = await this.#options.states.observe({
        jobId: offer.payload.job_id,
        repositoryId: offer.payload.repository_id,
        attempt: offer.payload.attempt,
        signal: this.#options.signal,
      });
    } catch {
      return undefined;
    }
    const epoch = exchange.epoch;
    if (
      epoch === undefined ||
      epoch.signal.aborted ||
      epoch !== this.#options.epoch()
    )
      return undefined;
    const { state, request } = exchange;
    if (
      request.epoch !== epoch ||
      request.jobId !== offer.payload.job_id ||
      request.attempt !== offer.payload.attempt ||
      state.payload.job_id !== offer.payload.job_id ||
      state.payload.request_message_id !== request.messageId ||
      state.payload.request_sequence !== request.sequence ||
      state.payload.nonce !== request.nonce
    )
      return undefined;
    const timing = admitCoordinationTiming(
      state.payload,
      exchange.sent,
      exchange.received,
    );
    if (timing === undefined) return undefined;
    const admitted = admitInitialStart({
      state: state.payload,
      offer,
      intent,
      repositoryId: offer.payload.repository_id,
      timing,
      now: this.#sample(exchange.received),
    });
    return admitted?.mode;
  }

  #sample(now: CoordinationClockSample): CoordinationClockSample {
    return Object.freeze({
      wallTimeMs: now.wallTimeMs,
      monotonicTimeMs: now.monotonicTimeMs,
    });
  }

  #endAttempt(attempt: LiveAttempt): void {
    try {
      this.#options.onAttemptEnded?.(attempt.handle.agent);
    } catch {
      // Revocation is contained; it cannot fail teardown.
    }
  }

  async #disposeHandle(handle: AgentHandle): Promise<void> {
    try {
      await handle.dispose();
    } catch {
      // Disposal failure is contained; the ownership conflict still fails closed.
    }
  }

  #uuid(): string {
    return this.#options.randomUUID?.() ?? randomUUID();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}