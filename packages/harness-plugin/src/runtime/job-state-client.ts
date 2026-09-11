import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  ConnectorServerMessageSchema,
  JobSyncPayloadSchema,
  RepositoryIdSchema,
} from "@qhb/protocol";
import type {
  ConnectorEpoch,
  CoordinatingConnectorClient,
  PublishedSync,
  ServerEnvelope,
} from "../transport/connector-client.js";
import {
  type CoordinationClockSample,
  coordinationWaiterRemainingMs,
} from "./coordination-deadlines.js";

export type StateExchange = Readonly<{
  state: Extract<ServerEnvelope, { type: "job.state" }>;
  request: PublishedSync;
  epoch: ConnectorEpoch;
  sent: CoordinationClockSample;
  received: CoordinationClockSample;
}>;

type ErrorCode =
  | "JOB_STATE_INVALID_REQUEST"
  | "JOB_STATE_CAPACITY"
  | "JOB_STATE_UNAVAILABLE"
  | "JOB_STATE_ABORTED"
  | "JOB_STATE_DISPOSED";

export class JobStateExchangeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

type Waiter = {
  jobId: string;
  repositoryId: string;
  attempt: number;
  request?: PublishedSync;
  epoch?: ConnectorEpoch;
  sent?: CoordinationClockSample;
  timer?: ReturnType<typeof setTimeout>;
  cleanup: Array<() => void>;
  settled: boolean;
  resolve: (result: StateExchange) => void;
  reject: (error: JobStateExchangeError) => void;
};

/** Correlated observations only. The coordinator separately owns effect admission,
 * publication barriers and remote snapshot/job/lease checks. One registry belongs
 * to one composed connector; a second registry must not bypass these bounds.
 */
export class JobStateClient {
  readonly #connector: CoordinatingConnectorClient;
  readonly #clock: () => CoordinationClockSample;
  readonly #randomUUID: () => string;
  readonly #jobs = new Map<string, Waiter>();
  readonly #requests = new Map<string, Waiter>();
  #termination: ErrorCode | undefined;
  #unsubscribe: (() => void) | undefined;
  #removeParent: (() => void) | undefined;

