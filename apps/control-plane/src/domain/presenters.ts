import type { ConnectorHealth, JobStatus, JobSummary } from "@qhb/protocol";

const MAX_ITEMS = 5;
const MAX_TITLE_CODE_POINTS = 40;
const MAX_STAGE_CODE_POINTS = 36;
const MAX_DETAIL_CODE_POINTS = 600;
const MAX_SPOKEN_CODE_POINTS = 120;

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

const safeTitle = (value: string | null | undefined): string =>
  boundedText(value, MAX_TITLE_CODE_POINTS, 40) || "Untitled task";

const safeStage = (value: string | null | undefined): string =>
  boundedText(value, MAX_STAGE_CODE_POINTS, 36) || "Unknown stage";

const safeDetail = (value: string | null | undefined): string =>
  boundedText(value, MAX_DETAIL_CODE_POINTS);

const isAbsolutePath = (value: string): boolean =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//, "");

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
    return relative.length === 0 ? "." : relative;
  }

  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized;
};

const pathToken =
  /(?:\/[A-Za-z0-9._~+@%=-]+)+(?:\/[A-Za-z0-9._~+@%=-]+)*|[A-Za-z]:[\\/][^\s"'<>]+/g;

const redactAbsolutePaths = (
  value: string,
  repository: RepositoryDisplay,
): string =>
  value.replace(pathToken, (token) => {
    const clean = token.replace(/[),.;:!?]+$/, "");
    if (!isAbsolutePath(clean)) return token;
    const relative = relativeRepositoryPath(clean, repository);
    return relative ?? "[redacted path]";
  });

const publicChangedFiles = (
  values: unknown,
  repository: RepositoryDisplay,
): string[] => {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => relativeRepositoryPath(value, repository))
    .filter((value): value is string => value !== null)
    .slice(0, MAX_ITEMS);
};

const publicEvent = (
  event: PresentableEvent,
  repository: RepositoryDisplay,
): PublicTaskDetail["recent_events"][number] => {
  const payload = event.payload ?? {};
  const output: PublicTaskDetail["recent_events"][number] = {
    sequence: event.sequence,
    type: boundedText(event.type, 64) || "event",
    created_at: asDate(event.createdAt),
  };

  const stage = payload.stage ?? payload.current_stage;
  if (typeof stage === "string") output.current_stage = safeStage(stage);
  if (typeof payload.detail === "string") {
    output.detail = safeDetail(redactAbsolutePaths(payload.detail, repository));
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
  action_summary: safeDetail(redactAbsolutePaths(approval.actionSummary, {})),
  impact_summary: safeDetail(redactAbsolutePaths(approval.impactSummary, {})),
  risk_class: boundedText(approval.riskClass, 64) || "unknown",
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
    terminalText === null
      ? null
      : safeDetail(redactAbsolutePaths(terminalText, repository));
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
      boundedText(repository.displayName, 120) ||
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

export const presentTaskResult = (
  result: PresentableResult,
  repository: RepositoryDisplay = {},
): PublicTaskResult => ({
  ...(result.jobId === undefined ? {} : { job_id: result.jobId }),
  summary: boundedText(result.summary, MAX_SPOKEN_CODE_POINTS),
  changed_files: publicChangedFiles(result.changedFiles, repository),
  tests: {
    passed: result.tests.passed,
    failed: result.tests.failed,
    summary: boundedText(result.tests.summary, MAX_SPOKEN_CODE_POINTS),
  },
  artifacts: result.artifacts.slice(0, MAX_ITEMS).map((artifact) => ({
    name: boundedText(artifact.name, 120) || "artifact",
    media_type:
      boundedText(artifact.mediaType, 120) || "application/octet-stream",
    url: boundedText(artifact.url, 2048),
  })),
  acknowledged_at:
    result.acknowledgedAt === null ? null : asDate(result.acknowledgedAt),
});

export const presentApprovalDecision = (approval: PresentableApproval) => ({
  approval_id: approval.approvalId,
  ...(approval.jobId === undefined ? {} : { job_id: approval.jobId }),
  decision: approval.decision,
  revision: approval.jobRevision,
});
