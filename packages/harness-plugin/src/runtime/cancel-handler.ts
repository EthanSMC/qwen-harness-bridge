import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";

export type JobCancelMessage = Extract<
  ConnectorServerMessage,
  { type: "job.cancel" }
>;
export type CancelOutcome =
  | "cancelled"
  | "terminal"
  | "ignored"
  | "unavailable";

/** A stable owner capability for one attempt. resolveOwner must match command
 * job/attempt/revision against trusted local authority (never inbound-as-truth).
 * It must return the SAME object on retries, and never reuse it for a new turn.
 * Task 6 must fence new work while cancellation is active and share this terminal
 * boundary with all result producers. drainTerminals waits for committed Harness
 * result processing, including late success/failure, after Agent quiescence.
 * commitCancelled atomically checks terminal absence and persists/enqueues one
 * job.cancelled; false means a committed terminal won. It must recheck ownership
 * and throw on unavailable/revoked authority rather than reporting a terminal.
 * Do not wire this alongside AgentAdapter's independent terminal emitter: that
 * adapter currently maps aborted to failed and needs shared arbitration wiring.
 */
export type CancellationOwner = {
  readonly jobId: string;
  readonly attempt: number;
  readonly revision: number;
  readonly agent: Agent;
  readonly approval?: AbortController;
  hasTerminal(): boolean;
  isCurrent(): boolean;
  drainTerminals(): Promise<void>;
  commitCancelled(): boolean | Promise<boolean>;
};
export type CancelHandlerOptions = Readonly<{
  resolveOwner(command: JobCancelMessage): CancellationOwner | undefined;
  /** Trusted synchronous coordinator fence; asynchronous preparation is invalid. */
  beforeCancel?(owner: CancellationOwner): undefined;
}>;

export class CancelHandler {
  readonly #options: CancelHandlerOptions;
  readonly #tasks = new WeakMap<CancellationOwner, Promise<CancelOutcome>>();
  // Retain effect history, not a cached outcome: persistence/drain can recover.
  readonly #issued = new WeakSet<CancellationOwner>();
  readonly #uncertain = new WeakSet<CancellationOwner>();
  constructor(options: CancelHandlerOptions) {
    this.#options = options;
  }

  async handle(command: JobCancelMessage): Promise<CancelOutcome> {
    const parsed = ConnectorServerMessageSchema.safeParse(command);
    if (
      !parsed.success ||
      parsed.data.type !== "job.cancel" ||
      Date.parse(parsed.data.expires_at) <= Date.now()
    )
      return "ignored";
    try {
      const {
        job_id: jobId,
        attempt,
        job_revision: revision,
      } = parsed.data.payload;
      const expiresAt = Date.parse(parsed.data.expires_at);
      const owner = this.#options.resolveOwner(parsed.data);
      if (
        !owner ||
        owner.jobId !== jobId ||
        owner.attempt !== attempt ||
        owner.revision !== revision ||
        !owner.isCurrent() ||
        expiresAt <= Date.now()
      )
        return "ignored";
      const existing = this.#tasks.get(owner);
      if (existing) return existing;
      if (owner.hasTerminal()) return "terminal";
      if (this.#uncertain.has(owner)) return "unavailable";
      const retry = this.#issued.has(owner);
      const agent = owner.agent;
      if (agent.status !== (retry ? "idle" : "running")) return "ignored";
      // Install the single-flight task before invoking any reentrant Agent or
      // abort listener. Only the first command can invoke cancel for this owner.
      let resolve!: (outcome: CancelOutcome) => void;
      const task = new Promise<CancelOutcome>((done) => {
        resolve = done;
      });
      this.#tasks.set(owner, task);
      const finish = (outcome: CancelOutcome) => {
        this.#tasks.delete(owner);
        resolve(outcome);
      };
      void this.#cancel(owner, agent, retry, expiresAt, {
        jobId,
        attempt,
        revision,
      }).then(finish, () => finish("unavailable"));
      return task;
    } catch {
      return "unavailable";
    }
  }

  async #cancel(
    owner: CancellationOwner,
    agent: Agent,
    retry: boolean,
    expiresAt: number,
    identity: Pick<CancellationOwner, "jobId" | "attempt" | "revision">,
  ): Promise<CancelOutcome> {
    if (!retry) {
      const result: unknown = this.#options.beforeCancel?.(owner);
      if (result !== undefined) {
        // Reject asynchronous hooks immediately. Observe native rejection only;
        // settlement cannot resume cancellation or create a dependency cycle.
        if (result instanceof Promise) void result.catch(() => {});
        return "unavailable";
      }
      if (
        owner.jobId !== identity.jobId ||
        owner.attempt !== identity.attempt ||
        owner.revision !== identity.revision ||
        owner.agent !== agent ||
        !owner.isCurrent() ||
        Date.now() >= expiresAt
      )
        return "ignored";
      if (owner.hasTerminal()) return "terminal";
      if (agent.status !== "running") return "ignored";
      // A throwing cancel may already have issued an effect. Never repeat it or
      // infer successful cancellation from later idle alone.
      this.#uncertain.add(owner);
      try {
        agent.cancel({ kind: "user" });
        this.#issued.add(owner);
        this.#uncertain.delete(owner);
      } finally {
        owner.approval?.abort();
      }
    }
    await agent.whenIdle();
    await owner.drainTerminals();
    if (!owner.isCurrent() || Date.now() >= expiresAt) return "ignored";
    return (await owner.commitCancelled()) ? "cancelled" : "terminal";
  }
}
