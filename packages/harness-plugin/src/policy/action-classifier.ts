import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";
import { CanonicalPathError, canonicalizePath } from "./canonical-path.js";
import type {
  CanonicalAction,
  CanonicalActionResult,
  PolicyDecision,
  PolicyPathViolation,
  RepositoryPolicy,
  RepositoryPolicySource,
} from "./types.js";

export type ActionPolicyOptions = Readonly<{
  repositories: RepositoryPolicySource;
}>;

export type ActionInput = Readonly<{
  toolName: string;
  executable?: string;
  argv: readonly string[];
  cwd: string;
  repositoryId: string;
  touchedPaths: readonly string[];
  environmentRead: "none" | "declared" | "arbitrary";
  networkIntent: "none" | "read" | "write";
  fileChange: "none" | "bounded" | "destructive";
  externalSideEffect: "none" | "message" | "deploy" | "purchase";
  commandSource?: "local" | "cloud";
}>;

const asRepositoryArray = (
  source: RepositoryPolicySource | ActionPolicyOptions,
): readonly RepositoryPolicy[] => {
  if (Array.isArray(source)) return source as readonly RepositoryPolicy[];
  if ("repositories" in source) {
    if (Array.isArray(source.repositories)) {
      return source.repositories as readonly RepositoryPolicy[];
    }
    const repositories = source.repositories as ReadonlyMap<
      string,
      string | RepositoryPolicy
    >;
    return [...repositories.entries()].map(([id, repository]) =>
      typeof repository === "string"
        ? { id, canonicalPath: repository }
        : repository,
    );
  }
  const repositories = source as ReadonlyMap<string, string | RepositoryPolicy>;
  return [...repositories.entries()].map(([id, repository]) =>
    typeof repository === "string"
      ? { id, canonicalPath: repository }
      : repository,
  );
};

const repositoryFor = (
  source: RepositoryPolicySource | ActionPolicyOptions | undefined,
  repositoryId: string,
): RepositoryPolicy | undefined =>
  source === undefined
    ? undefined
    : asRepositoryArray(source).find(({ id }) => id === repositoryId);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;

const actionWithFallback = (action: ActionInput): CanonicalAction => ({
  toolName: typeof action.toolName === "string" ? action.toolName : "unknown",
  ...(typeof action.executable === "string"
    ? { executable: action.executable }
    : {}),
  argv: stringArray(action.argv) ?? [],
  cwd: typeof action.cwd === "string" ? action.cwd : "",
  repositoryId:
    typeof action.repositoryId === "string" ? action.repositoryId : "",
  touchedPaths: stringArray(action.touchedPaths) ?? [],
  environmentRead:
    action.environmentRead === "declared" ||
    action.environmentRead === "arbitrary"
      ? action.environmentRead
      : "none",
  networkIntent:
    action.networkIntent === "read" || action.networkIntent === "write"
      ? action.networkIntent
      : "none",
  fileChange:
    action.fileChange === "bounded" || action.fileChange === "destructive"
      ? action.fileChange
      : "none",
  externalSideEffect:
    action.externalSideEffect === "message" ||
    action.externalSideEffect === "deploy" ||
    action.externalSideEffect === "purchase"
      ? action.externalSideEffect
      : "none",
  ...(action.commandSource === "cloud" || action.commandSource === "local"
    ? { commandSource: action.commandSource }
    : {}),
});

const lexicalFallback = (path: string, basePath?: string): string => {
  if (isAbsolute(path)) return normalize(path);
  return basePath === undefined ? path : resolve(basePath, path);
};

const addViolation = (
  violations: PolicyPathViolation[],
  error: unknown,
): void => {
  if (error instanceof CanonicalPathError) {
    if (!violations.includes(error.code)) violations.push(error.code);
    return;
  }
  if (!violations.includes("PATH_UNAVAILABLE")) {
    violations.push("PATH_UNAVAILABLE");
  }
};

/**
 * Canonicalize all path-bearing fields. The returned violations are retained
 * instead of being thrown so an unsafe action produces a normal denied policy
 * decision with a deterministic fingerprint.
 */
