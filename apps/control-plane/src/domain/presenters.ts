import type { ConnectorHealth, JobStatus, JobSummary } from "@qhb/protocol";

const MAX_ITEMS = 5;
const MAX_TITLE_CODE_POINTS = 40;
const MAX_STAGE_CODE_POINTS = 36;
const MAX_DETAIL_CODE_POINTS = 600;
const MAX_SPOKEN_CODE_POINTS = 120;
const MAX_ARTIFACT_URL_BYTES = 2048;
const MAX_STRUCTURED_TEXT_BYTES = 8_192;
const MAX_STRUCTURED_DEPTH = 8;
const MAX_STRUCTURED_ITEMS = 25;

export type RepositoryDisplay = {
  displayName?: string | null;
  canonicalPath?: string | null;
};

export type PresentableJob = {
  jobId: string;
  shortId: string;
  ownerId?: string;
  repositoryId?: string;
  status: JobStatus;
  currentStage: string;
  revision: number;
  title: string | null;
  unreadTerminal: boolean;
  updatedAt: Date;
  connectorHealth?: ConnectorHealth;
  summary?: Record<string, unknown> | null;
};

export type PresentableEvent = {
  sequence: number;
  type: string;
  payload?: Record<string, unknown>;
  createdAt: Date;
};

export type PresentableApproval = {
  approvalId: string;
  jobId?: string;
  jobShortId?: string | null;
  jobRevision: number;
  actionSummary: string;
  impactSummary: string;
  riskClass: string;
  expiresAt: Date;
  decision?: "approve" | "reject" | null;
  decidedAt?: Date | null;
};

export type PresentableResult = {
  jobId?: string;
  summary: string;
  changedFiles: string[];
  tests: {
    passed: number;
    failed: number;
    summary: string;
  };
  artifacts: Array<{
    name: string;
    mediaType: string;
    url: string;
  }>;
  acknowledgedAt: Date | null;
};

export type PublicApproval = {
  approval_id: string;
  job_id?: string;
  job_short_id: string;
  job_revision: number;
  action_summary: string;
  impact_summary: string;
  risk_class: string;
  expires_at: string;
};

export type PublicTaskResult = {
  job_id?: string;
  summary: string;
  changed_files: string[];
  tests: {
    passed: number;
    failed: number;
    summary: string;
  };
  artifacts: Array<{
    name: string;
    media_type: string;
    url: string;
  }>;
  acknowledged_at: string | null;
};

export type PublicTaskDetail = {
  job_id: string;
  title: string;
  repository: string;
  status: JobStatus;
  current_stage: string;
  freshness: ConnectorHealth;
  revision: number;
  text: string;
  recent_events: Array<{
    sequence: number;
    type: string;
    current_stage?: string;
    detail?: string;
    changed_files?: string[];
    created_at: string;
  }>;
  pending_approval: PublicApproval | null;
  terminal_summary: string | null;
};

const asDate = (value: Date): string => value.toISOString();

/** Truncate by Unicode code point, never by UTF-16 code unit. */
export const truncateUnicode = (
  value: string,
  maxCodePoints: number,
): string =>
  maxCodePoints <= 0 ? "" : Array.from(value).slice(0, maxCodePoints).join("");

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
};

const boundedText = (
  value: string | null | undefined,
  maxCodePoints: number,
  maxBytes?: number,
): string => {
  const truncated = truncateUnicode(value?.trim() || "", maxCodePoints);
  return maxBytes === undefined ? truncated : truncateUtf8(truncated, maxBytes);
};

const RAW_LOG_PREFIX =
  /^\s*(?:\[\s*)?raw(?:[-_\s]+connector)?[-_\s]+logs?(?:\s*\])?\s*(?::|=|-)?/iu;
const SENSITIVE_KEY =
  /(?:password|token|secret|api[-_]?key|credential|authorization|bearer|raw[-_]?log)/iu;
