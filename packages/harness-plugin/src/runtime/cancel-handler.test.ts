import { randomUUID } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it, vi } from "vitest";
import { RemoteApprovalBroker } from "../approvals/approval-broker.js";
import {
  CancelHandler,
  type CancellationOwner,
  type JobCancelMessage,
} from "./cancel-handler.js";

function fixture() {
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
  const resolveOwner = vi.fn(() => owner);
  const handler = new CancelHandler({ resolveOwner });
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
