import { randomUUID } from "node:crypto";
import type { AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  type Session,
  type SessionEvent,
  SessionId,
} from "@deepseek-ai/dsh-session";
import type { LocalJobMapping } from "../store/plugin-store.js";
import {
  normalizeSessionEvent,
  normalizeTerminalEvent,
} from "./event-normalizer.js";
import { registerSessionListener } from "./register-session-listener.js";
import type {
  HarnessAdapterOptions,
  HarnessAgentAdapter,
  HarnessContext,
  HarnessMappingStore,
  NormalizedHarnessEvent,
  OwnedSession,
} from "./types.js";

export { registerSessionListener } from "./register-session-listener.js";
export type {
  HarnessAdapterOptions,
  HarnessAgentAdapter,
  HarnessContext,
  HarnessMappingStore,
  NormalizedHarnessEvent,
} from "./types.js";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "completed",
  "terminal",
  "lost",
  "denied",
  "done",
]);

const isActiveStatus = (status: string): boolean =>
  status.length > 0 && !TERMINAL_STATUSES.has(status);

const mappingKey = (jobId: string, attempt: number): string =>
  `${jobId}\u0000${attempt}`;

type OwnedAgent = OwnedSession & {
  readonly handle: AgentHandle;
  readonly seenSequences: Set<number>;
  idleTask?: Promise<void>;
  terminal?: NormalizedHarnessEvent;
  terminalEmitted: boolean;
};

type MappingLookup =
  | {
      readonly mapping: LocalJobMapping | undefined;
      readonly unavailable: false;
    }
  | { readonly mapping: undefined; readonly unavailable: true };

export class AgentAdapter implements HarnessAgentAdapter {
  readonly ready: Promise<void>;