const AUTHORIZATION_ASSIGNMENT =
  /(["']?)(authorization)\1\s*([:=])\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|bearer\s+[^\s,;}\]]+|[^\s,;}\]]+)/giu;
const SECRET_ASSIGNMENT =
  /(["']?)(api[-_\s]?key|token|credential|password|secret)\1\s*([:=])\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/giu;
const BEARER_TOKEN =
  /\bbearer\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/giu;

const redactedAssignment = (
  _match: string,
  quote: string,
  key: string,
  separator: string,
  rawValue: string,
): string => {
  const value = rawValue.startsWith('"')
    ? '"[redacted]"'
    : rawValue.startsWith("'")
      ? "'[redacted]'"
      : "[redacted]";
  return `${quote}${key}${quote}${separator}${value}`;
};

const redactSensitiveValues = (value: string): string => {
  if (RAW_LOG_PREFIX.test(value)) return "[redacted raw log]";
  return value
    .replace(AUTHORIZATION_ASSIGNMENT, redactedAssignment)
    .replace(SECRET_ASSIGNMENT, redactedAssignment)
    .replace(BEARER_TOKEN, "Bearer [redacted]");
};

type RedactedStructuredValue = { value: unknown; changed: boolean };

const redactStructuredValue = (
  value: unknown,
  depth = 0,
): RedactedStructuredValue => {
  if (typeof value === "string") {
    const redacted = redactSensitiveValues(value);
    return { value: redacted, changed: redacted !== value };
  }
  if (depth > MAX_STRUCTURED_DEPTH) {
    return { value: "[redacted]", changed: true };
  }
  if (Array.isArray(value)) {
    let changed = value.length > MAX_STRUCTURED_ITEMS;
    const redacted = value.slice(0, MAX_STRUCTURED_ITEMS).map((item) => {
      const result = redactStructuredValue(item, depth + 1);
      changed ||= result.changed;
      return result.value;
    });
    if (value.length > MAX_STRUCTURED_ITEMS) redacted.push("[redacted]");
    return { value: redacted, changed };
  }
  if (typeof value !== "object" || value === null) {
    return { value, changed: false };
  }

  let changed = false;
  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_STRUCTURED_ITEMS)) {
    if (SENSITIVE_KEY.test(key)) {
      redacted[key] = "[redacted]";
      changed = true;
      continue;
    }
    const result = redactStructuredValue(item, depth + 1);
    redacted[key] = result.value;
    changed ||= result.changed;
  }
  if (entries.length > MAX_STRUCTURED_ITEMS) {
    redacted._truncated = "[redacted]";
    changed = true;
  }
  return { value: redacted, changed };
};

const redactStructuredSensitiveText = (value: string): string => {
  const trimmed = value.trim();
  if (
    new TextEncoder().encode(trimmed).byteLength <= MAX_STRUCTURED_TEXT_BYTES &&
    (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const result = redactStructuredValue(parsed);
      if (result.changed) return JSON.stringify(result.value);
    } catch {
      // Fall through to the assignment redactor for JSON-like text.
    }
  }
  return redactSensitiveValues(value);
};

const quotePairs: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
};

const PATH_BOUNDARIES = new Set([
  "(",
  '"',
  "'",
  "`",
  "[",
  "]",
  "{",
  "}",
  "“",
  "”",
  "‘",
  "’",
  "（",
  "【",
  "=",
  ":",
]);

const isPathBoundary = (value: string | undefined): boolean =>
  value === undefined || /\s/u.test(value) || PATH_BOUNDARIES.has(value);

const hasWebSchemeBefore = (value: string, index: number): boolean =>
  /https?:$/iu.test(value.slice(Math.max(0, index - 8), index));

const absolutePathStart = (value: string, index: number): boolean => {
  if (!isPathBoundary(value[index - 1])) return false;
  const current = value[index];
  const next = value[index + 1];
  const afterNext = value[index + 2];
  if (current === "/") {
    return !hasWebSchemeBefore(value, index);
  }
  if (current === "\\" && next === "\\") return true;
  return (
    current !== undefined &&
    /^[A-Za-z]$/.test(current) &&
    next === ":" &&
    (afterNext === "/" || afterNext === "\\")
  );
};

/**
 * Free text has no reliable path grammar. Once an unquoted absolute path is
 * detected, redact to the end of that line; quoted paths redact through their
 * closing quote. This deliberately favours confidentiality over preserving a
 * potentially ambiguous suffix and covers Unicode and whitespace segments.
 */
const redactAbsolutePathText = (value: string): string => {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    if (!absolutePathStart(value, cursor)) {
      output += value[cursor];
      cursor += 1;
      continue;
    }

    output += "[redacted path]";
    const openingQuote = value[cursor - 1];
    const closingQuote =
      openingQuote === undefined ? undefined : quotePairs[openingQuote];
    if (closingQuote !== undefined) {
      const closingIndex = value.indexOf(closingQuote, cursor);
      cursor = closingIndex < 0 ? value.length : closingIndex;
      continue;
    }

    const lineBreak = value.indexOf("\n", cursor);
    cursor = lineBreak < 0 ? value.length : lineBreak;
  }
  return output;
};

