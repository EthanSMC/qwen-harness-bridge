import {
  type ActionPolicyOptions,
  classifyAction,
} from "./action-classifier.js";
import type {
  CanonicalAction,
  PolicyDecision,
  PolicyGuard,
  PolicyPreExecuteListener,
  PolicyScopeContext,
  PolicyToolExecution,
} from "./types.js";

export type PolicyGuardRegistrationOptions = ActionPolicyOptions &
  Readonly<{
    repositoryId?: string;
    cwd?: string;
    resolveAction?: (
      execution: Readonly<PolicyToolExecution>,
    ) => CanonicalAction | undefined;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T => value === undefined || allowed.includes(value as T);

const actionFromArguments = (
  execution: Readonly<PolicyToolExecution>,
  options: PolicyGuardRegistrationOptions,
): CanonicalAction | undefined => {
  const args = execution.arguments;
  const embedded = isRecord(args) && isRecord(args.action) ? args.action : args;
  if (!isRecord(embedded)) return undefined;

  const repositoryId =
    typeof embedded.repositoryId === "string"
      ? embedded.repositoryId
      : options.repositoryId;
  const cwd = typeof embedded.cwd === "string" ? embedded.cwd : options.cwd;
  const argv = embedded.argv;
  const touchedPaths = embedded.touchedPaths;
  const commandValues = [
    isRecord(args) ? args.command : undefined,
    embedded.command,
  ];
  if (
    repositoryId === undefined ||
    cwd === undefined ||
    !Array.isArray(argv) ||
    !argv.every((value) => typeof value === "string") ||
    !Array.isArray(touchedPaths) ||
    !touchedPaths.every((value) => typeof value === "string") ||
    (embedded.executable !== undefined &&
      typeof embedded.executable !== "string") ||
    !isOneOf(embedded.environmentRead, [
      "none",
      "declared",
      "arbitrary",
    ] as const) ||
    !isOneOf(embedded.networkIntent, ["none", "read", "write"] as const) ||
    !isOneOf(embedded.fileChange, [
      "none",
      "bounded",
      "destructive",
    ] as const) ||
    !isOneOf(embedded.externalSideEffect, [
      "none",
      "message",
      "deploy",
      "purchase",
    ] as const) ||
    !isOneOf(embedded.commandSource, ["local", "cloud"] as const) ||
    commandValues.some(
      (value) => value !== undefined && typeof value !== "string",
    )
  ) {
    return undefined;
  }

  const hasCloudCommand = commandValues.some(
    (value) => typeof value === "string",
  );

  return {
    toolName: execution.name,
    ...(typeof embedded.executable === "string"
      ? { executable: embedded.executable }
      : {}),
    argv,
    cwd,
    repositoryId,
    touchedPaths,
    environmentRead:
      embedded.environmentRead === "declared" ||
      embedded.environmentRead === "arbitrary"
        ? embedded.environmentRead
        : "none",
    networkIntent:
      embedded.networkIntent === "read" || embedded.networkIntent === "write"
        ? embedded.networkIntent
        : "none",
    fileChange:
      embedded.fileChange === "bounded" || embedded.fileChange === "destructive"
        ? embedded.fileChange
        : "none",
    externalSideEffect:
      embedded.externalSideEffect === "message" ||
      embedded.externalSideEffect === "deploy" ||
      embedded.externalSideEffect === "purchase"
        ? embedded.externalSideEffect
        : "none",
    ...(hasCloudCommand
      ? { commandSource: "cloud" as const }
      : embedded.commandSource === "cloud" || embedded.commandSource === "local"
        ? { commandSource: embedded.commandSource }
        : {}),
  };
};

const fallbackAction = (
  execution: Readonly<PolicyToolExecution>,
  options: PolicyGuardRegistrationOptions,
): CanonicalAction | undefined => {
  const firstRepository = Array.isArray(options.repositories)
    ? options.repositories[0]
    : [...options.repositories.entries()].map(([id, repository]) =>
        typeof repository === "string"
          ? { id, canonicalPath: repository }
          : repository,
      )[0];
  const repositoryId = options.repositoryId ?? firstRepository?.id;
  const cwd = options.cwd ?? firstRepository?.canonicalPath;
  if (repositoryId === undefined || cwd === undefined) return undefined;
  const args = isRecord(execution.arguments) ? execution.arguments : {};
  const command = typeof args.command === "string" ? args.command : undefined;
  return {
    toolName: execution.name,
    ...(typeof args.executable === "string"
      ? { executable: args.executable }
      : {}),
    argv:
      Array.isArray(args.argv) &&
      args.argv.every((value) => typeof value === "string")
        ? args.argv
        : command === undefined
          ? []
          : [command],
    cwd,
    repositoryId,
    touchedPaths:
      Array.isArray(args.touchedPaths) &&
      args.touchedPaths.every((value) => typeof value === "string")
        ? args.touchedPaths
        : [],
    environmentRead:
      args.environmentRead === "declared" ||
      args.environmentRead === "arbitrary"
        ? args.environmentRead
        : "none",
    networkIntent:
      args.networkIntent === "read" || args.networkIntent === "write"
        ? args.networkIntent
        : "none",
    fileChange:
      args.fileChange === "bounded" || args.fileChange === "destructive"
        ? args.fileChange
        : "none",
    externalSideEffect:
      args.externalSideEffect === "message" ||
      args.externalSideEffect === "deploy" ||
      args.externalSideEffect === "purchase"
        ? args.externalSideEffect
        : "none",
    ...(command === undefined ? {} : { commandSource: "cloud" as const }),
  };
};

const actionFor = (
  execution: Readonly<PolicyToolExecution>,
  options: PolicyGuardRegistrationOptions,
): CanonicalAction | undefined => {
  const resolved = options.resolveAction?.(execution);
  if (resolved !== undefined) return resolved;

  const structured = actionFromArguments(execution, options);
  if (structured !== undefined) return structured;

  const args = execution.arguments;
  if (isRecord(args) && typeof args.command === "string") {
    return fallbackAction(execution, options);
  }
  return undefined;
};

type ExecutionSnapshots = WeakMap<object, string>;

const rememberSnapshot = (
  snapshots: ExecutionSnapshots,
  execution: Readonly<PolicyToolExecution>,
  fingerprint: string,
): void => {
  if (typeof execution === "object" && execution !== null) {
    snapshots.set(execution, fingerprint);
  }
};

const rememberedSnapshot = (
  snapshots: ExecutionSnapshots,
  execution: Readonly<PolicyToolExecution>,
): string | undefined =>
  typeof execution === "object" && execution !== null
    ? snapshots.get(execution)
    : undefined;

/** Build the scoped, synchronous monotonic denied guard. */
export function createPolicyGuard(
  options: PolicyGuardRegistrationOptions,
  snapshots: ExecutionSnapshots = new WeakMap<object, string>(),
): PolicyGuard {
  return (execution) => {
    let action: CanonicalAction | undefined;
    try {
      action = actionFor(execution, options);
    } catch {
      return "POLICY_DENIED:UNSTRUCTURED_ACTION";
    }
    if (action === undefined) return "POLICY_DENIED:UNSTRUCTURED_ACTION";
    let result: PolicyDecision;
    try {
      result = classifyAction(action, options);
    } catch {
      return "POLICY_DENIED:UNSTRUCTURED_ACTION";
    }
    const initialFingerprint = rememberedSnapshot(snapshots, execution);
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
    let action: CanonicalAction | undefined;
    try {
      action = actionFor(execution, options);
    } catch {
      return { kind: "deny", reason: "POLICY_DENIED:UNSTRUCTURED_ACTION" };
    }
    if (action === undefined)
      return { kind: "deny", reason: "POLICY_DENIED:UNSTRUCTURED_ACTION" };
    let result: PolicyDecision;
    try {
      result = classifyAction(action, options);
    } catch {
      return { kind: "deny", reason: "POLICY_DENIED:UNSTRUCTURED_ACTION" };
    }
    rememberSnapshot(snapshots, execution, result.fingerprint);
    if (result.classification === "approval_required") {
      return {
        kind: "ask",
        reason: `POLICY_APPROVAL_REQUIRED:${result.reasonCode}`,
      };
    }
    return next();
  };
}

/**
 * Register policy only in the supplied Agent setup context. The caller must
 * pass the scoped context received by `Agent.setup`; this function never reads
 * or mutates a process-global context.
 */
export function registerPolicyGuard(
  scopedContext: PolicyScopeContext,
  options: PolicyGuardRegistrationOptions,
): () => void {
  const snapshots: ExecutionSnapshots = new WeakMap<object, string>();
  const guardDisposer = scopedContext.tools.guard(
    createPolicyGuard(options, snapshots),
  );
  const preExecuteDisposer = scopedContext.on(
    "tools/pre-execute",
    createPolicyPreExecuteListener(options, snapshots),
    { before: true },
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    guardDisposer();
    preExecuteDisposer();
  };
}
