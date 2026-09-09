import { randomUUID } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it, vi } from "vitest";
import { RemoteApprovalBroker } from "../approvals/approval-broker.js";
import {
  CancelHandler,
  type CancellationOwner,
  type JobCancelMessage,
} from "./cancel-handler.js";

function fixture(beforeCancel?: (owner: CancellationOwner) => undefined) {
  const command: JobCancelMessage = {
    protocol_version: "1.0",
    message_id: randomUUID(),
    sequence: 1,
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    correlation_id: randomUUID(),
    type: "job.cancel",
    payload: {
      job_id: randomUUID(),
      attempt: 1,
      job_revision: 8,
      nonce: randomUUID(),
      reason: "user",
    },
  };
  let idle!: () => void;
  const quiescence = new Promise<void>((resolve) => {
    idle = resolve;
  });
  const approval = new AbortController();
  const cancel = vi.fn();
  // Typed boundary fixture, not a real Agent driver. The shared terminal port
  // models one atomic coordinator sink used by both completion and cancellation.
  const agent = {
    status: "running",
    cancel,
    whenIdle: () => quiescence,
  } as unknown as Agent;
  let terminal: string | undefined;
  const events: string[] = [];
  let current = true;
  const owner: CancellationOwner = {
    jobId: command.payload.job_id,
    attempt: 1,
    revision: 8,
    hasTerminal: () => terminal !== undefined,
    agent,
    approval,
    isCurrent: () => current,
    drainTerminals: async () => {},
    commitCancelled: () => {
      if (terminal) return false;
      terminal = "job.cancelled";
      events.push(terminal);
      return true;
    },
  };
  const resolveOwner = vi.fn((_command: JobCancelMessage) => owner);
  const options = { resolveOwner, beforeCancel };
  const handler = new CancelHandler(options);
  return {
    command,
    handler,
    agent,
    owner,
    cancel,
    approval,
    events,
    resolveOwner,
    idle,
    stale: () => {
      current = false;
    },
    complete: (value: string) => {
      if (!terminal) {
        terminal = value;
        events.push(value);
      }
    },
  };
}
describe("cancellation with a typed Agent boundary and shared terminal sink", () => {
  it("keeps the original command identity when the hook mutates the resolved command and owner", async () => {
    let resolved!: JobCancelMessage;
    const f = fixture(() => {
      resolved.payload.job_revision++;
      Object.assign(f.owner, { revision: resolved.payload.job_revision });
      return undefined;
    });
    f.resolveOwner.mockImplementation((command) => {
      resolved = command;
      return f.owner;
    });
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("ignored");
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.approval.signal.aborted).toBe(false);
    expect(f.events).toEqual([]);
  });
  it("rejects a returned reentrant task without a dependency cycle", async () => {
    let nested: Promise<string> | undefined;
    const hook = () => {
      nested = f.handler.handle(f.command);
      return nested;
    };
    const f = fixture(
      hook as unknown as (owner: CancellationOwner) => undefined,
    );
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    expect(await nested).toBe("unavailable");
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.approval.signal.aborted).toBe(false);
    expect(f.events).toEqual([]);
  });
  it("runs the fence once before effects and joins synchronous reentry through drain", async () => {
    const order: string[] = [];
    let nested: Promise<string> | undefined;
    const hook = vi.fn(() => {
      order.push("fence");
      nested = f.handler.handle(f.command);
      return undefined;
    });
    const f = fixture(hook);
    f.cancel.mockImplementation(() => {
      order.push("cancel");
    });
    f.approval.signal.addEventListener("abort", () => {
      order.push("abort");
    });
    let drain!: () => void;
    f.owner.drainTerminals = () =>
      new Promise<void>((resolve) => {
        drain = resolve;
      });
    const pending = f.handler.handle(f.command);
    expect(order).toEqual(["fence", "cancel", "abort"]);
    expect(hook).toHaveBeenCalledExactlyOnceWith(f.owner);
    expect(f.events).toEqual([]);
    f.idle();
    await Promise.resolve();
    expect(f.events).toEqual([]);
    drain();
    expect(await pending).toBe("cancelled");
    expect(await nested).toBe("cancelled");
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["job.cancelled"]);
  });
  it.each([
    "revoked",
    "expired",
    "job",
    "attempt",
    "revision",
    "agent",
    "idle",
    "success",
    "failure",
  ])("rechecks %s after the fence without arming an effect", async (cause) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const replacementCancel = vi.fn();
    const f = fixture(() => {
      if (cause === "revoked") f.stale();
      if (cause === "expired") clock.mockReturnValue(now + 61_000);
      if (cause === "job") Object.assign(f.owner, { jobId: randomUUID() });
      if (cause === "attempt") Object.assign(f.owner, { attempt: 2 });
      if (cause === "revision") Object.assign(f.owner, { revision: 9 });
      if (cause === "agent")
        Object.assign(f.owner, {
          agent: { ...f.agent, cancel: replacementCancel },
        });
      if (cause === "idle") Object.assign(f.agent, { status: "idle" });
      if (cause === "success") f.complete("job.succeeded");
      if (cause === "failure") f.complete("job.failed");
      return undefined;
    });
    try {
      f.idle();
      const terminal = cause === "success" || cause === "failure";
      expect(await f.handler.handle(f.command)).toBe(
        terminal ? "terminal" : "ignored",
      );
      Object.assign(f.agent, { status: "running" });
      await Promise.resolve();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(replacementCancel).not.toHaveBeenCalled();
      expect(f.approval.signal.aborted).toBe(false);
      expect(f.events).toEqual(
        terminal ? [cause === "success" ? "job.succeeded" : "job.failed"] : [],
      );
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    "throw",
    "data",
    "resolved",
    "rejected",
    "pending",
    "current throws",
    "terminal throws",
    "status throws",
  ])(
    "sanitizes %s fence failure without effects or late permission",
    async (cause) => {
      let complete!: () => void;
      const hook = () => {
        if (cause === "throw") throw new Error("private dependency payload");
        if (cause === "data") return false;
        if (cause === "resolved") return Promise.resolve();
        if (cause === "rejected")
          return Promise.reject(new Error("private dependency payload"));
        if (cause === "pending")
          return new Promise<void>((resolve) => {
            complete = resolve;
          });
        if (cause === "current throws")
          f.owner.isCurrent = () => {
            throw new Error("private dependency payload");
          };
        if (cause === "terminal throws")
          f.owner.hasTerminal = () => {
            throw new Error("private dependency payload");
          };
        if (cause === "status throws")
          Object.defineProperty(f.agent, "status", {
            get() {
              throw new Error("private dependency payload");
            },
          });
        return undefined;
      };
      // Deliberately violate the trusted synchronous contract at runtime.
      const f = fixture(hook as (owner: CancellationOwner) => undefined);
      f.idle();
      expect(await f.handler.handle(f.command)).toBe("unavailable");
      complete?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.approval.signal.aborted).toBe(false);
      expect(f.events).toEqual([]);
    },
  );
  it("retries a failed fence, then skips it on issued cancellation persistence retry", async () => {
    const hook = vi
      .fn((): undefined => undefined)
      .mockImplementationOnce(() => {
        throw new Error("private hook payload");
      });
    const f = fixture(hook);
    const commit = vi.fn(f.owner.commitCancelled).mockImplementationOnce(() => {
      throw new Error("private storage payload");
    });
    const abort = vi.spyOn(f.approval, "abort");
    f.owner.commitCancelled = commit;
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.approval.signal.aborted).toBe(false);
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    Object.assign(f.agent, { status: "idle" });
    expect(await f.handler.handle(f.command)).toBe("cancelled");
    expect(hook).toHaveBeenCalledTimes(2);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(["job.cancelled"]);
  });
  it("does not retry a failed fence after revocation", async () => {
    const hook = vi.fn((): undefined => {
      f.stale();
      throw new Error("private payload");
    });
    const f = fixture(hook);
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    expect(await f.handler.handle(f.command)).toBe("ignored");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.approval.signal.aborted).toBe(false);
    expect(f.events).toEqual([]);
  });
  it("does not persist an expired command after drain, but accepts a fresh retry", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      f.owner.drainTerminals = async () => {
        clock.mockReturnValue(now + 61_000);
      };
      f.idle();
      expect(await f.handler.handle(f.command)).toBe("ignored");
      expect(f.events).toEqual([]);
      Object.assign(f.agent, { status: "idle" });
      f.command.expires_at = new Date(now + 120_000).toISOString();
      expect(await f.handler.handle(f.command)).toBe("cancelled");
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual(["job.cancelled"]);
    } finally {
      clock.mockRestore();
    }
  });
  it("never repeats an ambiguous throwing cancel, but observes a later terminal", async () => {
    const f = fixture();
    f.cancel.mockImplementationOnce(() => {
      throw new Error("ambiguous effect");
    });
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    Object.assign(f.agent, { status: "idle" });
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
    f.complete("job.failed");
    expect(await f.handler.handle(f.command)).toBe("terminal");
  });
  it("coalesces synchronous reentrant cancellation effects", async () => {
    const f = fixture();
    let nested: Promise<string> | undefined;
    f.cancel.mockImplementationOnce(() => {
      nested = f.handler.handle(f.command);
    });
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("cancelled");
    expect(await nested).toBe("cancelled");
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["job.cancelled"]);
  });
  it.each(["commit", "drain", "idle"])(
    "retries transient %s failure on the same idle owner once",
    async (phase) => {
      const f = fixture();
      const commit = f.owner.commitCancelled;
      const commits = vi.fn(commit);
      f.owner.commitCancelled = commits;
      if (phase === "commit")
        commits.mockImplementationOnce(() => {
          throw new Error("offline");
        });
      if (phase === "drain")
        f.owner.drainTerminals = vi
          .fn()
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValue(undefined);
      if (phase === "idle")
        Object.assign(f.agent, {
          whenIdle: vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue(undefined),
        });
      const first = f.handler.handle(f.command);
      Object.assign(f.agent, { status: "idle" });
      f.idle();
      expect(await first).toBe("unavailable");
      expect(f.events).toEqual([]);
      expect(
        await Promise.all([
          f.handler.handle(f.command),
          f.handler.handle(f.command),
        ]),
      ).toEqual(["cancelled", "cancelled"]);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(commits).toHaveBeenCalledTimes(phase === "commit" ? 2 : 1);
      expect(f.events).toEqual(["job.cancelled"]);
    },
  );
  it.each(["job.succeeded", "job.failed"])(
    "observes later %s after persistence failure",
    async (terminal) => {
      const f = fixture();
      f.owner.commitCancelled = vi.fn(() => {
        throw new Error("offline");
      });
      f.idle();
      expect(await f.handler.handle(f.command)).toBe("unavailable");
      f.complete(terminal);
      expect(await f.handler.handle(f.command)).toBe("terminal");
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.owner.commitCancelled).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual([terminal]);
    },
  );
  it.each([
    "expired",
    "stale",
    "revision",
    "attempt",
    "changed owner",
    "new activity",
  ])("fences %s retry after persistence failure", async (cause) => {
    const f = fixture();
    const commit = vi.fn(() => {
      throw new Error("offline");
    });
    f.owner.commitCancelled = commit;
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    Object.assign(f.agent, {
      status: cause === "new activity" ? "running" : "idle",
    });
    if (cause === "expired") f.command.expires_at = f.command.sent_at;
    if (cause === "stale") f.stale();
    if (cause === "revision") f.command.payload.job_revision++;
    if (cause === "attempt") f.command.payload.attempt++;
    if (cause === "changed owner")
      f.resolveOwner.mockImplementation(
        () => undefined as unknown as CancellationOwner,
      );
    expect(await f.handler.handle(f.command)).toBe("ignored");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it("cancels a real broker wait before the shared sink commits cancellation", async () => {
    const f = fixture();
    const lifetime = new AbortController();
    const broker = new RemoteApprovalBroker({
      reserve: () => ({
        requestedRevision: 7,
        deadline: Date.now() + 60_000,
        approvalTimeoutSeconds: 60,
        signal: lifetime.signal,
        isCurrent: () => true,
        release() {},
      }),
      publish: async () => {},
    });
    try {
      const approval = broker.request({
        jobId: f.command.payload.job_id,
        attempt: 1,
        fingerprint: `sha256:${"a".repeat(64)}`,
        actionSummary: "Delete output",
        impactSummary: "Output removed",
        riskClass: "approval_required",
        signal: f.approval.signal,
      });
      const cancellation = f.handler.handle(f.command);
      expect(await approval).toBe("cancelled");
      expect(f.events).toEqual([]);
      f.idle();
      expect(await cancellation).toBe("cancelled");
      expect(f.events).toEqual(["job.cancelled"]);
    } finally {
      broker.dispose();
    }
  });
  it("does not call cancel after a terminal has committed even before idle", async () => {
    const f = fixture();
    f.complete("job.succeeded");
    f.idle();
    expect(await f.handler.handle(f.command)).toBe("terminal");
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("withdraws pending approval even if Agent.cancel throws", async () => {
    const f = fixture();
    f.cancel.mockImplementation(() => {
      throw new Error("driver unavailable");
    });
    expect(await f.handler.handle(f.command)).toBe("unavailable");
    expect(f.approval.signal.aborted).toBe(true);
    expect(f.events).toEqual([]);
  });
  it("cancels a live owner, withdraws approval, and waits for quiescence", async () => {
    const f = fixture();
    const pending = f.handler.handle(f.command);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ kind: "user" });
    expect(f.approval.signal.aborted).toBe(true);
    expect(f.events).toEqual([]);
    f.idle();
    expect(await pending).toBe("cancelled");
    expect(f.events).toEqual(["job.cancelled"]);
  });
  it("coalesces concurrent and repeated cancellation without another terminal", async () => {
    const f = fixture();
    const first = f.handler.handle(f.command);
    const second = f.handler.handle(f.command);
    f.idle();
    expect(await first).toBe("cancelled");
    expect(await second).toBe("cancelled");
    await f.handler.handle(f.command);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["job.cancelled"]);
  });
  it.each(["job.succeeded", "job.failed"])(
    "preserves %s committed while cancellation is waiting",
    async (terminal) => {
      const f = fixture();
      const pending = f.handler.handle(f.command);
      f.complete(terminal);
      f.idle();
      expect(await pending).toBe("terminal");
      expect(f.events).toEqual([terminal]);
    },
  );
  it("drains pending result commits before cancellation arbitration", async () => {
    const f = fixture();
    f.owner.drainTerminals = async () => {
      await Promise.resolve();
      f.complete("job.succeeded");
    };
    const pending = f.handler.handle(f.command);
    f.idle();
    expect(await pending).toBe("terminal");
    expect(f.events).toEqual(["job.succeeded"]);
  });
  it("does not cancel an idle agent or arm future cancellation", async () => {
    const f = fixture();
    Object.assign(f.agent, { status: "idle" });
    expect(await f.handler.handle(f.command)).toBe("ignored");
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.approval.signal.aborted).toBe(false);
  });
  it.each(["unknown", "attempt", "revision", "expired", "stale", "malformed"])(
    "rejects %s authority before touching the Agent",
    async (kind) => {
      const f = fixture();
      if (kind === "unknown")
        f.resolveOwner.mockImplementation(
          () => undefined as unknown as CancellationOwner,
        );
      if (kind === "attempt") f.command.payload.attempt = 2;
      if (kind === "revision") f.command.payload.job_revision = 9;
      if (kind === "expired") f.command.expires_at = f.command.sent_at;
      if (kind === "stale") f.stale();
      if (kind === "malformed") f.command.payload.nonce = "invalid";
      f.idle();
      expect(await f.handler.handle(f.command)).toBe("ignored");
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
    },
  );
  it("does not commit cancellation after ownership is revoked", async () => {
    const f = fixture();
    const pending = f.handler.handle(f.command);
    f.stale();
    f.idle();
    expect(await pending).toBe("ignored");
    expect(f.events).toEqual([]);
  });
});
