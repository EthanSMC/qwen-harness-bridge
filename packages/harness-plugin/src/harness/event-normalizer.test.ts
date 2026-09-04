import { type SessionEvent, SessionSeq } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import {
  type NormalizationOptions,
  normalizeSessionEvent,
} from "./event-normalizer.js";

const event = (
  type: SessionEvent["type"],
  data: unknown,
  seq = 0,
): SessionEvent =>
  ({
    type,
    data,
    seq: SessionSeq(seq),
    time: 1_725_000_000_000,
  }) as SessionEvent;

const normalize = (input: SessionEvent, options?: NormalizationOptions) =>
  normalizeSessionEvent("job-1", input, options);

describe("Harness session event normalizer", () => {
  it.each([
    ["turn/start", "stage.changed", "planning"],
    ["step/start", "stage.changed", "executing"],
    ["step/end", "progress.updated", "executing"],
    ["tool/call", "tool.started", "tool"],
    ["tool/result", "tool.finished", "tool"],
    ["assistant/message", "progress.updated", "executing"],
  ] as const)(
    "maps %s to a bounded %s event",
    (type, normalizedType, stage) => {
      const data =
        type === "turn/start"
          ? { turn: 1 }
          : type === "step/start" || type === "step/end"
            ? { turn: 1, step: 1 }
            : type === "tool/call"
              ? {
                  turn: 1,
                  step: 1,
                  callId: "call-1",
                  name: "search",
                  arguments: "{}",
                }
              : type === "tool/result"
                ? { turn: 1, step: 1, message: { content: [] } }
                : {
                    turn: 1,
                    step: 1,
                    message: { content: [{ type: "text", text: "private" }] },
                  };

      expect(normalize(event(type, data))).toMatchObject({
        jobId: "job-1",
        type: normalizedType,
        stage,
        occurredAt: "2024-08-30T06:40:00.000Z",
      });
    },
  );

  it("drops reasoning, raw text, raw tool arguments, absolute paths, and error bodies", () => {
    const reasoning = normalize(
      event("assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "reasoning", text: "SECRET_REASONING" },
      }),
    );
    const text = normalize(
      event("assistant/message", {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "text", text: "SECRET_RESULT /Users/ethan/private" },
          ],
        },
      }),
    );
    const tool = normalize(
      event("tool/call", {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "/Users/ethan/bin/private-tool",
        arguments: '{"token":"SECRET_TOKEN","path":"/Users/ethan/private"}',
      }),
    );
    const failure = normalize(
      event("turn/end", {
        turn: 1,
        reason: {
          kind: "error",
          error: {
            code: "E_PRIVATE",
            message: "SECRET_RESULT /Users/ethan/private",
          },
        },
      }),
      { terminalReady: true },
    );
    const unsafeFailure = normalize(
      event("turn/end", {
        turn: 1,
        reason: {
          kind: "error",
          error: { code: "provider response SECRET_TOKEN" },
        },
      }),
      { terminalReady: true },
    );

    expect(reasoning).toBeUndefined();
    expect(text?.summary).not.toMatch(/SECRET_RESULT|\/Users\/ethan\/private/);
    expect(tool?.summary).not.toMatch(/SECRET_TOKEN|\/Users\/ethan\/private/);
    expect(failure).toMatchObject({ type: "job.failed", summary: "E_PRIVATE" });
    expect(unsafeFailure?.summary).toBe("HARNESS_TURN_FAILED");
    expect(JSON.stringify([text, tool, failure])).not.toMatch(
      /SECRET_REASONING|SECRET_RESULT|SECRET_TOKEN|\/Users\/ethan\/private/,
    );
  });

  it("normalizes a committed terminal turn reason into a terminal candidate", () => {
    const terminal = event("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });

    expect(normalize(terminal)).toMatchObject({
      type: "job.succeeded",
      stage: "completed",
      summary: "Harness task completed",
    });
    expect(normalize(terminal, { terminalReady: true })).toMatchObject({
      type: "job.succeeded",
      stage: "completed",
      summary: "Harness task completed",
    });
  });

  it("fails closed for an unknown structurally valid terminal reason", () => {
    const terminal = normalize(
      event("turn/end", {
        turn: 1,
        reason: {
          kind: "plugin-terminal-reason",
          private: "do not export",
        },
      }),
    );

    expect(terminal).toMatchObject({
      type: "job.failed",
      stage: "failed",
      summary: "HARNESS_TURN_FAILED",
    });
    expect(JSON.stringify(terminal)).not.toContain("do not export");
  });

  it("bounds summaries and ignores unknown or seed-only events", () => {
    const unknown = normalize(
      event("future/event" as SessionEvent["type"], {
        message: "do not forward",
      }),
    );
    const seed = normalize(event("session/end-seed", {}));
    const result = normalize(
      event("tool/result", {
        turn: 1,
        step: 1,
        message: { content: [] },
        meta: { huge: "x".repeat(10_000) },
      }),
    );

    expect(unknown).toBeUndefined();
    expect(seed).toBeUndefined();
    expect(result?.summary.length).toBeLessThanOrEqual(240);
  });

  it("fails closed on a malformed terminal event", () => {
    expect(() => normalize(event("turn/end", undefined))).not.toThrow();
    expect(normalize(event("turn/end", undefined))).toBeUndefined();
  });
});
