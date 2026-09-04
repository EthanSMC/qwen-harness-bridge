import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
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
}>;

export type TrustedExecutableResolver = (
  executable: string,
  cwd: string,
) => string | undefined;

export type TrustedActionContext = Readonly<{
  provenance: "local_tool" | "cloud_command";
  resolveExecutable?: TrustedExecutableResolver;
}>;

const resolveExecutableFromPath: TrustedExecutableResolver = (
  executable,
  cwd,
) => {
  for (const searchDirectory of (process.env.PATH ?? "").split(delimiter)) {
    if (searchDirectory.length === 0) continue;
    const directory = isAbsolute(searchDirectory)
      ? searchDirectory
      : resolve(cwd, searchDirectory);
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the trusted local PATH in order.
    }
  }
  return undefined;
};

const localToolContext: TrustedActionContext = {
  provenance: "local_tool",
  resolveExecutable: resolveExecutableFromPath,
};

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
});

const lexicalFallback = (path: string, basePath?: string): string => {
  if (isAbsolute(path)) return normalize(path);
  return basePath === undefined ? path : resolve(basePath, path);
};

const hasPathSeparator = (value: string): boolean => /[\\/]/u.test(value);

const canonicalizeExecutable = (
  executable: string | undefined,
  cwd: string,
  context: TrustedActionContext,
  violations: PolicyPathViolation[],
): string | undefined => {
  if (executable === undefined) return undefined;

  let candidate: string | undefined;
  if (hasPathSeparator(executable)) {
    candidate = isAbsolute(executable) ? executable : resolve(cwd, executable);
  } else {
    try {
      candidate = context.resolveExecutable?.(executable, cwd);
    } catch {
      candidate = undefined;
    }
  }
  if (candidate === undefined || !isAbsolute(candidate)) {
    if (!violations.includes("PATH_UNAVAILABLE")) {
      violations.push("PATH_UNAVAILABLE");
    }
    return executable;
  }
  try {
    const canonical = realpathSync.native(candidate);
    if (!statSync(canonical).isFile())
      throw new Error("not an executable file");
    return canonical;
  } catch {
    if (!violations.includes("PATH_UNAVAILABLE")) {
      violations.push("PATH_UNAVAILABLE");
    }
    return normalize(candidate);
  }
};

const splitPathArgument = (
  value: string,
): { prefix: string; candidate: string } | undefined => {
  const shortOption = /^(-[a-z])(.+)$/iu.exec(value);
  const shortOptionCandidate = shortOption?.[2];
  const isKnownAttachedPathOption = value.startsWith("-C") && value !== "-C";
  const isVisiblyAttachedPathOption =
    shortOptionCandidate !== undefined &&
    (isAbsolute(shortOptionCandidate) ||
      /^\.{1,2}[/\\]/u.test(shortOptionCandidate) ||
      hasPathSeparator(shortOptionCandidate) ||
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(shortOptionCandidate));
  const isAttachedPathOption =
    isKnownAttachedPathOption || isVisiblyAttachedPathOption;
  const separator =
    !isAttachedPathOption && value.startsWith("-") ? value.indexOf("=") : -1;
  const prefix = isAttachedPathOption
    ? (shortOption?.[1] ?? "")
    : separator >= 0
      ? value.slice(0, separator + 1)
      : "";
  const candidate = isAttachedPathOption
    ? (shortOptionCandidate ?? "")
    : separator >= 0
      ? value.slice(separator + 1)
      : value;
  if (isKnownAttachedPathOption && candidate.startsWith("=")) {
    throw new CanonicalPathError("PATH_UNAVAILABLE");
  }
  if (candidate.startsWith("file://")) {
    return { prefix: `${prefix}file://`, candidate: fileURLToPath(candidate) };
  }
  if (candidate.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    if (isAttachedPathOption) {
      throw new CanonicalPathError("PATH_UNAVAILABLE");
    }
    return undefined;
  }
  if (
    /^git@[^:]+:/u.test(candidate) ||
    /^@[^/\\]+[/\\][^/\\]+$/u.test(candidate)
  ) {
    return undefined;
  }
  if (isAttachedPathOption) return { prefix, candidate };
  if (
    !isAbsolute(candidate) &&
    !/^\.{1,2}[/\\]/u.test(candidate) &&
    !hasPathSeparator(candidate)
  ) {
    return undefined;
  }
  return { prefix, candidate };
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

const canonicalizeArgument = (
  root: string,
  value: string,
  cwd: string,
  violations: PolicyPathViolation[],
): string => {
  let pathArgument: ReturnType<typeof splitPathArgument>;
  try {
    pathArgument = splitPathArgument(value);
  } catch {
    if (!violations.includes("PATH_UNAVAILABLE")) {
      violations.push("PATH_UNAVAILABLE");
    }
    return value;
  }
  if (pathArgument === undefined) return value;
  try {
    return `${pathArgument.prefix}${canonicalizePath(
      root,
      pathArgument.candidate,
      {
        basePath: cwd,
      },
    )}`;
  } catch (error) {
    addViolation(violations, error);
    return `${pathArgument.prefix}${lexicalFallback(pathArgument.candidate, cwd)}`;
  }
};

const canonicalizeArguments = (
  root: string,
  argv: readonly string[],
  cwd: string,
  violations: PolicyPathViolation[],
): readonly string[] => {
  const canonical: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (value !== "-C") {
      canonical.push(canonicalizeArgument(root, value, cwd, violations));
      continue;
    }

    canonical.push(value);
    const path = argv[index + 1];
    if (path === undefined || path.startsWith("-")) {
      if (!violations.includes("PATH_UNAVAILABLE")) {
        violations.push("PATH_UNAVAILABLE");
      }
      continue;
    }
    const attached = canonicalizeArgument(root, `-C${path}`, cwd, violations);
    canonical.push(attached.slice(2));
    index += 1;
  }
  return canonical;
};

