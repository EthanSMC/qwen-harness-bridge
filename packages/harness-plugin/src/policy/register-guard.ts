import { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import {
  type ActionPolicyOptions,
  classifyAction,
  snapshotActionPolicy,
  type TrustedActionContext,
} from "./action-classifier.js";
import type { CanonicalAction, PolicyDecision } from "./types.js";

type PolicyExecution = Pick<Readonly<ToolExecution>, "arguments" | "name">;
export type TrustedPolicyAction = Readonly<{
  action: CanonicalAction;
  provenance: TrustedActionContext["provenance"];
}>;
export type PolicyGuardRegistrationOptions = ActionPolicyOptions &
  Readonly<{
    resolveAction: (
      execution: PolicyExecution,
    ) => TrustedPolicyAction | undefined;
  }>;
export type PolicyAgentSetupOptions = PolicyGuardRegistrationOptions &
  Readonly<{ agentId: string }>;

// Only the bridge's identity-bound setup capability can authorize registration.
const ownedContexts = new WeakSet<Context>();
function assertAgentSetupContext(
  ctx: Context,
): asserts ctx is Context & { agent: Agent } {
  if (
    !Context.is(ctx) ||
    ctx === ctx.root ||
    !ctx.agent ||
    ctx.agent.ctx !== ctx ||
    scopeOf(ctx) !== ctx.agent
  ) {
    throw new Error("POLICY_AGENT_SCOPE_REQUIRED");
  }
}
const snapshotRegistration = (
  options: PolicyGuardRegistrationOptions,
): PolicyGuardRegistrationOptions =>
  Object.freeze({
    ...snapshotActionPolicy(options),
    resolveAction: options.resolveAction,
  });

const classify = (
  execution: Readonly<ToolExecution>,
  options: PolicyGuardRegistrationOptions,
): PolicyDecision | undefined => {
  try {
    const resolved = options.resolveAction(execution);
    if (
      !resolved ||
      resolved.action?.toolName !== execution.name ||
      !["local_tool", "cloud_command"].includes(resolved.provenance)
    )
      return undefined;
    return classifyAction(resolved.action, options, {
      provenance: resolved.provenance,
    });
  } catch {
    return undefined;
  }
};

/** Registration is available only inside an identity-bound bridge setup. */
export function registerPolicyGuard(
  ctx: Context,
  options: PolicyGuardRegistrationOptions,
): () => void {
  assertAgentSetupContext(ctx);
  if (!ownedContexts.has(ctx)) throw new Error("POLICY_BRIDGE_SETUP_REQUIRED");
  options = snapshotRegistration(options);
  const agent = ctx.agent;
  // Neither ask intent nor a caller-provided snapshot can mint these proofs.
  const proofs = new WeakMap<
    object,
    { fingerprint: string; granted: boolean }
  >();
  const visited = new WeakSet<object>();
  const guardDisposer = ctx.tools.guard((execution) => {
    const proof = proofs.get(execution);
    proofs.delete(execution); // consume even on a failed final check
    if (execution.agent !== agent || execution.signal.aborted)
      return "POLICY_DENIED:UNTRUSTED_EXECUTION";
    const result = classify(execution, options);
    if (!result) return "POLICY_DENIED:UNTRUSTED_ACTION";
    if (result.classification === "denied")
      return `POLICY_DENIED:${result.reasonCode}`;
    if (!proof) return "POLICY_DENIED:APPROVAL_PROOF_REQUIRED";
    if (proof.fingerprint !== result.fingerprint)
      return "POLICY_DENIED:PATH_CHANGED";
    if (!proof.granted) return "POLICY_DENIED:APPROVAL_PROOF_REQUIRED";
    return undefined;
  });
  const preExecuteDisposer = ctx.on(
    "tools/pre-execute",
    async (execution, next): Promise<PreToolDecision> => {
      if (
        execution.agent !== agent ||
        execution.signal.aborted ||
        visited.has(execution)
      )
        return { kind: "deny", reason: "POLICY_DENIED:UNTRUSTED_EXECUTION" };
      visited.add(execution);
      const result = classify(execution, options);
      if (!result)
        return { kind: "deny", reason: "POLICY_DENIED:UNTRUSTED_ACTION" };
      if (result.classification === "denied")
        return { kind: "deny", reason: `POLICY_DENIED:${result.reasonCode}` };
      const proof = { fingerprint: result.fingerprint, granted: false };
      proofs.set(execution, proof);
      if (result.classification === "approval_required") {
        const approval = ctx.get("approval");
        if (!approval)
          return { kind: "deny", reason: "POLICY_DENIED:APPROVAL_UNAVAILABLE" };
        try {
          const outcome = await approval.request({
            agent,
            toolName: execution.name,
            callId: execution.callId,
            signal: execution.signal,
            reason: `POLICY_APPROVAL_REQUIRED:${result.reasonCode}:${result.fingerprint}`,
          });
          if (outcome !== "allowed-once" || execution.signal.aborted)
            return {
              kind: "deny",
              reason: "POLICY_DENIED:APPROVAL_NOT_GRANTED",
            };
          proof.granted = true;
          return { kind: "allow" };
        } catch {
          return { kind: "deny", reason: "POLICY_DENIED:APPROVAL_UNAVAILABLE" };
        }
      }
      proof.granted = true;
      return next();
    },
    { prepend: true },
  );
  return () => {
    guardDisposer();
    preExecuteDisposer();
  };
}

/** Pass only to the bridge-owned Agent factory's setup option for this ID. */
export function createPolicyAgentSetup(
  options: PolicyAgentSetupOptions,
): AgentSetup & { dispose(): void } {
  const agentId = options.agentId;
  if (typeof agentId !== "string" || agentId.length === 0)
    throw new Error("POLICY_AGENT_ID_REQUIRED");
  const registration = snapshotRegistration(options);
  let owner: Agent | undefined;
  const disposers: (() => void)[] = [];
  const setup: AgentSetup = (ctx) => {
    assertAgentSetupContext(ctx);
    if (
      String(ctx.agent.id) !== agentId ||
      (owner !== undefined && owner !== ctx.agent)
    )
      throw new Error("POLICY_BRIDGE_AGENT_MISMATCH");
    if (owner !== undefined) throw new Error("POLICY_ALREADY_REGISTERED");
    owner = ctx.agent;
    ownedContexts.add(ctx);
    try {
      disposers.push(registerPolicyGuard(ctx, registration));
    } finally {
      ownedContexts.delete(ctx);
    }
  };
  return Object.assign(setup, {
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  });
}
