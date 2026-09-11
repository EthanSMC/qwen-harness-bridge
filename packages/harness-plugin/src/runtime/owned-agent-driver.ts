import { randomUUID } from "node:crypto";
import type {
  AgentHandle,
  AgentOptions,
  AgentSetup,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { type Session, SessionId } from "@deepseek-ai/dsh-session";
import type { HarnessAgentRegistry } from "../harness/types.js";
import type { OwnedIntent } from "../store/owned-intent.js";
import type { TerminalPluginStore } from "../store/plugin-store.js";
import type { ConnectorEpoch } from "../transport/connector-client.js";
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

export type OwnedDriverErrorCode =
  | "HARNESS_PERSISTENCE_UNAVAILABLE"
  | "HARNESS_INITIAL_INPUT_UNPROVEN"
  | "HARNESS_SESSION_ID_MISMATCH";

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
  now?: () => number;
  randomUUID?: () => string;
  signal?: AbortSignal;
}>;

const attemptKey = (jobId: string, attempt: number): string =>
  `${jobId}\u0000${attempt}`;

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
 * factory effect, commits submitting before the single initial followup, and
 * records started only after a real own-session persistence flush proves the
 * initial input. Terminal routing, cancellation and export of a
 * CancellationOwner remain separate integration slices. */
export class OwnedAgentDriver implements OwnedJobStarter {
  readonly #options: OwnedAgentDriverOptions;
  readonly #starting = new Map<string, Promise<void>>();

  constructor(options: OwnedAgentDriverOptions) {
    this.#options = options;
  }

  async start(offer: JobOfferMessage): Promise<void> {
    if (this.#options.signal?.aborted) return;
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
        setup: this.#options.setup,
      });
      if (String(handle.agent.id) !== intent.owner.sessionId) {
        await this.#dispose(handle);
        throw new OwnedDriverError("HARNESS_SESSION_ID_MISMATCH");
      }
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
      this.#options.store.advanceOwnedIntent(intent.owner, intent.version, {
        phase: "started",
        evidence: {
          sessionId: intent.owner.sessionId,
          messageId: initialMessageId,
          requestDigest: intent.requestDigest,
          eventSequence,
        },
      });
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

  async #dispose(handle: AgentHandle): Promise<void> {
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
