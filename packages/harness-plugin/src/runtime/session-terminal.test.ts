import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { sessionTerminalOutcome } from "./session-terminal.js";

const event = (type: string, data: unknown, seq = 7) =>
  ({ type, seq, time: Date.now(), data }) as unknown as SessionEvent;

const jobId = "11111111-1111-4111-8111-111111111111";

describe("sessionTerminalOutcome", () => {
  it("maps a completed turn to a succeeded terminal", () => {
    const result = sessionTerminalOutcome(
      jobId,
      event("turn/end", { reason: { kind: "completed" } }),
    );
    expect(result).toEqual({
      outcome: "succeeded",
      eventSequence: 7,
      projection: { stage: "completed", summary: "Harness task completed" },
    });
  });

  it("maps an error turn to a failed terminal", () => {
    const result = sessionTerminalOutcome(
      jobId,
      event("turn/end", { reason: { kind: "error", error: { code: "X" } } }),
    );
    expect(result?.outcome).toBe("failed");
  });

  it.each([
    event("step/start", undefined),
    event("turn/end", { reason: { kind: "unknown-kind" } }),
    event("turn/end", {}),
  ])("never invents a terminal from a non-terminal event", (input) => {
    const result = sessionTerminalOutcome(jobId, input);
    if (result !== undefined) expect(result.outcome).toBe("failed");
  });

  it("ignores non-terminal lifecycle events", () => {
    expect(
      sessionTerminalOutcome(jobId, event("step/start", undefined)),
    ).toBeUndefined();
  });
});
