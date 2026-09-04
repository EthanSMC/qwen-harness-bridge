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
  | "UNSTRUCTURED_ACTION"
  | "UNSUPPORTED_ARGUMENTS"
  | "PROTECTED_RESOURCE";

export type CanonicalActionResult = Readonly<{
  action: CanonicalAction;
  violations: readonly PolicyPathViolation[];
  destructive: boolean;
  administrative: "install" | "push" | "deploy" | undefined;
}>;