export function canonicalizeAction(
  action: unknown,
  source?: RepositoryPolicySource | ActionPolicyOptions,
): CanonicalActionResult {
  const input = isRecord(action) ? action : {};
  const repositoryId =
    typeof input.repositoryId === "string" ? input.repositoryId : "";
  const repository = repositoryFor(source, repositoryId);
  const canonical = actionWithFallback(input as ActionInput);
  const violations: PolicyPathViolation[] = [];

  const validAction =
    isRecord(action) &&
    typeof input.toolName === "string" &&
    (input.executable === undefined || typeof input.executable === "string") &&
    stringArray(input.argv) !== undefined &&
    typeof input.cwd === "string" &&
    typeof input.repositoryId === "string" &&
    stringArray(input.touchedPaths) !== undefined &&
    (input.environmentRead === "none" ||
      input.environmentRead === "declared" ||
      input.environmentRead === "arbitrary") &&
    (input.networkIntent === "none" ||
      input.networkIntent === "read" ||
      input.networkIntent === "write") &&
    (input.fileChange === "none" ||
      input.fileChange === "bounded" ||
      input.fileChange === "destructive") &&
    (input.externalSideEffect === "none" ||
      input.externalSideEffect === "message" ||
      input.externalSideEffect === "deploy" ||
      input.externalSideEffect === "purchase") &&
    (input.commandSource === undefined ||
      input.commandSource === "local" ||
      input.commandSource === "cloud");
  if (!validAction) violations.push("UNSTRUCTURED_ACTION");

  if (repository === undefined && source !== undefined) {
    violations.push("UNKNOWN_REPOSITORY");
  }

  let canonicalCwd = lexicalFallback(canonical.cwd);
  if (repository !== undefined) {
    try {
      canonicalCwd = canonicalizePath(repository.canonicalPath, canonical.cwd);
    } catch (error) {
      addViolation(violations, error);
    }
  }

  const canonicalTouchedPaths = canonical.touchedPaths.map((path) => {
    if (repository === undefined) return lexicalFallback(path, canonicalCwd);
    try {
      return canonicalizePath(repository.canonicalPath, path, {
        basePath: canonicalCwd,
      });
    } catch (error) {
      addViolation(violations, error);
      return lexicalFallback(path, canonicalCwd);
    }
  });

  const normalized: CanonicalAction = {
    ...canonical,
    cwd: canonicalCwd,
    touchedPaths: canonicalTouchedPaths,
  };
  return { action: normalized, violations };
}

const canonicalFingerprintRecord = (action: CanonicalAction) => ({
  argv: [...action.argv],
  cwd: action.cwd,
  environmentRead: action.environmentRead,
  executable: action.executable ?? null,
  externalSideEffect: action.externalSideEffect,
  fileChange: action.fileChange,
  networkIntent: action.networkIntent,
  commandSource: action.commandSource ?? null,
  repositoryId: action.repositoryId,
  toolName: action.toolName,
  touchedPaths: [...action.touchedPaths].sort(),
});

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

/** Canonical JSON used by the SHA-256 action fingerprint. */
export function canonicalActionJson(action: CanonicalAction): string {
  return stableJson(canonicalFingerprintRecord(action));
}

/** SHA-256 of the canonical, machine-readable action record. */
export function fingerprintAction(action: CanonicalAction): string {
  return createHash("sha256").update(canonicalActionJson(action)).digest("hex");
}

const lowerTokens = (action: CanonicalAction): string[] =>
  [action.toolName, action.executable ?? "", ...action.argv].map((value) =>
    value.toLowerCase(),
  );

const hasToken = (tokens: readonly string[], pattern: RegExp): boolean =>
  tokens.some((token) => pattern.test(token));

const denialForCommand = (action: CanonicalAction): string | undefined => {
  const tokens = lowerTokens(action);
  const tool = action.toolName.toLowerCase();
  const executable = (action.executable ?? "").toLowerCase();
  const executableName = executable.split(/[\\/]/u).pop() ?? executable;

  if (
    action.commandSource === "cloud" ||
    /^(arbitrary[-_ ]?command|cloud[-_ ]?command|shell|exec|execute[-_ ]?command)$/u.test(
      tool,
    ) ||
    /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/u.test(
      executable.split(/[\\/]/u).pop() ?? executable,
    )
  ) {
    return "ARBITRARY_COMMAND";
  }
  if (
    /keychain|credential[-_ ]?store|secret[-_ ]?store/u.test(
      tokens.join(" "),
    ) ||
    executableName === "security"
  ) {
    return "KEYCHAIN_ACCESS";
  }
  if (
    action.environmentRead === "arbitrary" ||
    hasToken(tokens, /(^|[/_ -])(printenv|env|set|export)([/_ -]|$)/u) ||
    hasToken(
      tokens,
      /(secret|token|password|credential|api[-_ ]?key|private[-_ ]?key)/u,
    )
  ) {
    return action.environmentRead === "arbitrary"
      ? "ENVIRONMENT_ARBITRARY"
      : "SECRET_ACCESS";
  }
  if (
    /system[-_ ]?settings|system[-_ ]?preferences/u.test(tool) ||
    executableName === "defaults" ||
    executableName === "launchctl" ||
    executableName === "systemsetup" ||
    executableName === "networksetup" ||
    executableName === "scutil" ||
    (executableName === "osascript" && hasToken(tokens, /-e/u))
  ) {
    return "SYSTEM_SETTINGS";
  }
  return undefined;
};