  constructor(
    options: Readonly<{
      connector: CoordinatingConnectorClient;
      clock?: () => CoordinationClockSample;
      signal?: AbortSignal;
      randomUUID?: () => string;
    }>,
  ) {
    this.#connector = options.connector;
    this.#clock =
      options.clock ??
      (() => ({ wallTimeMs: Date.now(), monotonicTimeMs: performance.now() }));
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    try {
      this.#unsubscribe = this.#connector.onState((message, delivery) => {
        this.#receive(message, delivery);
        return undefined;
      });
      const signal = options.signal;
      if (signal !== undefined) {
        if (!(signal instanceof AbortSignal)) throw new Error();
        const abort = () => this.#stop("JOB_STATE_ABORTED");
        this.#removeParent = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
    } catch {
      this.#stop("JOB_STATE_UNAVAILABLE");
      throw new JobStateExchangeError("JOB_STATE_UNAVAILABLE");
    }
  }

  observe(
    input: Readonly<{
      jobId: string;
      repositoryId: string;
      attempt: number;
      signal?: AbortSignal;
    }>,
  ): Promise<StateExchange> {
    return new Promise((resolve, reject) => {
      let waiter: Waiter | undefined;
      let failure: ErrorCode = "JOB_STATE_INVALID_REQUEST";
      try {
        if (this.#termination !== undefined) {
          reject(new JobStateExchangeError(this.#termination));
          return;
        }
        // Capture declared values once; no spread, enumeration or retained input.
        const job = input.jobId;
        const repository = input.repositoryId;
        const requestedAttempt = input.attempt;
        const signal = input.signal;
        const jobId = JobSyncPayloadSchema.shape.job_id.parse(job);
        const repositoryId = RepositoryIdSchema.parse(repository);
        const attempt =
          JobSyncPayloadSchema.shape.attempt.parse(requestedAttempt);
        if (signal !== undefined && !(signal instanceof AbortSignal))
          throw new Error();
        if (signal?.aborted) {
          reject(new JobStateExchangeError("JOB_STATE_ABORTED"));
          return;
        }
        if (this.#termination !== undefined) {
          reject(new JobStateExchangeError(this.#termination));
          return;
        }
        if (this.#jobs.size >= 32 || this.#jobs.has(jobId)) {
          reject(new JobStateExchangeError("JOB_STATE_CAPACITY"));
          return;
        }
        waiter = {
          jobId,
          repositoryId,
          attempt,
          cleanup: [],
          settled: false,
          resolve,
          reject,
        };
        const pending = waiter;
        this.#jobs.set(jobId, pending);
        failure = "JOB_STATE_UNAVAILABLE";
        if (signal) this.#listen(pending, signal, "JOB_STATE_ABORTED");
        const epoch = this.#connector.currentEpoch();
        if (!epoch || epoch.signal.aborted) throw new Error();
        pending.epoch = epoch;
        this.#listen(pending, epoch.signal, "JOB_STATE_UNAVAILABLE");
        const sent = this.#sample();
        pending.sent = sent;
        if (coordinationWaiterRemainingMs(sent, sent) === undefined)
          throw new Error();
        const nonceInput = this.#randomUUID();
        const correlationInput = this.#randomUUID();
        failure = "JOB_STATE_INVALID_REQUEST";
        const nonce = JobSyncPayloadSchema.shape.nonce.parse(nonceInput);
        const correlationId =
          JobSyncPayloadSchema.shape.nonce.parse(correlationInput);
        failure = "JOB_STATE_UNAVAILABLE";
        if (pending.settled) return;
        if (this.#connector.currentEpoch() !== epoch || epoch.signal.aborted)
          throw new Error();
        this.#connector.publishSync(
          { job_id: jobId, attempt, nonce },
          correlationId,
          (value) => {
            if (pending.settled) return undefined;
            try {
              const request = Object.freeze({
                messageId: value.messageId,
                sequence: value.sequence,
                correlationId: value.correlationId,
                jobId: value.jobId,
                attempt: value.attempt,
                nonce: value.nonce,
                epoch: value.epoch,
              });
              if (
                pending.request !== undefined ||
                !JobSyncPayloadSchema.shape.nonce.safeParse(request.messageId)
                  .success ||
                !Number.isSafeInteger(request.sequence) ||
                request.sequence < 1 ||
                request.jobId !== jobId ||
                request.attempt !== attempt ||
                request.nonce !== nonce ||
                request.correlationId !== correlationId ||
                request.epoch !== epoch ||
                epoch.signal.aborted ||
                this.#connector.currentEpoch() !== epoch ||
                this.#requests.has(request.messageId)
              )
                throw new Error();
              const remaining = coordinationWaiterRemainingMs(
                sent,
                this.#sample(),
              );
              if (remaining === undefined) throw new Error();
              if (pending.settled) return undefined;
              pending.request = request;
              this.#requests.set(request.messageId, pending);
              // Storage consumed the original budget. This handle is never renewed.
              pending.timer = setTimeout(
                () => this.#settle(pending, "JOB_STATE_UNAVAILABLE"),
                remaining,
              );
            } catch {
              this.#settle(pending, "JOB_STATE_UNAVAILABLE");
            }
            return undefined;
          },
        );
        if (!pending.request) this.#settle(pending, "JOB_STATE_UNAVAILABLE");
      } catch {
        if (waiter) this.#settle(waiter, failure);
        else reject(new JobStateExchangeError(failure));
      }
    });
  }

  dispose(): void {
    this.#stop("JOB_STATE_DISPOSED");
  }

  #sample(): CoordinationClockSample {
    const value = this.#clock();
    return Object.freeze({
      wallTimeMs: value.wallTimeMs,
      monotonicTimeMs: value.monotonicTimeMs,
    });
  }

  #listen(waiter: Waiter, signal: AbortSignal, code: ErrorCode): void {
    const abort = () => this.#settle(waiter, code);
    waiter.cleanup.push(() => signal.removeEventListener("abort", abort));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }

  #receive(
    message: Extract<ServerEnvelope, { type: "job.state" }>,
    delivery: Readonly<{ epoch: ConnectorEpoch | null; recovered: boolean }>,
  ): void {
    // Invalid untrusted candidates (including throwing accessors) never escape
    // into the transport's serialized receive pump or disturb a known waiter.
    let state: StateExchange["state"];
    let epoch: ConnectorEpoch | null;
    try {
      if (this.#termination !== undefined || delivery.recovered) return;
      epoch = delivery.epoch;
      if (epoch === null) return;
      const parsed = ConnectorServerMessageSchema.safeParse(message);
      if (!parsed.success || parsed.data.type !== "job.state") return;
      state = parsed.data;
    } catch {
      return;
    }
    const waiter = this.#requests.get(state.payload.request_message_id);
    const request = waiter?.request;
    if (
      !waiter ||
      !request ||
      waiter.settled ||
      state.payload.request_sequence !== request.sequence ||
      state.correlation_id !== request.correlationId ||
      state.payload.job_id !== request.jobId ||
      state.payload.requested_attempt !== request.attempt ||
      state.payload.nonce !== request.nonce ||
      state.payload.repository_id !== waiter.repositoryId ||
      epoch !== request.epoch
    )
      return;
    try {
      if (epoch.signal.aborted || this.#connector.currentEpoch() !== epoch) {
        // A mismatched current generation cannot modify another waiter's state.
        return;
      }
      const received = this.#sample();
      const sent = waiter.sent;
      if (!sent || coordinationWaiterRemainingMs(sent, received) === undefined)
        throw new Error();
      if (waiter.settled) return;
      Object.freeze(state.payload);
      Object.freeze(state);
      this.#settle(
        waiter,
        Object.freeze({ state, request, epoch, sent, received }),
      );
    } catch {
      this.#settle(waiter, "JOB_STATE_UNAVAILABLE");
    }
  }

  #settle(waiter: Waiter, result: ErrorCode | StateExchange): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    for (const cleanup of waiter.cleanup.splice(0)) {
      try {
        cleanup();
      } catch {
        /* Cleanup cannot expose dependency details. */
      }
    }
    this.#jobs.delete(waiter.jobId);
    if (waiter.request) this.#requests.delete(waiter.request.messageId);
    if (typeof result === "string")
      waiter.reject(new JobStateExchangeError(result));
    else waiter.resolve(result);
  }

  #stop(code: ErrorCode): void {
    this.#termination ??= code;
    const unsubscribe = this.#unsubscribe;
    const removeParent = this.#removeParent;
    this.#unsubscribe = undefined;
    this.#removeParent = undefined;
    for (const cleanup of [unsubscribe, removeParent]) {
      try {
        cleanup?.();
      } catch {
        /* First termination reason stays latched. */
      }
    }
    for (const waiter of this.#jobs.values())
      this.#settle(waiter, this.#termination);
  }
}