/**
 * Canonicalize all path-bearing fields. The returned violations are retained
 * instead of being thrown so an unsafe action produces a normal denied policy
 * decision with a deterministic fingerprint.
 */
export function canonicalizeAction(
  action: unknown,
  source?: RepositoryPolicySource | ActionPolicyOptions,
  context: TrustedActionContext = localToolContext,
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
      input.externalSideEffect === "purchase");
  if (!validAction) violations.push("UNSTRUCTURED_ACTION");

  if (repository === undefined) {
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

  const canonicalArgv =
    repository === undefined
      ? [...canonical.argv]
      : canonicalizeArguments(
          repository.canonicalPath,
          canonical.argv,
          canonicalCwd,
          violations,
        );
  const canonicalExecutable = canonicalizeExecutable(
    canonical.executable,
    canonicalCwd,
    context,
    violations,
  );

  const normalized: CanonicalAction = {
    ...canonical,
    ...(canonicalExecutable === undefined
      ? {}
      : { executable: canonicalExecutable }),
    argv: canonicalArgv,
    cwd: canonicalCwd,
    touchedPaths: canonicalTouchedPaths,
  };
  return { action: normalized, violations };
}

const canonicalFingerprintRecord = (
  action: CanonicalAction,
  context: TrustedActionContext,
) => ({
  argv: [...action.argv],
  cwd: action.cwd,
  environmentRead: action.environmentRead,
  executable: action.executable ?? null,
  externalSideEffect: action.externalSideEffect,
  fileChange: action.fileChange,
  networkIntent: action.networkIntent,
  provenance: context.provenance,
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
export function canonicalActionJson(
  action: CanonicalAction,
  context: TrustedActionContext = localToolContext,
): string {
  return stableJson(canonicalFingerprintRecord(action, context));
}

/** SHA-256 of the canonical, machine-readable action record. */
export function fingerprintAction(
  action: CanonicalAction,
  context: TrustedActionContext = localToolContext,
): string {
  return createHash("sha256")
    .update(canonicalActionJson(action, context))
    .digest("hex");
}

const lowerTokens = (action: CanonicalAction): string[] =>
  [action.toolName, action.executable ?? "", ...action.argv].map((value) =>
    value.toLowerCase(),
  );

const executableName = (action: CanonicalAction): string => {
  const resolvedName = basename(action.executable ?? "").toLowerCase();
  if (resolvedName === "pnpm.cjs" || resolvedName === "pnpm.mjs") {
    return "pnpm";
  }
  if (resolvedName === "npm-cli.js") return "npm";
  if (resolvedName === "npx-cli.js") return "npx";
  if (resolvedName === "vitest.mjs") return "vitest";
  if (resolvedName === "tsc.js") return "tsc";
  return resolvedName;
};

const hasToken = (tokens: readonly string[], pattern: RegExp): boolean =>
  tokens.some((token) => pattern.test(token));

const denialForCommand = (action: CanonicalAction): string | undefined => {
  const tokens = lowerTokens(action);
  const tool = action.toolName.toLowerCase();
  const command = executableName(action);

  if (
    action.argv.some(
      (argument) =>
        /^(?:&&|\|\||[;&|])$/u.test(argument) ||
        argument.includes("$(") ||
        argument.includes("`"),
    ) ||
    /^(arbitrary[-_ ]?command|cloud[-_ ]?command|shell|exec|execute[-_ ]?command)$/u.test(
      tool,
    ) ||
    /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/u.test(
      command,
    )
  ) {
    return "ARBITRARY_COMMAND";
  }
  if (
    /keychain|credential[-_ ]?store|secret[-_ ]?store/u.test(
      tokens.join(" "),
    ) ||
    command === "security"
  ) {
    return "KEYCHAIN_ACCESS";
  }
  if (
    action.environmentRead === "arbitrary" ||
    hasToken(tokens, /(^|[/_ -])(printenv|env|set|export)([/_ -]|$)/u) ||
    (/^python(?:\d+(?:\.\d+)*)?$/u.test(command) &&
      hasToken(
        tokens,
        /(?:os\.(?:environ|getenv)|process\.env|dotenv|\benviron\b)/u,
      )) ||
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
    command === "defaults" ||
    command === "launchctl" ||
    command === "systemsetup" ||
    command === "networksetup" ||
    command === "scutil" ||
    (command === "osascript" && hasToken(tokens, /-e/u))
  ) {
    return "SYSTEM_SETTINGS";
  }
  return undefined;
};

const approvalForCommand = (action: CanonicalAction): string | undefined => {
  const executable = executableName(action);
  const args = action.argv.map((value) => value.toLowerCase());
  const tool = action.toolName.toLowerCase();
  const packageCommand = /^(npm|pnpm|yarn|bun|pip|pip3|cargo|brew)$/u.test(
    executable,
  );
  if (
    tool === "package_install" ||
    (packageCommand &&
      args.some((argument) =>
        /^(install|ci|i|add|remove|rm|update|upgrade|link)$/u.test(argument),
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
    /(^|[-_ ])deploy($|[-_ ])/u.test(tool) ||
    (executable === "vercel" && args.includes("deploy")) ||
    (/^(npx|npm|pnpm)$/u.test(executable) &&
      args.includes("vercel") &&
      args.includes("deploy"))
  ) {
    return "DEPLOY";
  }
  if (action.networkIntent === "write") return "NETWORK_WRITE";
  if (action.externalSideEffect === "message") return "EXTERNAL_MESSAGE";
  if (action.externalSideEffect === "purchase") return "PURCHASE";
  if (action.fileChange === "destructive") return "DESTRUCTIVE_FILE_CHANGE";
  return undefined;
};

const automaticFlagsAreSafe = (action: CanonicalAction): boolean =>
  action.environmentRead === "none" &&
  action.networkIntent === "none" &&
  action.externalSideEffect === "none";

const packageScriptMatches = (
  executable: string,
  argv: readonly string[],
  script: "test" | "build",
): boolean => {
  if (!/^(npm|pnpm|yarn|bun)$/u.test(executable)) return false;
  const command = argv[0]?.toLowerCase();
  const argument = argv[1]?.toLowerCase();
  if (command === script) return true;
  return (command === "run" || command === "run-script") && argument === script;
};

const searchExecutableMatches = (action: CanonicalAction): boolean => {
  if (action.executable === undefined) return true;
  const tool = action.toolName.toLowerCase();
  const executable = executableName(action);
  if (
    executable === "rg" &&
    action.argv.some((argument) => /^--pre(?:=|$)/u.test(argument))
  ) {
    return false;
  }
  if (tool === "grep") return executable === "grep";
  if (tool === "ripgrep") return executable === "rg";
  if (tool === "search") return executable === "grep" || executable === "rg";
  return false;
};

const runnerExecutableMatches = (
  action: CanonicalAction,
  kind: "test" | "build",
): boolean => {
  if (action.executable === undefined) return false;
  const executable = executableName(action);
  if (packageScriptMatches(executable, action.argv, kind)) return true;
  if (kind === "test") {
    return executable === "vitest" && action.argv[0]?.toLowerCase() === "run";
  }
  return executable === "tsc";
};

const automaticReason = (action: CanonicalAction): string | undefined => {
  const tool = action.toolName.toLowerCase();
  if (!automaticFlagsAreSafe(action)) return undefined;
  if (
    /^(search|find|grep|ripgrep)$/u.test(tool) &&
    action.fileChange === "none" &&
    searchExecutableMatches(action)
  ) {
    return "SEARCH";
  }
  if (
    /^(test|tests|run[-_ ]?tests?)$/u.test(tool) &&
    action.fileChange === "none" &&
    runnerExecutableMatches(action, "test")
  ) {
    return "TEST";
  }
  if (
    /^(build|compile)$/u.test(tool) &&
    action.fileChange === "none" &&
    runnerExecutableMatches(action, "build")
  ) {
    return "BUILD";
  }
  if (
    /^(edit_file|write_file|apply_patch)$/u.test(tool) &&
    action.fileChange === "bounded" &&
    action.executable === undefined
  ) {
    return "BOUNDED_EDIT";
  }
  if (
    /^(read_file|read|file_read)$/u.test(tool) &&
    action.fileChange === "none" &&
    action.executable === undefined
  ) {
    return "READ_ONLY";
  }
  return undefined;
};

const isKnownApprovalTool = (toolName: string): boolean =>
  /^(package_install|git_push|deploy|network_write|external_message|send_message|delete_file|remove_file)$/u.test(
    toolName.toLowerCase(),
  );

const isKnownTool = (toolName: string): boolean =>
  /^(read_file|read|file_read|search|find|grep|ripgrep|test|tests|run[-_ ]?tests?|build|compile|edit_file|write_file|apply_patch)$/u.test(
    toolName.toLowerCase(),
  ) || isKnownApprovalTool(toolName);

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
  context: TrustedActionContext = localToolContext,
): PolicyDecision {
  const validContext =
    isRecord(context) &&
    (context.provenance === "local_tool" ||
      context.provenance === "cloud_command") &&
    (context.resolveExecutable === undefined ||
      typeof context.resolveExecutable === "function");
  const trustedContext =
    validContext &&
    (context.provenance === "local_tool" ||
      context.provenance === "cloud_command")
      ? (context as TrustedActionContext)
      : localToolContext;
  const canonical = canonicalizeAction(action, source, trustedContext);
  const fingerprint = fingerprintAction(canonical.action, trustedContext);
  if (!validContext) {
    return decision("denied", "UNTRUSTED_ACTION", fingerprint);
  }
  if (trustedContext.provenance === "cloud_command") {
    return decision("denied", "ARBITRARY_COMMAND", fingerprint);
  }
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
  if (!isKnownTool(canonical.action.toolName)) {
    return decision("denied", "UNKNOWN_TOOL", fingerprint);
  }
  const approval = approvalForCommand(canonical.action);
  if (approval !== undefined) {
    return decision("approval_required", approval, fingerprint);
  }
  const automatic = automaticReason(canonical.action);
  if (automatic === undefined) {
    return decision(
      "denied",
      canonical.action.executable === undefined
        ? "UNCLASSIFIED_ACTION"
        : "EXECUTABLE_TOOL_MISMATCH",
      fingerprint,
    );
  }
  return decision("automatic", automatic, fingerprint);
}

export { stableJson };
