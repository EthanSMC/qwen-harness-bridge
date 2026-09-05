import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecisionMessage,
  RemoteApprovalBroker,
} from "./approval-broker.js";
import { type AnswererAction, registerAnswerer } from "./register-answerer.js";

function fixture() {
  const root = new Context();
  const approval = new ApprovalService(root, { policy: "ask" });
  // Official Context, scope and audited ApprovalService; session is an in-memory
  // audit fixture, not an Agent driver or persistent Session implementation.
  const events: { type: string; data?: unknown }[] = [{ type: "turn/start" }];
  const agent = {
    id: "owned",
    ctx: root,
    session: {
      get seq() {
        return events.length;
      },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: unknown) => {
        events.push({ type, data });
      },
    },
  } as unknown as Agent;
  Object.assign(agent, { ctx: createScope(root, agent).ctx.extend({ agent }) });
  const jobId = randomUUID();
  const lifetime = new AbortController();
  const transport = new AbortController();
  const release = vi.fn();
  let action: AnswererAction | undefined = {
    jobId,
    attempt: 1,
    toolName: "delete_file",
    fingerprint: `sha256:${"a".repeat(64)}`,
    classification: "approval_required",
    actionSummary: "Delete output",
    impactSummary: "Generated output removed",
    signal: lifetime.signal,
  };
  let published!: Record<string, unknown>;
  let publishReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    publishReady = resolve;
  });
  const broker = new RemoteApprovalBroker({
    reserve: () => ({
      requestedRevision: 8,
      deadline: Date.now() + 60_000,
      approvalTimeoutSeconds: 60,
      signal: transport.signal,
      isCurrent: () => true,
      release,
    }),
    publish: async (_type, payload) => {
      published = payload;
      publishReady();
    },
  });
  const unregister = registerAnswerer(root, {
    broker,
    findOwner: (id) => (id === "owned" ? agent : undefined),
    resolveAction: (owner, callId) =>
      owner === agent && callId === "call" ? action : undefined,
  });
  const request = (overrides = {}) =>
    approval.request({
      agent,
      callId: ToolCallId("call"),
      toolName: "delete_file",
      reason: "untrusted explanation",
      ...overrides,
    });
  const decide = () =>
    broker.acceptDecision({
      protocol_version: "1.0",
      type: "approval.decision",
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      sequence: 1,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      payload: {
        approval_id: String(published.approval_id),
        job_id: jobId,
        attempt: 1,
        job_revision: 8,
        action_fingerprint: `sha256:${"a".repeat(64)}`,
        decision: "approve",
      },
    } satisfies ApprovalDecisionMessage);
  return {
    root,
    agent,
    events,
    request,
    ready,
    decide,
    lifetime,
    transport,
    release,
    broker,
    productId: () => published.approval_id,
    setAction: (value: AnswererAction | undefined) => {
      action = value;
    },
    getAction: () => {
      if (!action) throw new Error("fixture action missing");
      return action;
    },
    dispose: () => {
      unregister();
      broker.dispose();
    },
  };
}
describe("official approval service answerer integration", () => {
  it.each(["transport loss", "broker disposal"])(
    "returns and audits unavailable when release causes %s",
    async (cause) => {
      const f = fixture();
      try {
        f.release.mockImplementationOnce(() => {
          if (cause === "transport loss") f.transport.abort();
          else f.broker.dispose();
        });
        const pending = f.request();
        await f.ready;
        expect(f.decide()).toBe("accepted");
        const outcome = await pending;
        expect(f.lifetime.signal.aborted).toBe(false);
        expect(f.release).toHaveBeenCalledTimes(1);
        expect.soft(outcome).toBe("unavailable");
        expect.soft(f.events[2]).toMatchObject({
          type: "approval/decided",
          data: { outcome: "unavailable" },
        });
      } finally {
        f.dispose();
      }
    },
  );
  it("rechecks the exact Agent scope before releasing a grant", async () => {
    const f = fixture();
    try {
      const pending = f.request();
      await f.ready;
      Object.assign(f.agent, { ctx: f.root });
      f.decide();
      expect(await pending).toBe("unavailable");
    } finally {
      f.dispose();
    }
  });
  it("withdraws the broker waiter on caller abort", async () => {
    const f = fixture();
    try {
      const controller = new AbortController();
      const pending = f.request({ signal: controller.signal });
      await f.ready;
      controller.abort();
      expect(await pending).toBe("cancelled");
      expect(f.decide()).toBe("ignored");
    } finally {
      f.dispose();
    }
  });
  it("rejects in-place mutation of the registry action while waiting", async () => {
    const f = fixture();
    try {
      const pending = f.request();
      await f.ready;
      Object.assign(f.getAction(), { fingerprint: `sha256:${"b".repeat(64)}` });
      f.decide();
      expect(await pending).toBe("unavailable");
    } finally {
      f.dispose();
    }
  });
  it("grants a canonical owned call and retains distinct audit and product IDs", async () => {
    const f = fixture();
    try {
      const pending = f.request();
      await f.ready;
      expect(f.decide()).toBe("accepted");
      expect(await pending).toBe("allowed-once");
      expect(f.events.map((event) => event.type)).toEqual([
        "turn/start",
        "approval/asked",
        "approval/decided",
      ]);
      expect(f.events[2].data).toMatchObject({ outcome: "allowed-once" });
      expect((f.events[1].data as { id: string }).id).not.toBe(f.productId());
    } finally {
      f.dispose();
    }
  });
  it("delegates unrelated agents through the official waterfall", async () => {
    const f = fixture();
    const other = { ...f.agent, id: "other" } as Agent;
    const remove = f.root.on("approval/request", async () => "rejected");
    try {
      expect(await f.request({ agent: other })).toBe("rejected");
    } finally {
      remove();
      f.dispose();
    }
  });
  it.each(["lookalike", "missing", "denied", "wrong-tool"])(
    "fails closed for %s owned context",
    async (kind) => {
      const f = fixture();
      try {
        if (kind === "missing") f.setAction(undefined);
        if (kind === "denied")
          f.setAction({ ...f.getAction(), classification: "denied" });
        const overrides =
          kind === "lookalike"
            ? { agent: { ...f.agent } }
            : kind === "wrong-tool"
              ? { toolName: "other" }
              : {};
        expect(await f.request(overrides)).toBe(
          kind === "denied" ? "rejected" : "unavailable",
        );
      } finally {
        f.dispose();
      }
    },
  );
  it.each(["changed", "revoked", "disposed"])(
    "does not grant after action is %s",
    async (kind) => {
      const f = fixture();
      try {
        const pending = f.request();
        await f.ready;
        if (kind === "changed")
          f.setAction({ ...f.getAction(), fingerprint: "b".repeat(64) });
        if (kind === "revoked") f.lifetime.abort();
        if (kind === "disposed") f.dispose();
        f.decide();
        expect(await pending).not.toBe("allowed-once");
      } finally {
        f.dispose();
      }
    },
  );
});
