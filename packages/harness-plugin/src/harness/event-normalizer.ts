import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { NormalizedHarnessEvent } from "./types.js";

export type NormalizationOptions = Readonly<{
  terminalReady?: boolean;
}>;

const MAX_SUMMARY_LENGTH = 240;

const boundedSummary = (summary: string): string =>
  Array.from(summary, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .slice(0, MAX_SUMMARY_LENGTH);

const safeErrorCode = (value: unknown): string => {
  if (typeof value !== "string") return "HARNESS_TURN_FAILED";
  const code = value
    .replace(/(?:[A-Za-z]:)?[\\/][^\s]*/gu, "PATH")
    .slice(0, 80);
  return /^[A-Za-z0-9_.:-]+$/u.test(code) ? code : "HARNESS_TURN_FAILED";
};

const occurredAt = (event: SessionEvent): string => {
  const date = new Date(typeof event.time === "number" ? event.time : NaN);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
};

const output = (
  jobId: string,
  event: SessionEvent,
  type: NormalizedHarnessEvent["type"],
  stage: string,
  summary: string,
): NormalizedHarnessEvent => ({
  jobId,
  type,
  stage,
  summary: boundedSummary(summary),
  occurredAt: occurredAt(event),
});

const terminalFor = (
  jobId: string,
  event: SessionEvent,
): NormalizedHarnessEvent | undefined => {
  if (event.type !== "turn/end") return undefined;

  const data = event.data as unknown;
  if (data === null || typeof data !== "object" || !("reason" in data)) {
    return undefined;
  }
  const reason = data.reason;
  if (
    reason === null ||
    typeof reason !== "object" ||
    !("kind" in reason) ||
    typeof reason.kind !== "string"
  ) {
    return undefined;
  }

  switch (reason.kind) {
    case "completed":
      return output(
        jobId,
        event,
        "job.succeeded",
        "completed",
        "Harness task completed",
      );
    case "error": {
      const errorValue = "error" in reason ? reason.error : undefined;
      const errorCode =
        errorValue !== null &&
        typeof errorValue === "object" &&
        errorValue !== undefined &&
        "code" in errorValue
          ? errorValue.code
          : undefined;
      return output(
        jobId,
        event,
        "job.failed",
        "failed",
        safeErrorCode(errorCode),
      );
    }
    case "aborted":
      return output(
        jobId,
        event,
        "job.failed",
        "failed",
        "Harness task cancelled",
      );
    case "blocked":
      return output(
        jobId,
        event,
        "job.failed",
        "failed",
        "Harness task blocked",
      );
    case "max-tokens":
      return output(
        jobId,
        event,
        "job.failed",
        "failed",
        "Harness task reached output limit",
      );
    case "interrupted":
      return output(
        jobId,
        event,
        "job.failed",
        "failed",
        "HARNESS_SESSION_LOST",
      );
    default:
      return undefined;
  }
};

export const normalizeTerminalEvent = (
  jobId: string,
  event: SessionEvent,
): NormalizedHarnessEvent | undefined => terminalFor(jobId, event);

export const normalizeSessionEvent = (
  jobId: string,
  event: SessionEvent,
  _options: NormalizationOptions = {},
): NormalizedHarnessEvent | undefined => {
  if (event.type === "turn/end") {
    return terminalFor(jobId, event);
  }

  switch (event.type) {
    case "turn/start":
      return output(
        jobId,
        event,
        "stage.changed",
        "planning",
        "Harness turn started",
      );
    case "step/start":
      return output(
        jobId,
        event,
        "stage.changed",
        "executing",
        "Harness step started",
      );
    case "step/end":
      return output(
        jobId,
        event,
        "progress.updated",
        "executing",
        "Harness step completed",
      );
    case "tool/call":
      return output(
        jobId,
        event,
        "tool.started",
        "tool",
        "Harness tool started",
      );
    case "tool/result":
      return output(
        jobId,
        event,
        "tool.finished",
        "tool",
        "Harness tool finished",
      );
    case "assistant/message":
      return output(
        jobId,
        event,
        "progress.updated",
        "executing",
        "Assistant response committed",
      );
    default:
      return undefined;
  }
};

export { MAX_SUMMARY_LENGTH };
