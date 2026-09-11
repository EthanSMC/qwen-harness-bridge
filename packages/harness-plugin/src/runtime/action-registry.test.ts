import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";
import { TrustedActionRegistry } from "./action-registry.js";

const agentOf = (id: string) => ({ id }) as unknown as Agent;

const action = (_callId: string) => ({
  jobId: "11111111-1111-4111-8111-111111111111",
  attempt: 1,
  toolName: "shell",
  fingerprint: `sha256:${"a".repeat(64)}`,
  classification: "approval_required" as const,
  actionSummary: "Run tests",
  impactSummary: "Executes a repository command",
});

describe("TrustedActionRegistry", () => {
  it("resolves exactly the registered agent and call id", () => {
    const registry = new TrustedActionRegistry();
    const agent = agentOf("session-1");
    registry.registerOwner(agent);
    const dispose = registry.register(agent, "call-1", action("call-1"));
    const resolved = registry.resolveAction(agent, "call-1");
    expect(resolved?.toolName).toBe("shell");
    expect(resolved?.fingerprint).toBe(action("call-1").fingerprint);
    expect(registry.resolveAction(agent, "call-2")).toBeUndefined();
    expect(
      registry.resolveAction(agentOf("session-2"), "call-1"),
    ).toBeUndefined();
    expect(registry.findOwner("session-1")).toBe(agent);
    expect(registry.findOwner("session-2")).toBeUndefined();
    dispose();
    expect(registry.resolveAction(agent, "call-1")).toBeUndefined();
  });

  it("latches revocation on withdrawal", () => {
    const registry = new TrustedActionRegistry();
    const agent = agentOf("session-1");
    registry.registerOwner(agent);
    registry.register(agent, "call-1", action("call-1"));
    const signal = registry.resolveAction(agent, "call-1")?.signal;
    expect(signal?.aborted).toBe(false);
    registry.withdraw(agent);
    expect(signal?.aborted).toBe(true);
    expect(registry.resolveAction(agent, "call-1")).toBeUndefined();
    expect(registry.findOwner("session-1")).toBeUndefined();
  });

  it("replaces an action and ignores a stale disposer", () => {
    const registry = new TrustedActionRegistry();
    const agent = agentOf("session-1");
    registry.registerOwner(agent);
    const first = registry.register(agent, "call-1", action("call-1"));
    const second = registry.register(agent, "call-1", action("call-1"));
    const current = registry.resolveAction(agent, "call-1");
    expect(current?.signal.aborted).toBe(false);
    first();
    expect(registry.resolveAction(agent, "call-1")).toBe(current);
    second();
    expect(registry.resolveAction(agent, "call-1")).toBeUndefined();
  });
});
