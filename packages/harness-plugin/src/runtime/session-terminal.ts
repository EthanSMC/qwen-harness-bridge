import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { normalizeTerminalEvent } from "../harness/event-normalizer.js";

export type SessionTerminalOutcome = Readonly<{
  outcome: "succeeded" | "failed";
  eventSequence: number;
  projection: Readonly<{ stage: string; summary: string }>;
}>;

/** Pure projection of one owned session event into the driver terminal input.
 * Non-terminal events and unrelated session logs return undefined, so the
 * driver never invents a terminal from an arbitrary event. */
export function sessionTerminalOutcome(
  jobId: string,
  event: SessionEvent,
): SessionTerminalOutcome | undefined {
  try {
    const normalized = normalizeTerminalEvent(jobId, event);
    if (normalized === undefined) return undefined;
    return Object.freeze({
      outcome: normalized.type === "job.succeeded" ? "succeeded" : "failed",
      eventSequence: Number(event.seq),
      projection: Object.freeze({
        stage: normalized.stage,
        summary: normalized.summary,
      }),
    });
  } catch {
    return undefined;
  }
}
