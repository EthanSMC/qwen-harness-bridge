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
import { parseArguments } from "./argv-policy.js";
import { CanonicalPathError, canonicalizePath } from "./canonical-path.js";
import {
  assertSearchResources,
  isProtectedPath,
  type ProtectedPaths,
  resolveProtectedPaths,
} from "./protected-paths.js";
import { ripgrepCandidates } from "./search-domain.js";
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
  /** Trusted command identity -> immutable canonical executable path. */
  trustedExecutables?: Readonly<Record<string, string>>;
  protectedPaths?: ProtectedPaths;
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
}>;

const resolveExecutableFromPath: TrustedExecutableResolver = (
  executable,
  cwd,
) => {
  for (const searchDirectory of (process.env.PATH ?? "").split(delimiter)) {
    const directory = isAbsolute(searchDirectory)
      ? searchDirectory
      : resolve(cwd, searchDirectory);
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // PATH selects a candidate, but only registration can authorize it.
    }
  }
  return undefined;
};

const localToolContext: TrustedActionContext = {
  provenance: "local_tool",
};

const executableMap = (
  source?: RepositoryPolicySource | ActionPolicyOptions,
): Readonly<Record<string, string>> =>
  source !== undefined && "repositories" in source
    ? (source.trustedExecutables ?? {})
    : {};

