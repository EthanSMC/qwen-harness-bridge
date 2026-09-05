import { randomUUID } from "node:crypto";
import {
  ApprovalRequestedPayloadSchema,
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";

export type ApprovalDecisionMessage = Extract<
  ConnectorServerMessage,
  { type: "approval.decision" }
>;
export type ApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";
export type ApprovalInput = {
  jobId: string;
  attempt: number;
  fingerprint: string;
  actionSummary: string;
  impactSummary: string;
  riskClass: string;
  signal?: AbortSignal;
};
export interface ApprovalBroker {
  request(input: ApprovalInput): Promise<ApprovalOutcome>;
  acceptDecision(message: ApprovalDecisionMessage): "accepted" | "ignored";
}

/** Trusted, synchronous reservation of one job/action lifetime. Task 6 must
 * serialize reservations with job transitions and bind the exact job, attempt,
 * repository and canonical fingerprint. Missing, stale or locally denied action
 * authority must return undefined; caller metadata cannot create authority.
 * requestedRevision is the known
 * server revision + 1 reserved for approval.requested, NOT an inbound decision's
 * revision. Keep it bound through the decision. PluginStore cannot supply it.
 * signal must abort on socket loss, authority loss, or supersession; reconnect
 * must never revive it. isCurrent rechecks the same reservation synchronously.
 * release relinquishes resources, not the consumed server revision.
 */
export type ApprovalReservation = Readonly<{
  requestedRevision: number;
  deadline: number;
  approvalTimeoutSeconds: number;
  signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}>;
export type ApprovalBrokerOptions = Readonly<{
  reserve(input: Readonly<ApprovalInput>): ApprovalReservation | undefined;
  /** Wire to durable publish; its resolution alone does not prove delivery.
   * The reservation signal requires separate actual transport-loss wiring. */
  publish(
    type: "approval.requested",
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<void>;
}>;

type Waiter = {
  payload: ReturnType<typeof ApprovalRequestedPayloadSchema.parse>;
  deadline: number;
  reservation: ApprovalReservation;
  signal?: AbortSignal;
  settle(outcome: ApprovalOutcome, decisionDeadline?: number): void;
};

export class RemoteApprovalBroker implements ApprovalBroker {
  readonly #options: ApprovalBrokerOptions;
  readonly #waiters = new Map<string, Waiter>();
  #disposed = false;
  constructor(options: ApprovalBrokerOptions) {
    this.#options = options;
  }

  async request(input: ApprovalInput): Promise<ApprovalOutcome> {
    input = Object.freeze({ ...input });
    if (input.signal?.aborted) return "cancelled";
    if (input.riskClass === "denied") return "rejected";
    if (this.#disposed || input.riskClass !== "approval_required")
      return "unavailable";
    let reservation: ApprovalReservation | undefined;
    try {
      reservation = this.#options.reserve(input);
      if (!reservation) return "unavailable";
      const timeout = reservation.approvalTimeoutSeconds;
      const deadline = Math.min(
        Date.now() + timeout * 1_000,
        reservation.deadline,
      );
      if (
        !Number.isInteger(timeout) ||
        timeout < 60 ||
        timeout > 1800 ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now() ||
        reservation.signal.aborted ||
        !reservation.isCurrent()
      ) {
        return "unavailable";
      }
      const payload = ApprovalRequestedPayloadSchema.parse({
        approval_id: randomUUID(),
        job_id: input.jobId,
        attempt: input.attempt,
        job_revision: reservation.requestedRevision,
        action_summary: input.actionSummary,
        impact_summary: input.impactSummary,
        risk_class: input.riskClass,
        action_fingerprint: input.fingerprint,
        expires_at: new Date(deadline).toISOString(),
      });
      const authority = reservation;
      let deliveryDeadline = deadline;
      const outcome = await new Promise<ApprovalOutcome>((resolve) => {
        let settled = false;
        const callerAbort = () => settle("cancelled");
        const invalidated = () => settle("unavailable");
        const timer = setTimeout(
          invalidated,
          Math.max(0, deadline - Date.now()),
        );
        const settle = (
          outcome: ApprovalOutcome,
          decisionDeadline = deadline,
        ) => {
          if (settled) return;
          settled = true;
          deliveryDeadline = Math.min(deadline, decisionDeadline);
          this.#waiters.delete(payload.approval_id);
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", callerAbort);
          authority.signal.removeEventListener("abort", invalidated);
          resolve(outcome);
        };
        this.#waiters.set(payload.approval_id, {
          payload,
          deadline,
          reservation: authority,
          signal: input.signal,
          settle,
        });
        input.signal?.addEventListener("abort", callerAbort, { once: true });
        authority.signal.addEventListener("abort", invalidated, { once: true });
        if (input.signal?.aborted) {
          callerAbort();
          return;
        }
        if (this.#disposed || authority.signal.aborted) {
          invalidated();
          return;
        }
        try {
          // Attach rejection handling immediately; never wait for publish before
          // admitting abort/timeout. A slow outbox cannot extend authorization.
          void Promise.resolve(
            this.#options.publish(
              "approval.requested",
              payload,
              payload.approval_id,
            ),
          ).catch(invalidated);
        } catch {
          invalidated();
        }
      });
      if (input.signal?.aborted) return "cancelled";
      if (
        outcome === "allowed-once" &&
        (this.#disposed ||
          Date.now() >= deliveryDeadline ||
          authority.signal.aborted ||
          !authority.isCurrent())
      )
        return "unavailable";
      return outcome;
    } catch {
      return "unavailable";
    } finally {
      try {
        reservation?.release();
      } catch {
        /* Release failures cannot grant or strand an approval. */
      }
    }
  }

  acceptDecision(message: ApprovalDecisionMessage): "accepted" | "ignored" {
    const parsed = ConnectorServerMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.type !== "approval.decision")
      return "ignored";
    const { payload, expires_at } = parsed.data;
    const waiter = this.#waiters.get(payload.approval_id);
    if (!waiter) return "ignored";
    try {
      if (waiter.signal?.aborted) {
        waiter.settle("cancelled");
        return "ignored";
      }
      if (
        Date.now() >= waiter.deadline ||
        waiter.reservation.signal.aborted ||
        !waiter.reservation.isCurrent()
      ) {
        waiter.settle("unavailable");
        return "ignored";
      }
      const expected = waiter.payload;
      if (
        Date.parse(expires_at) <= Date.now() ||
        payload.job_id !== expected.job_id ||
        payload.attempt !== expected.attempt ||
        payload.job_revision !== expected.job_revision ||
        payload.action_fingerprint !== expected.action_fingerprint
      )
        return "ignored";
      waiter.settle(
        payload.decision === "approve" ? "allowed-once" : "rejected",
        Date.parse(expires_at),
      );
      return "accepted";
    } catch {
      waiter.settle("unavailable");
      return "ignored";
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const waiter of this.#waiters.values()) waiter.settle("unavailable");
  }
}
