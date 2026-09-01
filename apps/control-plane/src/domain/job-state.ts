import type { JobStatus } from "@qhb/protocol";

const transitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["dispatched", "cancelled", "expired"]),
  dispatched: new Set(["running", "cancelled", "expired"]),
  running: new Set([
    "waiting_approval",
    "cancelling",
    "succeeded",
    "failed",
    "expired",
  ]),
  waiting_approval: new Set(["running", "cancelling", "failed", "expired"]),
  cancelling: new Set(["cancelled", "succeeded", "failed", "expired"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export const TERMINAL_JOB_STATES = new Set<JobStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  transitions[from]?.has(to) ?? false;

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`INVALID_JOB_TRANSITION:${from}:${to}`);
  }
}