const publicFreeText = (
  value: string | null | undefined,
  maxCodePoints: number,
  maxBytes?: number,
): string =>
  boundedText(
    redactAbsolutePathText(redactStructuredSensitiveText(value?.trim() || "")),
    maxCodePoints,
    maxBytes,
  );

const safeTitle = (value: string | null | undefined): string =>
  publicFreeText(value, MAX_TITLE_CODE_POINTS, 40) || "Untitled task";

const safeStage = (value: string | null | undefined): string =>
  publicFreeText(value, MAX_STAGE_CODE_POINTS, 36) || "Unknown stage";

const safeDetail = (value: string | null | undefined): string =>
  publicFreeText(value, MAX_DETAIL_CODE_POINTS);

const isAbsolutePath = (value: string): boolean =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//, "");

const safeRepositoryRelativePath = (value: string): string | null => {
  const segments = value.split("/");
  return value.length > 0 &&
    !value.startsWith("/") &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
    ? value
    : null;
};

const relativeRepositoryPath = (
  value: string,
  repository: RepositoryDisplay,
): string | null => {
  const normalized = normalizePath(value.trim());
  const canonical = normalizePath(
    repository.canonicalPath?.trim() || "",
  ).replace(/\/$/, "");

  if (isAbsolutePath(normalized)) {
    if (
      canonical.length === 0 ||
      (normalized !== canonical && !normalized.startsWith(`${canonical}/`))
    ) {
      return null;
    }
    const relative = normalized.slice(canonical.length).replace(/^\/+/, "");
    return safeRepositoryRelativePath(relative);
  }

  return safeRepositoryRelativePath(normalized);
};

const publicChangedFiles = (
  values: unknown,
  repository: RepositoryDisplay,
): string[] => {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => relativeRepositoryPath(value, repository))
    .filter((value): value is string => value !== null)
    .map((value) => truncateUtf8(truncateUnicode(value, 512), 2048))
    .filter((value) => value.length > 0)
    .slice(0, MAX_ITEMS);
};

const publicEvent = (
  event: PresentableEvent,
  repository: RepositoryDisplay,
): PublicTaskDetail["recent_events"][number] => {
  const payload = event.payload ?? {};
  const output: PublicTaskDetail["recent_events"][number] = {
    sequence: event.sequence,
    type: publicFreeText(event.type, 64) || "event",
    created_at: asDate(event.createdAt),
  };

  const stage = payload.stage ?? payload.current_stage;
  if (typeof stage === "string") output.current_stage = safeStage(stage);
  if (typeof payload.detail === "string") {
    output.detail = safeDetail(payload.detail);
  }
  const changedFiles = publicChangedFiles(payload.changed_files, repository);
  if (changedFiles.length > 0) output.changed_files = changedFiles;
  return output;
};

const publicApproval = (approval: PresentableApproval): PublicApproval => ({
  approval_id: approval.approvalId,
  ...(approval.jobId === undefined ? {} : { job_id: approval.jobId }),
  job_short_id: boundedText(approval.jobShortId, 7) || "unknown",
  job_revision: approval.jobRevision,
  action_summary: safeDetail(approval.actionSummary),
  impact_summary: safeDetail(approval.impactSummary),
  risk_class: publicFreeText(approval.riskClass, 64) || "unknown",
  expires_at: asDate(approval.expiresAt),
});

export const presentJobList = (jobs: readonly PresentableJob[]): JobSummary[] =>
  jobs.slice(0, MAX_ITEMS).map((job) => ({
    short_id: job.shortId,
    title: safeTitle(job.title),
    status: job.status,
    current_stage: safeStage(job.currentStage),
    freshness: job.connectorHealth ?? "offline",
    unread_terminal: job.unreadTerminal,
    updated_at: asDate(job.updatedAt),
  }));