const approvalForCommand = (action: CanonicalAction): string | undefined => {
  const executable = (action.executable ?? "").split(/[\\/]/u).pop() ?? "";
  const args = action.argv.map((value) => value.toLowerCase());
  const tool = action.toolName.toLowerCase();
  const packageCommand = /^(npm|pnpm|yarn|bun|pip|pip3|cargo|brew)$/u.test(
    executable,
  );
  if (
    tool === "package_install" ||
    (packageCommand &&
      args.some((argument) =>
        /^(install|i|add|remove|rm|update|upgrade|link)$/u.test(argument),
      ))
  ) {
    return "PACKAGE_INSTALL";
  }
  if (
    tool === "git_push" ||
    (executable === "git" && args.some((argument) => argument === "push"))
  ) {
    return "GIT_PUSH";
  }
  if (
    action.externalSideEffect === "deploy" ||
    /(^|[-_ ])deploy($|[-_ ])/u.test(tool)
  ) {
    return "DEPLOY";
  }
  if (action.networkIntent === "write") return "NETWORK_WRITE";
  if (action.externalSideEffect === "message") return "EXTERNAL_MESSAGE";
  if (action.externalSideEffect === "purchase") return "PURCHASE";
  if (action.fileChange === "destructive") return "DESTRUCTIVE_FILE_CHANGE";
  return undefined;
};

const automaticReason = (action: CanonicalAction): string => {
  const tool = action.toolName.toLowerCase();
  if (/search|find|grep|ripgrep/u.test(tool)) return "SEARCH";
  if (
    /test/u.test(tool) ||
    action.argv.some((value) => /(^|[/ -])test(s)?$/u.test(value))
  ) {
    return "TEST";
  }
  if (
    /build|compile/u.test(tool) ||
    action.argv.some((value) => value === "build")
  ) {
    return "BUILD";
  }
  if (action.fileChange === "bounded") return "BOUNDED_EDIT";
  return "READ_ONLY";
};

const decision = (
  classification: PolicyDecision["classification"],
  reasonCode: string,
  fingerprint: string,
): PolicyDecision => {
  if (classification === "denied") {
    return {
      classification,
      fingerprint,
      reasonCode,
      actionSummary: "Local policy denied this action.",
      impactSummary: "The action will not reach Harness execution.",
    };
  }
  if (classification === "approval_required") {
    return {
      classification,
      fingerprint,
      reasonCode,
      actionSummary: "This repository action requires owner approval.",
      impactSummary:
        "The action remains paused until Harness receives allowed-once approval.",
    };
  }
  return {
    classification,
    fingerprint,
    reasonCode,
    actionSummary: "This repository action is allowed automatically.",
    impactSummary: "No approval or external side effect is required.",
  };
};

export function classifyAction(
  action: unknown,
  source?: RepositoryPolicySource | ActionPolicyOptions,
): PolicyDecision {
  const canonical = canonicalizeAction(action, source);
  const fingerprint = fingerprintAction(canonical.action);
  const commandDenial = denialForCommand(canonical.action);
  if (commandDenial !== undefined) {
    return decision("denied", commandDenial, fingerprint);
  }
  if (canonical.violations.length > 0) {
    return decision(
      "denied",
      canonical.violations[0] ?? "PATH_UNAVAILABLE",
      fingerprint,
    );
  }
  const environmentDenial =
    canonical.action.environmentRead === "arbitrary"
      ? "ENVIRONMENT_ARBITRARY"
      : undefined;
  if (environmentDenial !== undefined) {
    return decision("denied", environmentDenial, fingerprint);
  }
  const approval = approvalForCommand(canonical.action);
  if (approval !== undefined) {
    return decision("approval_required", approval, fingerprint);
  }
  return decision("automatic", automaticReason(canonical.action), fingerprint);
}

export { stableJson };