/** Copy caller-owned containers so later mutations cannot expand a live guard. */
export function snapshotActionPolicy(
  options: ActionPolicyOptions,
): ActionPolicyOptions {
  const trustedExecutables = Object.freeze({ ...options.trustedExecutables });
  for (const path of Object.values(trustedExecutables)) {
    if (
      !isAbsolute(path) ||
      realpathSync.native(path) !== path ||
      !statSync(path).isFile()
    ) {
      throw new Error("POLICY_EXECUTABLE_NOT_CANONICAL");
    }
  }
  return Object.freeze({
    repositories: Object.freeze(
      asRepositoryArray(options).map((repository) =>
        Object.freeze({ ...repository }),
      ),
    ),
    trustedExecutables,
    protectedPaths: Object.freeze(
      Object.fromEntries(
        Object.entries(options.protectedPaths ?? {}).map(([id, paths]) => [
          id,
          Object.freeze(
            resolveProtectedPaths(
              repositoryFor(options, id)?.canonicalPath ?? "",
              paths,
            ),
          ),
        ]),
      ),
    ),
  });
}

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
  violations: PolicyPathViolation[],
): string | undefined => {
  if (executable === undefined) return undefined;

  let candidate: string | undefined;
  if (hasPathSeparator(executable)) {
    candidate = isAbsolute(executable) ? executable : resolve(cwd, executable);
  } else {
    try {
      candidate = resolveExecutableFromPath(executable, cwd);
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
  _context: TrustedActionContext = localToolContext,
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

  let configured =
    source !== undefined && "repositories" in source
      ? (source.protectedPaths?.[repositoryId] ?? [])
      : [];
  if (repository !== undefined) {
    try {
      configured = resolveProtectedPaths(repository.canonicalPath, configured);
    } catch (error) {
      addViolation(violations, error);
    }
  }
  const resolvePath = (path: string, base = canonicalCwd): string => {
    if (repository === undefined) return lexicalFallback(path, base);
    const lexical = resolve(base, path);
    if (isProtectedPath(repository.canonicalPath, lexical, configured)) {
      violations.push("PROTECTED_RESOURCE");
    }
    const resolved = canonicalizePath(repository.canonicalPath, path, {
      basePath: base,
    });
    if (isProtectedPath(repository.canonicalPath, resolved, configured)) {
      violations.push("PROTECTED_RESOURCE");
    }
    return resolved;
  };
  const canonicalTouchedPaths = canonical.touchedPaths.map((path) => {
    try {
      return resolvePath(path);
    } catch (error) {
      addViolation(violations, error);
      return lexicalFallback(path, canonicalCwd);
    }
  });
  const canonicalExecutable = canonicalizeExecutable(
    canonical.executable,
    canonicalCwd,
    violations,
  );
  const command =
    canonicalExecutable === undefined
      ? undefined
      : (Object.entries(executableMap(source)).find(
          ([, path]) => path === canonicalExecutable,
        )?.[0] ??
        executableName({ ...canonical, executable: canonicalExecutable }));
  let canonicalArgv = [...canonical.argv];
  let destructive = false;
  let administrative: CanonicalActionResult["administrative"];
  try {
    const parsed = parseArguments(
      command,
      canonical.toolName.toLowerCase(),
      canonical.argv,
      resolvePath,
      canonicalCwd,
    );
    canonicalArgv = parsed.argv;
    destructive = parsed.destructive;
    administrative = parsed.administrative;
    if (command === "rg" && !parsed.noConfig && process.env.RIPGREP_CONFIG_PATH)
      throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
    if (parsed.search === "content" && command === "rg") {
      // Basenames and per-execution fields must never authorize a subprocess.
      if (
        canonicalExecutable !== executableMap(source).rg ||
        canonicalExecutable === undefined
      )
        throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
      if (violations.length === 0)
        canonicalTouchedPaths.push(
          ...ripgrepCandidates(
            canonicalExecutable,
            canonicalCwd,
            parsed.selection,
            parsed.searchOperands,
            resolvePath,
          ),
        );
    } else if (parsed.search === "content" && repository !== undefined)
      assertSearchResources(repository.canonicalPath, parsed.paths, configured);
    if (
      command === undefined &&
      /^(search|find|grep|ripgrep)$/u.test(canonical.toolName.toLowerCase()) &&
      (canonicalTouchedPaths.length === 0 ||
        canonicalTouchedPaths.some((path) => !statSync(path).isFile()))
    )
      throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
  } catch (error) {
    addViolation(violations, error);
  }

  const normalized: CanonicalAction = {
    ...canonical,
    ...(canonicalExecutable === undefined
      ? {}
      : { executable: canonicalExecutable }),
    argv: canonicalArgv,
    cwd: canonicalCwd,
    touchedPaths: [...new Set(canonicalTouchedPaths)].sort(),
  };
  return { action: normalized, violations, destructive, administrative };
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

const denialForCommand = (action: CanonicalAction): string | undefined => {
  const tool = action.toolName.toLowerCase();
  const command = executableName(action);
  if (
    /^(arbitrary[-_ ]?command|cloud[-_ ]?command|shell|exec|execute[-_ ]?command)$/u.test(
      tool,
    ) ||
    /^(sh|bash|zsh|fish|dash|ksh|csh|tcsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/u.test(
      command,
    )
  )
    return "ARBITRARY_COMMAND";
  if (
    /^(keychain(?:_read)?|credential_store|secret_store)$/u.test(tool) ||
    command === "security"
  )
    return "KEYCHAIN_ACCESS";
  if (action.environmentRead === "arbitrary") return "ENVIRONMENT_ARBITRARY";
  if (
    /^(env|printenv|secret_read|environment_dump)$/u.test(tool) ||
    /^(env|printenv)$/u.test(command)
  )
    return "SECRET_ACCESS";
  if (
    /^python(?:\d+(?:\.\d+)*)?$/u.test(command) &&
    action.argv.some((arg) => /os\.(?:environ|getenv)/u.test(arg))
  )
    return "SECRET_ACCESS";
  if (
    /^(system_settings|system_preferences)$/u.test(tool) ||
    [
      "defaults",
      "launchctl",
      "systemsetup",
      "networksetup",
      "scutil",
      "osascript",
    ].includes(command)
  )
    return "SYSTEM_SETTINGS";
  return undefined;
};

const approvalForCommand = (
  action: CanonicalAction,
  semantics: Pick<CanonicalActionResult, "destructive" | "administrative">,
): string | undefined => {
  const tool = action.toolName.toLowerCase();
  if (semantics.destructive) return "DESTRUCTIVE_FILE_CHANGE";
  if (tool === "package_install" || semantics.administrative === "install") {
    return "PACKAGE_INSTALL";
  }
  if (tool === "git_push" || semantics.administrative === "push") {
    return "GIT_PUSH";
  }
  if (
    action.externalSideEffect === "deploy" ||
    /(^|[-_ ])deploy($|[-_ ])/u.test(tool) ||
    semantics.administrative === "deploy"
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

const automaticReason = (
  action: CanonicalAction,
  source: RepositoryPolicySource | ActionPolicyOptions | undefined,
): string | undefined => {
  const tool = action.toolName.toLowerCase();
  if (!automaticFlagsAreSafe(action)) return undefined;
  if (action.executable !== undefined) {
    const identity = Object.entries(executableMap(source)).find(
      ([, path]) => isAbsolute(path) && path === action.executable,
    )?.[0];
    if (identity === undefined) return undefined;
    // Only registration assigns command semantics; a basename grants no trust.
    action = { ...action, executable: identity };
  }
  if (
    /^(search|find|grep|ripgrep)$/u.test(tool) &&
    action.fileChange === "none" &&
    searchExecutableMatches(action)
  ) {
    return "SEARCH";
  }
  if (
    /^(test|tests|run[-_ ]?tests?)$/u.test(tool) &&
    action.fileChange !== "destructive" &&
    runnerExecutableMatches(action, "test")
  ) {
    return "TEST";
  }
  if (
    /^(build|compile)$/u.test(tool) &&
    action.fileChange !== "destructive" &&
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
      context.provenance === "cloud_command");
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
  const approval = approvalForCommand(canonical.action, canonical);
  if (approval !== undefined) {
    return decision("approval_required", approval, fingerprint);
  }
  const automatic = automaticReason(canonical.action, source);
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
