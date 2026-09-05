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
}>;

export class CancelHandler {
  readonly #options: CancelHandlerOptions;
  readonly #tasks = new WeakMap<CancellationOwner, Promise<CancelOutcome>>();
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
      const owner = this.#options.resolveOwner(parsed.data);
      if (
        !owner ||
        owner.jobId !== parsed.data.payload.job_id ||
        owner.attempt !== parsed.data.payload.attempt ||
        owner.revision !== parsed.data.payload.job_revision ||
        !owner.isCurrent() ||
        Date.parse(parsed.data.expires_at) <= Date.now()
      )
        return "ignored";
      const existing = this.#tasks.get(owner);
      if (existing) return existing;
      if (owner.hasTerminal()) return "terminal";
      if (owner.agent.status !== "running") return "ignored";
      // Install the single-flight task before invoking any reentrant Agent or
      // abort listener. Only the first command can invoke cancel for this owner.
      let resolve!: (outcome: CancelOutcome) => void;
      const task = new Promise<CancelOutcome>((done) => {
        resolve = done;
      });
      this.#tasks.set(owner, task);
      void this.#cancel(owner).then(resolve, () => resolve("unavailable"));
      return task;
    } catch {
      return "unavailable";
    }
  }

  async #cancel(owner: CancellationOwner): Promise<CancelOutcome> {
    try {
      owner.agent.cancel({ kind: "user" });
    } finally {
      owner.approval?.abort();
    }
    await owner.agent.whenIdle();
    await owner.drainTerminals();
    if (!owner.isCurrent()) return "ignored";
    return (await owner.commitCancelled()) ? "cancelled" : "terminal";
  }
}