  readonly #ctx: HarnessContext;
  readonly #store: HarnessMappingStore;
  readonly #agentOptions: AgentOptions | undefined;
  readonly #setup: HarnessAdapterOptions["setup"];
  readonly #onEvent: (event: NormalizedHarnessEvent) => void | Promise<void>;
  readonly #ownedBySession = new Map<string, OwnedAgent>();
  readonly #ownedByAttempt = new Map<string, OwnedAgent>();
  readonly #latestByJob = new Map<string, OwnedAgent>();
  readonly #createTasks = new Map<string, Promise<{ sessionId: string }>>();
  readonly #resumeTasks = new Set<Promise<boolean>>();
  readonly #resumeTasksByAttempt = new Map<string, Promise<boolean>>();
  readonly #lost = new Set<string>();
  readonly #idleTasks = new Set<Promise<void>>();
  #unregister: (() => void) | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: HarnessAdapterOptions) {
    this.#ctx = options.ctx;
    this.#store = options.store;
    this.#agentOptions = options.agentOptions;
    this.#setup = options.setup;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#unregister = registerSessionListener(
      this.#ctx,
      this.#ownedBySession,
      (owner, session, event) =>
        this.#handleSessionEvent(owner, session, event),
    );
    this.ready = this.#recover(options.recoverMappings);
  }

  async create(input: {
    jobId: string;
    repositoryPath: string;
    request: string;
  }): Promise<{ sessionId: string }> {
    await this.ready;
    this.#assertUsable();

    const inFlight = this.#createTasks.get(input.jobId);
    if (inFlight !== undefined) return inFlight;

    const task = this.#createInternal(input);
    this.#createTasks.set(input.jobId, task);
    try {
      return await task;
    } finally {
      if (this.#createTasks.get(input.jobId) === task) {
        this.#createTasks.delete(input.jobId);
      }
    }
  }

  async #createInternal(input: {
    jobId: string;
    repositoryPath: string;
    request: string;
  }): Promise<{ sessionId: string }> {
    this.#assertUsable();

    const existing = this.#latestByJob.get(input.jobId);
    if (existing !== undefined) return { sessionId: existing.sessionId };

    const lookup = this.#findMapping(input.jobId);
    if (lookup.unavailable) throw new Error("HARNESS_MAPPING_UNAVAILABLE");
    if (lookup.mapping !== undefined && isActiveStatus(lookup.mapping.status)) {
      await this.#startResume(lookup.mapping);
      const resumedOwner = this.#latestByJob.get(input.jobId);
      if (resumedOwner !== undefined) {
        return { sessionId: resumedOwner.sessionId };
      }
      throw new Error("HARNESS_SESSION_LOST");
    }

    const attempt = (lookup.mapping?.attempt ?? 0) + 1;
    const requestedSessionId = SessionId(randomUUID());
    const handle = await this.#ctx.agents.create({
      sessionId: requestedSessionId,
      meta: { cwd: input.repositoryPath },
      agentOptions: this.#agentOptions,
      setup: this.#setup,
    });
    if (this.#disposed) {
      await handle.dispose();
      throw new Error("HARNESS_ADAPTER_DISPOSED");
    }

    let owner: OwnedAgent | undefined;
    try {
      owner = this.#attach(input.jobId, attempt, handle);
      this.#store.mapJob({
        jobId: owner.jobId,
        attempt: owner.attempt,
        sessionId: owner.sessionId,
        status: "running",
      });
    } catch (error) {
      if (owner !== undefined) this.#detach(owner);
      await handle.dispose().catch(() => undefined);
      throw error;
    }

    const message = createUserMessage({
      content: [{ type: "text", text: input.request }],
      source: { kind: "user" },
    });
    try {
      owner.handle.agent.followup(message);
    } catch (error) {
      this.#detach(owner);
      await owner.handle.dispose().catch(() => undefined);
      throw error;
    }
    this.#watchIdle(owner);
    return { sessionId: owner.sessionId };
  }

  async resume(input: { jobId: string; sessionId: string }): Promise<void> {
    await this.ready;
    this.#assertUsable();

    const existing = this.#latestByJob.get(input.jobId);
    if (existing !== undefined) return;

    const lookup = this.#findMapping(input.jobId);
    const mapping = lookup.mapping;
    if (
      lookup.unavailable ||
      mapping === undefined ||
      mapping.sessionId !== input.sessionId ||
      !isActiveStatus(mapping.status)
    ) {
      this.#emitSessionLost({
        jobId: input.jobId,
        attempt: mapping?.attempt ?? 1,
        sessionId: input.sessionId,
      });
      return;
    }

    await this.#startResume(mapping);
  }

  async cancel(
    jobId: string,
  ): Promise<"requested" | "already_idle" | "unknown"> {
    await this.ready;
    this.#assertUsable();

    const owner = this.#latestByJob.get(jobId);
    if (owner === undefined) {
      const lookup = this.#findMapping(jobId);
      if (lookup.mapping === undefined || lookup.unavailable) return "unknown";
      return isActiveStatus(lookup.mapping.status) ? "unknown" : "already_idle";
    }

    if (owner.terminalEmitted || owner.handle.agent.status === "idle") {
      this.#watchIdle(owner);
      return "already_idle";
    }

    try {
      owner.handle.agent.cancel({ kind: "user" });
      await owner.handle.agent.whenIdle();
      await this.#settleTerminal(owner);
      return "requested";
    } catch {
      return "unknown";
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;

    this.#disposePromise = (async () => {
      this.#disposed = true;
      const unregister = this.#unregister;
      this.#unregister = undefined;
      unregister?.();

      await Promise.allSettled([
        this.ready,
        ...this.#createTasks.values(),
        ...this.#resumeTasks,
      ]);
      const owners = [...this.#ownedByAttempt.values()];
      await Promise.allSettled(owners.map((owner) => owner.handle.dispose()));
      await Promise.allSettled([...this.#idleTasks]);
      this.#ownedBySession.clear();
      this.#ownedByAttempt.clear();
      this.#latestByJob.clear();
    })();

    return this.#disposePromise;
  }

  async #recover(
    requestedMappings: HarnessAdapterOptions["recoverMappings"] | undefined,
  ): Promise<void> {
    let mappings: readonly LocalJobMapping[] = [];
    try {
      if (Array.isArray(requestedMappings)) {
        mappings = requestedMappings;
      } else if (typeof requestedMappings === "function") {
        mappings = await requestedMappings();
      } else {
        mappings = this.#store.listNonterminalJobs?.() ?? [];
      }
    } catch {
      return;
    }

    for (const mapping of mappings) {
      if (this.#disposed || !isActiveStatus(mapping.status)) continue;
      await this.#startResume(mapping);
    }
  }

  #startResume(mapping: LocalJobMapping): Promise<boolean> {
    const key = mappingKey(mapping.jobId, mapping.attempt);
    const inFlight = this.#resumeTasksByAttempt.get(key);
    if (inFlight !== undefined) return inFlight;

    const task = this.#resumeMapping(mapping);
    this.#resumeTasks.add(task);
    this.#resumeTasksByAttempt.set(key, task);
    void task.then(
      () => {
        this.#resumeTasks.delete(task);
        if (this.#resumeTasksByAttempt.get(key) === task) {
          this.#resumeTasksByAttempt.delete(key);
        }
      },
      () => {
        this.#resumeTasks.delete(task);
        if (this.#resumeTasksByAttempt.get(key) === task) {
          this.#resumeTasksByAttempt.delete(key);
        }
      },
    );
    return task;
  }

  async #resumeMapping(mapping: LocalJobMapping): Promise<boolean> {
    const key = mappingKey(mapping.jobId, mapping.attempt);
    if (this.#ownedByAttempt.has(key)) return true;
    if (this.#lost.has(key)) return false;

    let handle: AgentHandle | undefined;
    let attached: OwnedAgent | undefined;
    try {
      handle = await this.#ctx.agents.resume({
        resumeSessionId: SessionId(mapping.sessionId),
        agentOptions: this.#agentOptions,
        setup: this.#setup,
      });
      if (this.#disposed) {
        await handle.dispose();
        return false;
      }
      if (String(handle.agent.id) !== mapping.sessionId) {
        await handle.dispose();
        handle = undefined;
        throw new Error("HARNESS_SESSION_ID_MISMATCH");
      }
      attached = this.#attach(mapping.jobId, mapping.attempt, handle);
      this.#store.mapJob({
        jobId: attached.jobId,
        attempt: attached.attempt,
        sessionId: attached.sessionId,
        status: "running",
      });
      this.#captureTerminalFromHistory(attached);
      this.#watchIdle(attached);
      return true;
    } catch {
      if (attached !== undefined) this.#detach(attached);
      if (handle !== undefined) {
        await handle.dispose().catch(() => undefined);
      }
      if (!this.#disposed) this.#emitSessionLost(mapping);
      return false;
    }
  }

  #attach(jobId: string, attempt: number, handle: AgentHandle): OwnedAgent {
    const sessionId = String(handle.agent.id);
    const key = mappingKey(jobId, attempt);
    const existingAttempt = this.#ownedByAttempt.get(key);
    if (existingAttempt !== undefined) return existingAttempt;

    const existingSession = this.#ownedBySession.get(sessionId);
    if (existingSession !== undefined) {
      throw new Error("HARNESS_SESSION_OWNERSHIP_CONFLICT");
    }

    const owner: OwnedAgent = {
      jobId,
      attempt,
      sessionId,
      handle,
      seenSequences: new Set(),
      terminalEmitted: false,
    };
    this.#ownedByAttempt.set(key, owner);
    this.#ownedBySession.set(sessionId, owner);
    this.#latestByJob.set(jobId, owner);
    return owner;
  }

  #detach(owner: OwnedAgent): void {
    this.#ownedByAttempt.delete(mappingKey(owner.jobId, owner.attempt));
    this.#ownedBySession.delete(owner.sessionId);
    if (this.#latestByJob.get(owner.jobId) === owner) {
      this.#latestByJob.delete(owner.jobId);
    }
  }

  #findMapping(jobId: string): MappingLookup {
    try {
      return { mapping: this.#store.findJob(jobId), unavailable: false };
    } catch {
      return { mapping: undefined, unavailable: true };
    }
  }

  #captureTerminalFromHistory(owner: OwnedAgent): void {
    try {
      const events = owner.handle.agent.session?.ownEvents?.();
      const lastEvent = events?.[events.length - 1];
      if (lastEvent === undefined) return;
      const terminal = normalizeTerminalEvent(owner.jobId, lastEvent);
      if (terminal !== undefined) owner.terminal = terminal;
    } catch {
      // Live event delivery remains authoritative if history is unavailable.
    }
  }

  #handleSessionEvent(
    ownerInfo: OwnedSession,
    _session: Session,
    event: SessionEvent,
  ): void {
    if (this.#disposed) return;
    const owner = this.#ownedByAttempt.get(
      mappingKey(ownerInfo.jobId, ownerInfo.attempt),
    );
    if (owner === undefined || owner.terminalEmitted) return;

    const sequence = Number(event.seq);
    if (owner.seenSequences.has(sequence)) return;
    owner.seenSequences.add(sequence);

    const terminal = normalizeTerminalEvent(owner.jobId, event);
    if (terminal !== undefined) {
      owner.terminal = terminal;
      this.#watchIdle(owner);
      return;
    }

    const normalized = normalizeSessionEvent(owner.jobId, event);
    if (normalized !== undefined) this.#emit(normalized);
  }

  #watchIdle(owner: OwnedAgent): void {
    if (this.#disposed) return;
    if (owner.idleTask !== undefined) return;
    const task = owner.handle.agent
      .whenIdle()
      .then(() => this.#settleTerminal(owner))
      .catch(() => undefined);
    owner.idleTask = task;
    this.#idleTasks.add(task);
    void task.finally(() => {
      this.#idleTasks.delete(task);
      if (owner.idleTask === task) owner.idleTask = undefined;
    });
  }

  async #settleTerminal(owner: OwnedAgent): Promise<void> {
    if (
      this.#disposed ||
      owner.terminal === undefined ||
      owner.terminalEmitted
    ) {
      return;
    }
    owner.terminalEmitted = true;
    try {
      this.#store.mapJob({
        jobId: owner.jobId,
        attempt: owner.attempt,
        sessionId: owner.sessionId,
        status:
          owner.terminal.type === "job.succeeded" ? "succeeded" : "failed",
      });
    } catch {
      // The terminal event remains useful even if the optional status write is unavailable.
    }
    this.#emit(owner.terminal);
  }

  #emitSessionLost(owner: OwnedSession): void {
    if (this.#disposed) return;
    const key = mappingKey(owner.jobId, owner.attempt);
    if (this.#lost.has(key)) return;
    this.#lost.add(key);
    try {
      this.#store.mapJob({
        jobId: owner.jobId,
        attempt: owner.attempt,
        sessionId: owner.sessionId,
        status: "failed",
      });
    } catch {
      // A persistence outage is the reason recovery failed; do not retry or leak its details.
    }
    this.#emit({
      jobId: owner.jobId,
      type: "job.failed",
      stage: "failed",
      summary: "HARNESS_SESSION_LOST",
      occurredAt: new Date().toISOString(),
    });
  }

  #emit(event: NormalizedHarnessEvent): void {
    if (this.#disposed) return;
    try {
      void Promise.resolve(this.#onEvent(event)).catch(() => undefined);
    } catch {
      // An event sink cannot interrupt the Harness session or its ownership bookkeeping.
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("HARNESS_ADAPTER_DISPOSED");
  }
}

export { AgentAdapter as HarnessAgentAdapterImpl };
