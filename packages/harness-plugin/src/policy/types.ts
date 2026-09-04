export type PolicyClass = "automatic" | "approval_required" | "denied";

export type CanonicalAction = {
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
  /** Set only for commands whose text came directly from the cloud. */
  commandSource?: "local" | "cloud";
};

export type PolicyDecision = {
  classification: PolicyClass;
  fingerprint: string;
  reasonCode: string;
  actionSummary: string;
  impactSummary: string;
};

export type RepositoryPolicy = Readonly<{
  id: string;
  canonicalPath: string;
}>;

export type RepositoryPolicySource =
  | ReadonlyArray<RepositoryPolicy>
  | ReadonlyMap<string, string | RepositoryPolicy>;

export type PolicyPathViolation =
  | "PATH_NOT_ABSOLUTE"
  | "PATH_TRAVERSAL"
  | "PATH_OUTSIDE_REPOSITORY"
  | "SYMLINK_ESCAPE"
  | "PATH_CHANGED"
  | "PATH_UNAVAILABLE"
  | "ROOT_NOT_CANONICAL"
  | "UNKNOWN_REPOSITORY"
  | "UNSTRUCTURED_ACTION";

export type CanonicalActionResult = Readonly<{
  action: CanonicalAction;
  violations: readonly PolicyPathViolation[];
}>;

export type PolicyToolExecution = Readonly<{
  name: string;
  arguments: unknown;
}>;

export type PolicyGuard = (
  execution: Readonly<PolicyToolExecution>,
) => string | undefined;

export type PolicyPreExecuteListener = (
  execution: Readonly<PolicyToolExecution>,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export type PolicyScopeContext = Readonly<{
  tools: Readonly<{
    guard(guard: PolicyGuard): () => void;
  }>;
  on(
    name: "tools/pre-execute",
    listener: PolicyPreExecuteListener,
    options?: Readonly<{ before?: boolean }> | boolean,
  ): () => boolean | undefined;
}>;
