export const DOMAIN_ERROR_CODES = [
  "CONNECTOR_OFFLINE",
  "REPOSITORY_NOT_ALLOWED",
  "JOB_NOT_FOUND",
  "JOB_NOT_MUTABLE",
  "IDEMPOTENCY_CONFLICT",
  "APPROVAL_EXPIRED",
  "APPROVAL_MISMATCH",
  "POLICY_DENIED",
  "HARNESS_FAILED",
  "TASK_TIMEOUT",
  "CONNECTOR_LOST",
  "RATE_LIMITED",
  "INTERNAL",
  "REVISION_CONFLICT",
  "UNAUTHENTICATED",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

const PUBLIC_MESSAGES: Record<DomainErrorCode, string> = {
  CONNECTOR_OFFLINE: "The connector is offline.",
  REPOSITORY_NOT_ALLOWED: "The repository is not available for this owner.",
  JOB_NOT_FOUND: "The task was not found.",
  JOB_NOT_MUTABLE: "The task cannot be changed in its current state.",
  IDEMPOTENCY_CONFLICT:
    "The request key was already used for a different task.",
  APPROVAL_EXPIRED: "The approval has expired.",
  APPROVAL_MISMATCH: "The approval no longer matches the task.",
  POLICY_DENIED: "The repository policy denied this operation.",
  HARNESS_FAILED: "The task failed in the Harness runtime.",
  TASK_TIMEOUT: "The task exceeded its time limit.",
  CONNECTOR_LOST: "The connector connection was lost.",
  RATE_LIMITED: "Too many requests.",
  INTERNAL: "The control plane could not complete the request.",
  REVISION_CONFLICT: "The task was changed; refresh it and try again.",
  UNAUTHENTICATED: "Authentication is required.",
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, _unsafeMessage?: string) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "DomainError";
    this.code = code;
  }
}

export const isDomainErrorCode = (value: unknown): value is DomainErrorCode =>
  typeof value === "string" &&
  (DOMAIN_ERROR_CODES as readonly string[]).includes(value);

export const publicMessageFor = (code: DomainErrorCode): string =>
  PUBLIC_MESSAGES[code];
