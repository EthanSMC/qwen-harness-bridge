import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecisionMessage,
  RemoteApprovalBroker,
} from "./approval-broker.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input = {
  jobId,
  attempt: 1,
  fingerprint: `sha256:${"a".repeat(64)}`,
  actionSummary: "Delete generated output",
  impactSummary: "Generated output is removed",
  riskClass: "approval_required",
};
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  const invalidation = new AbortController();
  let current = true;
  const published: Record<string, unknown>[] = [];
  const release = vi.fn();
  const reserve = vi.fn(() => ({
    requestedRevision: 8,
    deadline: Date.now() + 120_000,
    approvalTimeoutSeconds: 60,
    signal: invalidation.signal,
    isCurrent: () => current,
    release,
  }));
  const publish = vi.fn((_type: string, payload: Record<string, unknown>) => {
    published.push(payload);
    return Promise.resolve();
  });
  const broker = new RemoteApprovalBroker({ reserve, publish });
  const decision = (): ApprovalDecisionMessage => ({
    protocol_version: "1.0",
    message_id: randomUUID(),
    sequence: 1,
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    correlation_id: randomUUID(),
    type: "approval.decision",
    payload: {
      approval_id: String(published[0].approval_id),
      job_id: jobId,
      attempt: 1,
      job_revision: 8,
      action_fingerprint: input.fingerprint,
      decision: "approve",
    },
  });
  return {
    broker,
    published,
    decision,
    invalidation,
    reserve,
    release,
    publish,
    stale: () => {
      current = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("remote approval broker (deterministic authority and transport ports)", () => {
  it("does not deliver a grant after its decision envelope expires", async () => {
    const f = fixture();
    const pending = f.broker.request(input);
    const message = f.decision();
    message.expires_at = new Date(Date.now() + 1).toISOString();
    expect(f.broker.acceptDecision(message)).toBe("accepted");
    vi.setSystemTime(Date.now() + 2);
    expect(await pending).toBe("unavailable");
  });
  it.each([0, 59, 1801, NaN])(
    "rejects repository timeout %s",
    async (approvalTimeoutSeconds) => {
      const f = fixture();
      const reservation = f.reserve();
      f.reserve.mockReturnValue({ ...reservation, approvalTimeoutSeconds });
      expect(await f.broker.request(input)).toBe("unavailable");
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["reject", "throw"])(
    "contains publish %s and cleans resources",
    async (kind) => {
      const f = fixture();
      f.publish.mockImplementation(() => {
        if (kind === "throw") throw new Error("unavailable");
        return Promise.reject(new Error("unavailable"));
      });
      expect(await f.broker.request(input)).toBe("unavailable");
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not publish after prior abort, loss, disposal or missing authority", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.broker.request({ ...input, signal: controller.signal }),
    ).toBe("cancelled");
    f.invalidation.abort();
    expect(await f.broker.request(input)).toBe("unavailable");
    f.broker.dispose();
    expect(await f.broker.request(input)).toBe("unavailable");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["loss", "deadline", "abort"])(
    "rechecks %s before delivering an accepted grant",
    async (cause) => {
      const f = fixture();
      const controller = new AbortController();
      const pending = f.broker.request({ ...input, signal: controller.signal });
      expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
      if (cause === "loss") f.invalidation.abort();
      if (cause === "deadline") vi.setSystemTime(Date.now() + 60_000);
      if (cause === "abort") controller.abort();
      expect(await pending).toBe(
        cause === "abort" ? "cancelled" : "unavailable",
      );
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["approve", "allowed-once"],
    ["reject", "rejected"],
  ] as const)(
    "consumes one matching %s decision",
    async (decision, outcome) => {
      const f = fixture();
      const pending = f.broker.request(input);
      expect(f.published[0]).toMatchObject({
        job_revision: 8,
        expires_at: "2026-09-01T00:01:00.000Z",
        action_fingerprint: input.fingerprint,
      });
      const message = f.decision();
      message.payload.decision = decision;
      expect(f.broker.acceptDecision(message)).toBe("accepted");
      expect(f.broker.acceptDecision(message)).toBe("ignored");
      expect(await pending).toBe(outcome);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([
    "approval_id",
    "job_id",
    "attempt",
    "job_revision",
    "action_fingerprint",
  ] as const)("does not consume a decision with wrong %s", async (field) => {
    const f = fixture();
    const pending = f.broker.request(input);
    const message = f.decision();
    Object.assign(message.payload, {
      [field]:
        field === "attempt" || field === "job_revision"
          ? 99
          : field === "action_fingerprint"
            ? `sha256:${"b".repeat(64)}`
            : randomUUID(),
    });
    expect(f.broker.acceptDecision(message)).toBe("ignored");
    expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
    expect(await pending).toBe("allowed-once");
  });
  it("rejects malformed and expired envelopes without releasing the waiter", async () => {
    const f = fixture();
    const pending = f.broker.request(input);
    const expired = f.decision();
    expired.expires_at = new Date().toISOString();
    expect(f.broker.acceptDecision(expired)).toBe("ignored");
    expect(
      f.broker.acceptDecision({
        ...f.decision(),
        protocol_version: "9.0",
      } as unknown as ApprovalDecisionMessage),
    ).toBe("ignored");
    f.broker.dispose();
    expect(await pending).toBe("unavailable");
  });
  it.each(["timeout", "loss", "abort", "dispose", "stale"])(
    "settles on %s and ignores late approval",
    async (cause) => {
      const f = fixture();
      const abort = new AbortController();
      const pending = f.broker.request({ ...input, signal: abort.signal });
      const message = f.decision();
      if (cause === "timeout") await vi.advanceTimersByTimeAsync(60_000);
      if (cause === "loss") f.invalidation.abort();
      if (cause === "abort") abort.abort();
      if (cause === "dispose") f.broker.dispose();
      if (cause === "stale") f.stale();
      expect(f.broker.acceptDecision(message)).toBe("ignored");
      expect(await pending).toBe(
        cause === "abort" ? "cancelled" : "unavailable",
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds a stuck publish and contains its later rejection", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.publish.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = f.broker.request(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBe("unavailable");
    reject(new Error("delivery failed"));
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("fails closed on denied, invalid metadata, unavailable authority and invalid timeout", async () => {
    const f = fixture();
    expect(await f.broker.request({ ...input, riskClass: "denied" })).toBe(
      "rejected",
    );
    expect(await f.broker.request({ ...input, fingerprint: "bad" })).toBe(
      "unavailable",
    );
    f.reserve.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(await f.broker.request(input)).toBe("unavailable");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("uses the shorter authoritative deadline", async () => {
    const f = fixture();
    const original = f.reserve();
    f.reserve.mockReturnValue({ ...original, deadline: Date.now() + 1_000 });
    const pending = f.broker.request(input);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
