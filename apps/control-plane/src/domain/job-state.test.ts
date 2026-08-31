import type { JobStatus } from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  TERMINAL_JOB_STATES,
} from "./job-state.js";

describe("job state machine", () => {
  it("permits the approved lifecycle", () => {
    expect(canTransition("queued", "dispatched")).toBe(true);
    expect(canTransition("running", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
    expect(canTransition("cancelling", "succeeded")).toBe(true);
  });

  it("keeps terminal states immutable", () => {
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(() => assertTransition("cancelled", "running")).toThrow(
      "INVALID_JOB_TRANSITION",
    );
    expect(TERMINAL_JOB_STATES).toEqual(
      new Set(["succeeded", "failed", "cancelled", "expired"]),
    );
  });

  it("matches the exact public transition table", () => {
    const allowed: Record<JobStatus, readonly JobStatus[]> = {
      queued: ["dispatched", "cancelled", "expired"],
      dispatched: ["running", "cancelled", "expired"],
      running: [
        "waiting_approval",
        "cancelling",
        "succeeded",
        "failed",
        "expired",
      ],
      waiting_approval: ["running", "cancelling", "failed", "expired"],
      cancelling: ["cancelled", "succeeded", "failed", "expired"],
      succeeded: [],
      failed: [],
      cancelled: [],
      expired: [],
    };

    for (const from of Object.keys(allowed) as JobStatus[]) {
      for (const to of Object.keys(allowed) as JobStatus[]) {
        expect(canTransition(from, to)).toBe(allowed[from].includes(to));
      }
    }
  });

  it("reports the complete invalid transition in its stable error", () => {
    expect(() => assertTransition("queued", "running")).toThrow(
      "INVALID_JOB_TRANSITION:queued:running",
    );
  });
});
