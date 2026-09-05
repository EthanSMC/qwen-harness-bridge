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
  it("holds capacity and attempt fences through post-release validation", async () => {
    const f = fixture();
    const original = f.reserve();
    let released = false;
    const nested: Promise<string>[] = [];
    f.reserve.mockReturnValueOnce({
      ...original,
      isCurrent: () => {
        if (released) {
          nested.push(f.broker.request(input));
          nested.push(f.broker.request({ ...input, attempt: 33 }));
        }
        return true;
      },
    });
    f.release.mockImplementationOnce(() => {
      released = true;
    });
    const pending = Array.from({ length: 32 }, (_, i) =>
      f.broker.request({ ...input, attempt: i + 1 }),
    );
    expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
    expect(await pending[0]).toBe("allowed-once");
    expect(await Promise.all(nested)).toEqual(["unavailable", "unavailable"]);
    expect(f.published).toHaveLength(32);
    const next = f.broker.request(input);
    expect(f.published).toHaveLength(33);
    f.broker.dispose();
    await Promise.all([...pending, next]);
    expect(f.release).toHaveBeenCalledTimes(33);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "loss",
    "dispose",
    "abort",
    "stale",
    "original deadline",
    "decision deadline",
    "release throw",
    "validation throw",
    "validation abort",
  ])("finalizes after cleanup-time %s and frees admission", async (cause) => {
    const f = fixture();
    const caller = new AbortController();
    const original = f.reserve();
    let released = false;
    f.reserve.mockReturnValue({
      ...original,
      isCurrent: () => {
        if (released && cause === "validation throw")
          throw new Error("lost authority");
        if (released && cause === "validation abort") caller.abort();
        return original.isCurrent();
      },
    });
    f.release.mockImplementationOnce(() => {
      released = true;
      if (cause === "loss") f.invalidation.abort();
      if (cause === "dispose") f.broker.dispose();
      if (cause === "abort") caller.abort();
      if (cause === "stale") f.stale();
      if (cause === "original deadline") vi.setSystemTime(Date.now() + 60_000);
      if (cause === "decision deadline") vi.setSystemTime(Date.now() + 1_000);
      if (cause === "release throw") throw new Error("cleanup failed");
    });
    const pending = f.broker.request({ ...input, signal: caller.signal });
    const decision = f.decision();
    decision.expires_at = new Date(
      Date.now() + (cause === "decision deadline" ? 1_000 : 120_000),
    ).toISOString();
    expect(f.broker.acceptDecision(decision)).toBe("accepted");
    expect(await pending).toBe(
      cause === "abort" || cause === "validation abort"
        ? "cancelled"
        : "unavailable",
    );
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (cause !== "dispose") {
      f.reserve.mockReturnValue({
        ...original,
        deadline: Date.now() + 60_000,
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      const next = f.broker.request(input);
      expect(f.published).toHaveLength(2);
      f.broker.dispose();
      expect(await next).toBe("unavailable");
      expect(f.release).toHaveBeenCalledTimes(2);
    }
  });
  it("admits another job only with its own valid reservation", async () => {
    const f = fixture();
    const first = f.broker.request(input);
    const other = { ...input, jobId: randomUUID() };
    const reservation = f.reserve();
    f.reserve.mockReturnValueOnce({ ...reservation, isCurrent: () => false });
    expect(await f.broker.request(other)).toBe("unavailable");
    expect(f.published).toHaveLength(1);
    const second = f.broker.request(other);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].job_id).toBe(other.jobId);
    f.broker.dispose();
    expect(await Promise.all([first, second])).toEqual([
      "unavailable",
      "unavailable",
    ]);
    expect(f.release).toHaveBeenCalledTimes(3);
  });
  it.each([
    "invalid input",
    "invalid reservation",
    "missing",
    "reserve throw",
    "abort",
    "timeout",
    "reject",
    "loss",
    "stale",
    "publish throw",
    "publish reject",
    "release throw",
  ])("releases admission exactly once after %s", async (cause) => {
    const f = fixture();
    const original = f.reserve();
    const abort = new AbortController();
    if (cause === "invalid reservation")
      f.reserve.mockReturnValueOnce({ ...original, approvalTimeoutSeconds: 0 });
    if (cause === "missing")
      f.reserve.mockReturnValueOnce(undefined as unknown as typeof original);
    if (cause === "reserve throw")
      f.reserve.mockImplementationOnce(() => {
        throw new Error("offline");
      });
    if (cause === "publish throw")
      f.publish.mockImplementationOnce(() => {
        throw new Error("offline");
      });
    if (cause === "publish reject")
      f.publish.mockRejectedValueOnce(new Error("offline"));
    if (cause === "release throw")
      f.release.mockImplementationOnce(() => {
        throw new Error("offline");
      });
    const first = f.broker.request({
      ...input,
      signal: abort.signal,
      fingerprint: cause === "invalid input" ? "bad" : input.fingerprint,
    });
    if (cause === "abort") abort.abort();
    if (cause === "timeout") await vi.advanceTimersByTimeAsync(60_000);
    if (cause === "loss") f.invalidation.abort();
    if (cause === "stale") {
      f.stale();
      f.broker.acceptDecision(f.decision());
    }
    if (cause === "reject" || cause === "release throw") {
      const decision = f.decision();
      decision.payload.decision = "reject";
      f.broker.acceptDecision(decision);
    }
    expect(await first).toBe(
      cause === "abort"
        ? "cancelled"
        : cause === "reject" || cause === "release throw"
          ? "rejected"
          : "unavailable",
    );
    expect(f.release).toHaveBeenCalledTimes(
      cause === "missing" || cause === "reserve throw" ? 0 : 1,
    );
    expect(vi.getTimerCount()).toBe(0);
    const releases = f.release.mock.calls.length;
    f.reserve.mockReturnValue({
      ...original,
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    const count = f.published.length;
    const next = f.broker.request(input);
    expect(f.published).toHaveLength(count + 1);
    f.broker.dispose();
    expect(await next).toBe("unavailable");
    expect(f.release).toHaveBeenCalledTimes(releases + 1);
  });
  it.each(["throw", "abort"])(
    "cleans a waiter after listener registration %s without publishing",
    async (cause) => {
      const f = fixture();
      const signal = f.invalidation.signal;
      const add = signal.addEventListener.bind(signal);
      vi.spyOn(signal, "addEventListener").mockImplementationOnce(
        (type, listener, options) => {
          add(type, listener, options);
          if (cause === "throw") throw new Error("listener setup failed");
          f.invalidation.abort();
        },
      );
      expect(await f.broker.request(input)).toBe("unavailable");
      expect(f.published).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.release).toHaveBeenCalledTimes(1);
      f.broker.dispose();
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps reentrant listener cleanup fenced and resolves despite removal error", async () => {
    const f = fixture();
    const signal = f.invalidation.signal;
    const remove = signal.removeEventListener.bind(signal);
    let nested: Promise<string> | undefined;
    vi.spyOn(signal, "removeEventListener").mockImplementationOnce(
      (type, listener, options) => {
        remove(type, listener, options);
        nested = f.broker.request(input);
        throw new Error("cleanup failed");
      },
    );
    const pending = f.broker.request(input);
    f.broker.acceptDecision(f.decision());
    expect(vi.getTimerCount()).toBe(0);
    expect(f.published).toHaveLength(1);
    expect(await nested).toBe("unavailable");
    expect(await pending).toBe("unavailable");
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("late failed publication cannot release a replacement admission", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.publish.mockImplementationOnce((_type, payload) => {
      f.published.push(payload);
      return new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    });
    const first = f.broker.request(input);
    f.broker.acceptDecision(f.decision());
    expect(await first).toBe("allowed-once");
    const next = f.broker.request(input);
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(await f.broker.request(input)).toBe("unavailable");
    expect(f.published).toHaveLength(2);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.broker.dispose();
    await next;
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("admits 32 lifetimes and rejects capacity+1 through accepted delivery", async () => {
    const f = fixture();
    const pending = Array.from({ length: 32 }, (_, i) =>
      f.broker.request({ ...input, attempt: i + 1 }),
    );
    const excess = f.broker.request({ ...input, attempt: 33 });
    expect(f.published).toHaveLength(32);
    expect(await excess).toBe("unavailable");
    expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
    const overlap = f.broker.request({ ...input, attempt: 33 });
    expect(f.published).toHaveLength(32);
    expect(await overlap).toBe("unavailable");
    expect(await pending[0]).toBe("allowed-once");
    const replacement = f.broker.request({ ...input, attempt: 33 });
    expect(f.published).toHaveLength(33);
    f.broker.dispose();
    await Promise.all([...pending, replacement]);
    expect(f.release).toHaveBeenCalledTimes(33);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects same-attempt overlap until accepted delivery and cleanup finish", async () => {
    const f = fixture();
    const first = f.broker.request(input);
    const duplicate = f.broker.request(input);
    expect(f.published).toHaveLength(1);
    expect(await duplicate).toBe("unavailable");
    expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
    const delivering = f.broker.request(input);
    expect(f.published).toHaveLength(1);
    expect(await delivering).toBe("unavailable");
    expect(await first).toBe("allowed-once");
    const next = f.broker.request(input);
    expect(f.published).toHaveLength(2);
    f.broker.dispose();
    expect(await next).toBe("unavailable");
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it.each(["reserve", "publish", "release"])(
    "holds the attempt slot during reentrant %s",
    async (phase) => {
      const f = fixture();
      let nested: Promise<string> | undefined;
      const reenter = () => {
        nested = f.broker.request(input);
      };
      if (phase === "reserve") {
        const reservation = f.reserve();
        f.reserve.mockImplementationOnce(() => {
          reenter();
          return reservation;
        });
      }
      if (phase === "publish")
        f.publish.mockImplementationOnce((_type, payload) => {
          f.published.push(payload);
          reenter();
          return Promise.resolve();
        });
      if (phase === "release") f.release.mockImplementationOnce(reenter);
      const first = f.broker.request(input);
      if (phase !== "release") expect(f.published).toHaveLength(1);
      expect(f.broker.acceptDecision(f.decision())).toBe("accepted");
      expect(await first).toBe("allowed-once");
      expect(f.published).toHaveLength(1);
      expect(await nested).toBe("unavailable");
      expect(f.published).toHaveLength(1);
      const next = f.broker.request(input);
      expect(f.published).toHaveLength(2);
      f.broker.dispose();
      await next;
    },
  );
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
