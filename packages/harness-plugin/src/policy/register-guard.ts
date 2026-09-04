import { Context } from "@deepseek-ai/cordis";
import type { AgentSetup } from "@deepseek-ai/dsh-agent";
import type {
  PreToolDecision,
  ToolExecution,
  ToolGuard,
} from "@deepseek-ai/dsh-tools";
import {
  type ActionPolicyOptions,
  classifyAction,
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

type PolicyPreExecuteListener = (
  execution: Readonly<ToolExecution>,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>;

type Resolution =
  | Readonly<{ kind: "resolved"; value: TrustedPolicyAction }>
  | Readonly<{ kind: "denied"; reason: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveTrustedAction = (
  execution: PolicyExecution,
  options: PolicyGuardRegistrationOptions,
): Resolution => {
  if (typeof options.resolveAction !== "function") {
    return { kind: "denied", reason: "POLICY_DENIED:UNTRUSTED_ACTION" };
  }

  let resolved: TrustedPolicyAction | undefined;
  try {
    resolved = options.resolveAction(execution);
  } catch {
    return { kind: "denied", reason: "POLICY_DENIED:UNTRUSTED_ACTION" };
  }
  if (
    !isRecord(resolved) ||
    !isRecord(resolved.action) ||
    (resolved.provenance !== "local_tool" &&
      resolved.provenance !== "cloud_command")
  ) {
    return { kind: "denied", reason: "POLICY_DENIED:UNTRUSTED_ACTION" };
  }
  if (resolved.action.toolName !== execution.name) {
    return {
      kind: "denied",
      reason: "POLICY_DENIED:UNTRUSTED_TOOL_IDENTITY",
    };
  }
  return { kind: "resolved", value: resolved };
};

const classifyResolvedAction = (
  resolved: TrustedPolicyAction,
  options: PolicyGuardRegistrationOptions,
): PolicyDecision =>
  classifyAction(resolved.action, options, {
    provenance: resolved.provenance,
  });

type ExecutionSnapshots = WeakMap<object, string>;

/** Build the synchronous monotonic denied guard for one Agent scope. */
export function createPolicyGuard(
  options: PolicyGuardRegistrationOptions,
  snapshots: ExecutionSnapshots = new WeakMap<object, string>(),
): ToolGuard {
  return (execution) => {
    const resolution = resolveTrustedAction(execution, options);
    if (resolution.kind === "denied") return resolution.reason;

    let result: PolicyDecision;
    try {
      result = classifyResolvedAction(resolution.value, options);
    } catch {
      return "POLICY_DENIED:UNTRUSTED_ACTION";
    }
    const initialFingerprint = snapshots.get(execution);
    if (
      initialFingerprint !== undefined &&
      initialFingerprint !== result.fingerprint
    ) {
      return "POLICY_DENIED:PATH_CHANGED";
    }
    return result.classification === "denied"
      ? `POLICY_DENIED:${result.reasonCode}`
      : undefined;
  };
}

/** Convert approval-required actions to Harness's standard approval seam. */
export function createPolicyPreExecuteListener(
  options: PolicyGuardRegistrationOptions,
  snapshots: ExecutionSnapshots = new WeakMap<object, string>(),
): PolicyPreExecuteListener {
  return async (execution, next) => {
    const resolution = resolveTrustedAction(execution, options);
    if (resolution.kind === "denied") {
      return { kind: "deny", reason: resolution.reason };
    }

    let result: PolicyDecision;
    try {
      result = classifyResolvedAction(resolution.value, options);
    } catch {
      return { kind: "deny", reason: "POLICY_DENIED:UNTRUSTED_ACTION" };
    }
    snapshots.set(execution, result.fingerprint);
    if (result.classification === "approval_required") {
      return {
        kind: "ask",
        reason: `POLICY_APPROVAL_REQUIRED:${result.reasonCode}`,
      };
    }
    return next();
  };
}

const assertAgentSetupContext = (agentContext: Context): void => {
  const agent = agentContext.agent;
  if (
    !Context.is(agentContext) ||
    agentContext === agentContext.root ||
    agent === undefined ||
    agent.ctx !== agentContext
  ) {
    throw new Error("POLICY_AGENT_SCOPE_REQUIRED");
  }
};

/** Register policy through the exact Context supplied to an Agent setup callback. */
export function registerPolicyGuard(
  agentContext: Context,
  options: PolicyGuardRegistrationOptions,
): () => void {
  assertAgentSetupContext(agentContext);
  const snapshots: ExecutionSnapshots = new WeakMap<object, string>();
  const guardDisposer = agentContext.tools.guard(
    createPolicyGuard(options, snapshots),
  );
  const preExecuteDisposer = agentContext.on(
    "tools/pre-execute",
    createPolicyPreExecuteListener(options, snapshots),
    { prepend: true },
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    guardDisposer();
    preExecuteDisposer();
  };
}

/** Produce the official Agent setup callback used by bridge-owned Agents. */
export function createPolicyAgentSetup(
  options: PolicyGuardRegistrationOptions,
): AgentSetup {
  return (agentContext) => {
    registerPolicyGuard(agentContext, options);
  };
}
