import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";

export type JobOfferMessage = Extract<
  ConnectorServerMessage,
  { type: "job.offer" }
>;
export type JobCancelMessage = Extract<
  ConnectorServerMessage,
  { type: "job.cancel" }
>;
export type ApprovalDecisionMessage = Extract<
  ConnectorServerMessage,
  { type: "approval.decision" }
>;

/** The single owned-attempt owner for one accepted offer. Implementations must
 * persist the offer/attempt/lease intent and preallocated SessionId before any
 * native factory effect, then enforce the ADR 0005 fresh-state gate. One job
 * attempt is started at most once: retries after a contained failure may run
 * again, but a durable or in-flight attempt must not create a second Agent. */
export interface OwnedJobStarter {
  start(offer: JobOfferMessage): Promise<void>;
}

export interface RepositoryAliasResolver {
  resolve(repositoryId: string): string | undefined;
}

export interface CancelCommandHandler {
  handle(command: JobCancelMessage): Promise<unknown>;
}

export interface ApprovalDecisionSink {
  acceptDecision(command: ApprovalDecisionMessage): "accepted" | "ignored";
}

export type JobCommandCoordinatorOptions = Readonly<{
  starter: OwnedJobStarter;
  cancel: CancelCommandHandler;
  approvals: ApprovalDecisionSink;
  repositories: RepositoryAliasResolver;
  /** Local observability only. The stable protocol never lets a Connector emit
   * `protocol.error`; unrecognized input is surfaced here and never executed. */
  onUnknown?: (command: unknown) => void;
  now?: () => number;
  signal?: AbortSignal;
}>;

const attemptKey = (jobId: string, attempt: number): string =>
  `${jobId}\u0000${attempt}`;

/** Serial dispatch for the Connector's inbound command stream. Commands are
 * validated before any side effect; unknown or malformed input is never
 * executed. The transport's serialized intake must not be blocked: callers may
 * await, but this class contains every collaborator failure. */
export class JobCommandCoordinator {
  readonly #options: JobCommandCoordinatorOptions;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #started = new Set<string>();

  constructor(options: JobCommandCoordinatorOptions) {
    this.#options = options;
  }

  async handle(command: ConnectorServerMessage): Promise<void> {
    try {
      if (this.#options.signal?.aborted) return;
      const parsed = ConnectorServerMessageSchema.safeParse(command);
      if (!parsed.success) {
        this.#unknown(command);
        return;
      }
      const value = parsed.data;
      switch (value.type) {
        case "job.offer":
          await this.#offer(value);
          return;
        case "job.cancel":
          await this.#cancel(value);
          return;
        case "approval.decision":
          this.#approval(value);
          return;
        default:
          this.#unknown(value);
          return;
      }
    } catch {
      // Transport intake stays available; collaborators own their own errors.
    }
  }

  async #offer(command: JobOfferMessage): Promise<void> {
    if (Date.parse(command.expires_at) <= this.#now()) return;
    if (
      this.#options.repositories.resolve(command.payload.repository_id) ===
      undefined
    )
      return;
    const key = attemptKey(command.payload.job_id, command.payload.attempt);
    const pending = this.#inFlight.get(key);
    if (pending !== undefined) return pending;
    if (this.#started.has(key)) return;
    const task = this.#start(command, key);
    this.#inFlight.set(key, task);
    return task;
  }

  async #start(command: JobOfferMessage, key: string): Promise<void> {
    try {
      await this.#options.starter.start(command);
      this.#started.add(key);
    } catch {
      // A failed start did not reach a durable owned attempt; allow a later
      // exact retry rather than caching a permanent failure.
    } finally {
      if (this.#inFlight.get(key) !== undefined) this.#inFlight.delete(key);
    }
  }

  async #cancel(command: JobCancelMessage): Promise<void> {
    try {
      await this.#options.cancel.handle(command);
    } catch {
      // Cancellation is idempotent and retried by the server; contain here.
    }
  }

  #approval(command: ApprovalDecisionMessage): void {
    try {
      this.#options.approvals.acceptDecision(command);
    } catch {
      // A decision that cannot be applied is ignored, never executed.
    }
  }

  #unknown(command: unknown): void {
    try {
      this.#options.onUnknown?.(command);
    } catch {
      // Observability cannot affect transport or execution.
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
