import { safePublicText } from "./ai-issue-policy.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u;
const MAX_ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export class LifecycleRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "LifecycleRegistryError";
  }
}

const fail = (message) => {
  throw new LifecycleRegistryError(message);
};

const requireExactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has unknown or missing fields`);
  }
};

const requirePositiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
};

export const requireRegistryTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail(`${label} must be a GitHub UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) fail(`${label} must be a valid timestamp`);
  const normalized = new Date(timestamp).toISOString();
  if (normalized !== value && normalized.replace(".000Z", "Z") !== value) {
    fail(`${label} must be a real canonical timestamp`);
  }
  return timestamp;
};

const requirePublicReason = (value, label) => {
  try {
    safePublicText(value, 240);
  } catch {
    fail(`${label} is unsafe`);
  }
};

const validateApproval = (value, label) => {
  if (!LOGIN.test(value ?? "")) fail(`${label} approver is invalid`);
};

const validateMigrationEntry = (entry, index) => {
  const label = `Migration entry ${index + 1}`;
  requireExactKeys(
    entry,
    ["approved_by", "expires_at", "issue", "pull_request", "reason"],
    label,
  );
  requirePositiveInteger(entry.pull_request, `${label} pull request`);
  requirePositiveInteger(entry.issue, `${label} Issue`);
  requirePublicReason(entry.reason, `${label} reason`);
  validateApproval(entry.approved_by, label);
  requireRegistryTimestamp(entry.expires_at, `${label} expiry`);
};

const validateAcceptance = (acceptance, nowTimestamp) => {
  if (acceptance === null) return;
  requireExactKeys(
    acceptance,
    ["approved_at", "approved_by", "expires_at", "reason"],
    "Mutation acceptance",
  );
  requirePublicReason(acceptance.reason, "Mutation acceptance reason");
  validateApproval(acceptance.approved_by, "Mutation acceptance");
  const approvedAt = requireRegistryTimestamp(
    acceptance.approved_at,
    "Mutation acceptance approval",
  );
  const expiresAt = requireRegistryTimestamp(
    acceptance.expires_at,
    "Mutation acceptance expiry",
  );
  if (approvedAt > nowTimestamp) {
    fail("Mutation acceptance approval cannot be in the future");
  }
  if (expiresAt <= approvedAt) {
    fail("Mutation acceptance expiry must follow its approval");
  }
  if (expiresAt - approvedAt > MAX_ACCEPTANCE_WINDOW_MS) {
    fail("Mutation acceptance window cannot exceed seven days");
  }
};

export const validateLifecycleRegistry = (registry, { now }) => {
  requireExactKeys(
    registry,
    ["activation_commit", "entries", "mutation_acceptance", "schema_version"],
    "Lifecycle migration registry",
  );
  if (registry.schema_version !== 3) {
    fail("Lifecycle migration registry schema_version must be 3");
  }
  if (!Array.isArray(registry.entries) || registry.entries.length > 100) {
    fail("Lifecycle migration entries must be a bounded array");
  }
  registry.entries.forEach(validateMigrationEntry);
  const nowTimestamp = requireRegistryTimestamp(
    now,
    "Lifecycle validation time",
  );
  validateAcceptance(registry.mutation_acceptance, nowTimestamp);
  if (
    registry.activation_commit !== null &&
    !FULL_SHA.test(registry.activation_commit ?? "")
  ) {
    fail("Lifecycle activation commit must be null or a full commit SHA");
  }
  const pairs = new Set();
  for (const entry of registry.entries) {
    const pair = `${entry.pull_request}:${entry.issue}`;
    if (pairs.has(pair)) fail("Lifecycle migration pairs must be unique");
    pairs.add(pair);
  }
  if (
    registry.activation_commit !== null &&
    (registry.entries.length > 0 || registry.mutation_acceptance !== null)
  ) {
    fail(
      "Activated lifecycle registry forbids migrations and mutation acceptance",
    );
  }
  return {
    activationCommit: registry.activation_commit,
    entries: registry.entries,
    mutationAcceptance: registry.mutation_acceptance,
    nowTimestamp,
  };
};

export const validateLifecycleValidationMode = (
  registry,
  { mode, pullRequestNumber, issueNumber, now },
) => {
  if (!["report", "enforce"].includes(mode)) {
    fail("Lifecycle validation mode must be report or enforce");
  }
  const validated = validateLifecycleRegistry(registry, { now });
  if (mode === "enforce") {
    if (!validated.activationCommit) {
      fail("Strict lifecycle validation requires a full activation commit");
    }
    return { migrated: false, ...validated };
  }
  const migration =
    validated.activationCommit === null
      ? validated.entries.find(
          (entry) =>
            entry.pull_request === pullRequestNumber &&
            entry.issue === issueNumber,
        )
      : null;
  return {
    migrated: Boolean(
      migration && Date.parse(migration.expires_at) > validated.nowTimestamp,
    ),
    ...validated,
  };
};

export const validateLifecycleMutationMode = (registry, { mode, now }) => {
  if (!["report", "enforce"].includes(mode)) {
    fail("Lifecycle mutation mode must be report or enforce");
  }
  const validated = validateLifecycleRegistry(registry, { now });
  if (mode === "report") return { phase: "report", ...validated };
  if (validated.activationCommit) {
    return { phase: "activated", ...validated };
  }
  if (
    validated.mutationAcceptance &&
    Date.parse(validated.mutationAcceptance.expires_at) > validated.nowTimestamp
  ) {
    return { phase: "acceptance", ...validated };
  }
  fail(
    "Lifecycle mutation enforcement requires activation or an unexpired acceptance window",
  );
};