export const presentJobDetail = (input: {
  job: PresentableJob;
  repository?: RepositoryDisplay | null;
  events: readonly PresentableEvent[];
  pendingApproval: PresentableApproval | null;
  terminalSummary: string | { summary?: unknown } | null;
  connectorHealth?: ConnectorHealth;
}): PublicTaskDetail => {
  const repository = input.repository ?? {};
  const title = safeTitle(input.job.title);
  const stage = safeStage(input.job.currentStage);
  const recentEvents = [...input.events]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_ITEMS)
    .map((event) => publicEvent(event, repository));
  const terminalText =
    typeof input.terminalSummary === "string"
      ? input.terminalSummary
      : input.terminalSummary !== null &&
          typeof input.terminalSummary.summary === "string"
        ? input.terminalSummary.summary
        : null;
  const terminalSummary =
    terminalText === null ? null : safeDetail(terminalText);
  const eventText = recentEvents
    .flatMap((event) => [event.current_stage, event.detail])
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const text = safeDetail(
    [title, stage, eventText, terminalSummary ?? ""].filter(Boolean).join(" "),
  );

  return {
    job_id: input.job.jobId,
    title,
    repository:
      publicFreeText(repository.displayName, 120) ||
      input.job.repositoryId ||
      "Unknown repository",
    status: input.job.status,
    current_stage: stage,
    freshness: input.job.connectorHealth ?? input.connectorHealth ?? "offline",
    revision: input.job.revision,
    text,
    recent_events: recentEvents,
    pending_approval:
      input.pendingApproval === null
        ? null
        : publicApproval(input.pendingApproval),
    terminal_summary: terminalSummary,
  };
};

export const presentPendingApprovals = (
  approvals: readonly PresentableApproval[],
): PublicApproval[] => approvals.slice(0, MAX_ITEMS).map(publicApproval);

/**
 * Artifact hosts are intentionally not allowlisted because no host policy is
 * configured. Instead, fail closed on every URL feature that can carry hidden
 * authority or credentials and publish only plain, bounded HTTPS URLs.
 */
const publicArtifactUrl = (raw: string): string | null => {
  const value = raw.trim();
  const hasControlOrWhitespace = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
  if (
    value.length === 0 ||
    value !== raw ||
    new TextEncoder().encode(value).byteLength > MAX_ARTIFACT_URL_BYTES ||
    Array.from(value).length > MAX_ARTIFACT_URL_BYTES ||
    hasControlOrWhitespace ||
    /%(?![0-9a-f]{2})/iu.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    const normalized = parsed.toString();
    return new TextEncoder().encode(normalized).byteLength <=
      MAX_ARTIFACT_URL_BYTES
      ? normalized
      : null;
  } catch {
    return null;
  }
};

const publicMediaType = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return Array.from(normalized).length <= 120 &&
    new TextEncoder().encode(normalized).byteLength <= 120 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
};

const publicArtifacts = (
  artifacts: PresentableResult["artifacts"],
): PublicTaskResult["artifacts"] => {
  const output: PublicTaskResult["artifacts"] = [];
  for (const artifact of artifacts.slice(0, MAX_ITEMS * 5)) {
    const url = publicArtifactUrl(artifact.url);
    if (url === null) continue;
    output.push({
      name: publicFreeText(artifact.name, 120) || "artifact",
      media_type: publicMediaType(artifact.mediaType),
      url,
    });
    if (output.length === MAX_ITEMS) break;
  }
  return output;
};

export const presentTaskResult = (
  result: PresentableResult,
  repository: RepositoryDisplay = {},
): PublicTaskResult => ({
  ...(result.jobId === undefined ? {} : { job_id: result.jobId }),
  summary: publicFreeText(result.summary, MAX_SPOKEN_CODE_POINTS),
  changed_files: publicChangedFiles(result.changedFiles, repository),
  tests: {
    passed: result.tests.passed,
    failed: result.tests.failed,
    summary: publicFreeText(result.tests.summary, MAX_SPOKEN_CODE_POINTS),
  },
  artifacts: publicArtifacts(result.artifacts),
  acknowledged_at:
    result.acknowledgedAt === null ? null : asDate(result.acknowledgedAt),
});

export const presentApprovalDecision = (approval: PresentableApproval) => ({
  approval_id: approval.approvalId,
  ...(approval.jobId === undefined ? {} : { job_id: approval.jobId }),
  decision: approval.decision,
  revision: approval.jobRevision,
});
