import type { TrustedPolicyAction } from "./register-guard.js";
import type { CanonicalAction } from "./types.js";

export type DeclaredToolRole = "command" | "read" | "write" | "search";

/** Explicit, minimal, plugin-declared tool set. Only these names are
 * classifiable; every other host tool fails closed in the guard. */
export const DECLARED_TOOL_ROLES: Readonly<Record<string, DeclaredToolRole>> =
  Object.freeze({
    bash: "command",
    read: "read",
    write: "write",
    edit: "write",
    grep: "search",
    glob: "search",
  });

export type TrustedExecutionAdapterOptions = Readonly<{
  repositoryId: string;
  repositoryRoot: string;
  declaredTools?: Readonly<Record<string, DeclaredToolRole>>;
}>;

export type TrustedExecution = Readonly<{ name: string; arguments: unknown }>;

// Allow-listed simple commands only: no shell metacharacters, quoting,
// substitutions or environment assignments. Anything else fails closed.
const SAFE_COMMAND = /^[A-Za-z0-9_./:@,+-]+(?:\s+[A-Za-z0-9_./:@,+-]+)*$/u;

const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return value as Record<string, unknown>;
};

const stringField = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const commandAction = (
  execution: TrustedExecution,
  options: TrustedExecutionAdapterOptions,
): CanonicalAction | undefined => {
  const record = plainRecord(execution.arguments);
  if (record === undefined) return undefined;
  const command = stringField(record, "command");
  if (command === undefined || !SAFE_COMMAND.test(command)) return undefined;
  const tokens = command.split(/\s+/u).filter((token) => token.length > 0);
  const [executable, ...argv] = tokens;
  if (executable === undefined) return undefined;
  return {
    toolName: execution.name,
    executable,
    argv,
    cwd: options.repositoryRoot,
    repositoryId: options.repositoryId,
    touchedPaths: [],
    environmentRead: "none",
    networkIntent: "none",
    fileChange: "none",
    externalSideEffect: "none",
  };
};

const fileAction = (
  execution: TrustedExecution,
  options: TrustedExecutionAdapterOptions,
  fileChange: CanonicalAction["fileChange"],
  requirePath: boolean,
): CanonicalAction | undefined => {
  const record = plainRecord(execution.arguments);
  if (record === undefined) return undefined;
  const path = stringField(record, "path");
  if (path === undefined && (requirePath || Object.hasOwn(record, "path")))
    return undefined;
  return {
    toolName: execution.name,
    argv: [],
    cwd: options.repositoryRoot,
    repositoryId: options.repositoryId,
    touchedPaths: path === undefined ? [] : [path],
    environmentRead: "none",
    networkIntent: "none",
    fileChange,
    externalSideEffect: "none",
  };
};

/** Map one declared Harness tool call to its canonical action. The repository
 * identity and root come from the Agent composition, never from tool input.
 * Undeclared, malformed or ambiguous calls return undefined so the guard denies
 * them; there is no generic fallback. */
export function createTrustedExecutionAdapter(
  options: TrustedExecutionAdapterOptions,
): (execution: TrustedExecution) => TrustedPolicyAction | undefined {
  const roles = options.declaredTools ?? DECLARED_TOOL_ROLES;
  return (execution) => {
    try {
      if (typeof execution?.name !== "string") return undefined;
      const role = roles[execution.name];
      if (role === undefined) return undefined;
      const action =
        role === "command"
          ? commandAction(execution, options)
          : role === "read"
            ? fileAction(execution, options, "none", true)
            : role === "write"
              ? fileAction(execution, options, "bounded", true)
              : fileAction(execution, options, "none", false);
      if (action === undefined) return undefined;
      return { action: Object.freeze(action), provenance: "local_tool" };
    } catch {
      return undefined;
    }
  };
}
