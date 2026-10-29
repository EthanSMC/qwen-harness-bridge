/**
 * Pure planning helpers for the three Qwen Skill mutation routes.
 *
 * Task 4 (Issue #18) makes the mutation paths safe by construction:
 * - an ordinal approval decision needs the approval list that was read
 *   immediately before it, and reuses that list's job revision;
 * - an ambiguous, stale, expired or already-cancelling context produces no
 *   tool arguments at all, so the caller cannot emit a mutation;
 * - every decision conflict refreshes the list and explains the current state
 *   instead of retrying a mutation;
 * - one cancellation resolves one exact job, carries one current revision and
 *   is presented with the authoritative status the server returned; and
 * - stable errors map to one Chinese message plus one safe next action.
 *
 * The module has no I/O: callers pass the MCP results they observed, which keeps
 * every rule deterministic and directly testable.
 */
import { STATUS_TEXT, type TaskStatus } from "./presentation.js";

/** A list rendering carries at most the five documented rows. */
export const MAX_APPROVAL_ROWS = 5;

/** A list older than this must be refreshed before an ordinal decision. */
export const APPROVAL_SNAPSHOT_MAX_AGE_MS = 30_000;

/** One confirmation sentence stays inside the spoken-text bound. */
export const MAX_CONFIRMATION_CHARACTERS = 120;

export type ApprovalDecision = "approve" | "reject";

/** One approval exactly as the MCP tool returned it. */
export type PendingApproval = Readonly<{
  /** Approval UUID; the only value a decision may target. */
  approvalId: string;
  /** Glasses short id such as QH-2K7M. */
  shortId: string;
  action: string;
  impact: string;
  /** Protocol risk class, for example approval_required. */
  risk: string;
  /** ISO expiry that must still be in the future. */
  expiresAt: string;
  /** Revision of the underlying job at list time. */
  jobRevision: number;
  /** Server fingerprint; never rendered or spoken. */
  fingerprint: string;
}>;

/** The list result the decision is based on, with its observation time. */
export type ApprovalSnapshot = Readonly<{
  listedAt: number;
  items: readonly PendingApproval[];
}>;

export type ApprovalRow = Readonly<{
  ordinal: number;
  shortId: string;
  action: string;
  impact: string;
  risk: string;
  expiryText: string;
}>;

export type RenderedApprovalList = Readonly<{
  rows: readonly ApprovalRow[];
  hiddenCount: number;
}>;

export type ApprovalDecisionArguments = Readonly<{
  approval_id: string;
  decision: ApprovalDecision;
  expected_job_revision: number;
}>;

export type ApprovalDecisionPlan =
  | Readonly<{ kind: "list-required"; reason: string }>
  | Readonly<{ kind: "clarify"; reason: string; rows: readonly ApprovalRow[] }>
  | Readonly<{
      kind: "decide";
      arguments: ApprovalDecisionArguments;
      confirmation: string;
    }>;

const RISK_TEXT: Record<string, string> = {
  approval_required: "需要确认",
  high_risk: "高风险",
  destructive: "破坏性操作",
  read_only: "只读",
};

const bounded = (value: string, limit: number): string => {
  const characters = [...value];
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
};

const oneLine = (value: string, limit: number): string =>
  bounded(value.replace(/\s+/gu, " ").trim(), limit);

const expiryText = (expiresAt: string, now: number): string => {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return "有效期未知";
  // Normalize every ISO offset to UTC so a +08:00 expiry is not shown as a
  // different wall-clock time than the server recorded.
  const iso = new Date(expiresAtMs).toISOString();
  const label = `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;
  return expiresAtMs <= now ? `已过期（${label}）` : `有效期至 ${label}`;
};

const rowOf = (
  item: PendingApproval,
  ordinal: number,
  now: number,
): ApprovalRow => ({
  ordinal,
  shortId: oneLine(item.shortId, 24),
  action: oneLine(item.action, 60),
  impact: oneLine(item.impact, 60),
  risk: RISK_TEXT[item.risk] ?? oneLine(item.risk, 24),
  expiryText: expiryText(item.expiresAt, now),
});

/** Renders at most five rows in the order the MCP tool returned them. */
export const renderApprovalList = (
  snapshot: ApprovalSnapshot,
  now: number,
): RenderedApprovalList => {
  const rows = snapshot.items
    .slice(0, MAX_APPROVAL_ROWS)
    .map((item, index) => rowOf(item, index + 1, now));
  return {
    rows,
    hiddenCount: Math.max(0, snapshot.items.length - rows.length),
  };
};

const ORDINAL_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const ORDINAL_PATTERN =
  /第\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:个|条|项)/u;

/** Returns the ordinal the user named, or undefined when there is none. */
export const parseOrdinal = (utterance: string): number | undefined => {
  const match = ORDINAL_PATTERN.exec(utterance);
  if (match === null) return undefined;
  const raw = match[1];
  const value = /^\d+$/u.test(raw) ? Number(raw) : ORDINAL_NUMERALS[raw];
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
};

const confirmationSentence = (
  item: PendingApproval,
  decision: ApprovalDecision,
): string => {
  const verb = decision === "approve" ? "批准" : "拒绝";
  return oneLine(
    `确认${verb}「${oneLine(item.action, 40)}」，影响：${oneLine(item.impact, 40)}。`,
    MAX_CONFIRMATION_CHARACTERS,
  );
};

export type OrdinalDecisionInput = Readonly<{
  utterance: string;
  decision: ApprovalDecision;
  now: number;
  /** The list result the caller observed immediately before this decision. */
  snapshot?: ApprovalSnapshot;
}>;

/**
 * Plans one ordinal decision. Missing or stale list state returns
 * `list-required`, and every ambiguous context returns `clarify`; neither
 * carries tool arguments, so no mutation can be emitted from them.
 */
export const planOrdinalDecision = (
  input: OrdinalDecisionInput,
): ApprovalDecisionPlan => {
  const { snapshot, now } = input;
  if (snapshot === undefined) {
    return {
      kind: "list-required",
      reason: "按序号决定前，先调用 list_pending_approvals 列出待审批任务。",
    };
  }
  if (now - snapshot.listedAt > APPROVAL_SNAPSHOT_MAX_AGE_MS) {
    return {
      kind: "list-required",
      reason: "待审批列表已过期，先重新列出再决定。",
    };
  }
  const rendered = renderApprovalList(snapshot, now);
  if (snapshot.items.length === 0) {
    return {
      kind: "clarify",
      reason: "当前没有待审批任务。",
      rows: rendered.rows,
    };
  }
  const ordinal = parseOrdinal(input.utterance);
  if (ordinal === undefined) {
    return {
      kind: "clarify",
      reason: "请说明要决定第几个待审批任务。",
      rows: rendered.rows,
    };
  }
  // The ordinal must address a row the user can actually see: approvals beyond
  // the five rendered rows are hidden, so deciding on them would target a row
  // the user never confirmed.
  const item =
    ordinal <= rendered.rows.length ? snapshot.items[ordinal - 1] : undefined;
  if (item === undefined) {
    return {
      kind: "clarify",
      reason: `列表只有 ${rendered.rows.length} 个待审批任务，请重新选择。`,
      rows: rendered.rows,
    };
  }
  const expiresAtMs = Date.parse(item.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      kind: "clarify",
      reason: "该审批的有效期无法确认，正在刷新待审批列表。",
      rows: rendered.rows,
    };
  }
  if (expiresAtMs <= now) {
    return {
      kind: "clarify",
      reason: "该审批已过期，正在刷新待审批列表。",
      rows: rendered.rows,
    };
  }
  return {
    kind: "decide",
    arguments: {
      approval_id: item.approvalId,
      decision: input.decision,
      expected_job_revision: item.jobRevision,
    },
    confirmation: confirmationSentence(item, input.decision),
  };
};

export const APPROVAL_REFRESH_CODES = [
  "REVISION_CONFLICT",
  "APPROVAL_EXPIRED",
  "APPROVAL_ALREADY_DECIDED",
  "APPROVAL_SUPERSEDED",
] as const;

export type ApprovalRefreshCode = (typeof APPROVAL_REFRESH_CODES)[number];

export type DecisionObservation = Readonly<{
  shortId: string;
  /** Current task status exactly as the MCP tool returned it. */
  status: string;
}>;

export type DecisionRefresh = Readonly<{
  code: ApprovalRefreshCode;
  explanation: string;
  refresh: "list_pending_approvals";
  retried: false;
}>;

const REFRESH_REASON: Record<ApprovalRefreshCode, string> = {
  REVISION_CONFLICT: "任务状态已变化，这次决定没有生效",
  APPROVAL_EXPIRED: "选中的审批已过期",
  APPROVAL_ALREADY_DECIDED: "该审批已经被处理过",
  APPROVAL_SUPERSEDED: "该审批已被新的操作取代",
};

const localizedStatus = (status: string): string =>
  (STATUS_TEXT as Readonly<Record<string, string>>)[status] ?? "状态未知";

/**
 * Turns a decision conflict into a refresh plus a Chinese explanation of the
 * current state. The status is localized instead of leaking a raw domain value,
 * and the result never carries tool arguments, so the mutation cannot be
 * replayed silently.
 */
export const refreshAfterDecisionError = (
  code: ApprovalRefreshCode,
  observed: DecisionObservation,
): DecisionRefresh => ({
  code,
  explanation: oneLine(
    `任务 ${observed.shortId} 当前状态：${localizedStatus(observed.status)}；${REFRESH_REASON[code]}。请刷新待审批列表后重新决定。`,
    160,
  ),
  refresh: "list_pending_approvals",
  retried: false,
});

export type CancellationStatus = TaskStatus;

export type CancellationTarget = Readonly<{
  jobId: string;
  shortId: string;
  status: CancellationStatus;
  revision: number;
}>;

export type CancellationArguments = Readonly<{
  job_id: string;
  expected_revision: number;
}>;

export type CancellationPlan =
  | Readonly<{
      kind: "cancel";
      arguments: CancellationArguments;
      confirmation: string;
    }>
  | Readonly<{ kind: "terminal"; text: string }>
  | Readonly<{ kind: "clarify"; reason: string }>;

const TERMINAL_STATUSES: ReadonlySet<CancellationStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export type CancellationInput = Readonly<{
  /** The exactly resolved job, when the user named one unambiguous task. */
  target?: CancellationTarget;
  now: number;
}>;

/**
 * Plans one cancellation. Only an exactly resolved, non-terminal job with a
 * current revision produces a single `cancel_task` argument set; every other
 * context returns no arguments at all.
 */
export const planCancellation = (
  input: CancellationInput,
): CancellationPlan => {
  const target = input.target;
  if (target === undefined) {
    return {
      kind: "clarify",
      reason: "请先确认要取消哪个任务，再执行取消。",
    };
  }
  if (TERMINAL_STATUSES.has(target.status)) {
    return {
      kind: "terminal",
      text: `任务 ${target.shortId} ${STATUS_TEXT[target.status]}，无需取消。`,
    };
  }
  if (target.status === "cancelling") {
    return {
      kind: "clarify",
      reason: `任务 ${target.shortId} 正在取消，等待后续查询确认终态。`,
    };
  }
  if (!Number.isSafeInteger(target.revision) || target.revision < 0) {
    return {
      kind: "clarify",
      reason: "缺少当前版本，先读取任务详情再取消。",
    };
  }
  return {
    kind: "cancel",
    arguments: {
      job_id: target.jobId,
      expected_revision: target.revision,
    },
    confirmation: oneLine(
      `确认取消任务 ${target.shortId}？当前状态：${STATUS_TEXT[target.status]}。`,
      MAX_CONFIRMATION_CHARACTERS,
    ),
  };
};

export type CancellationOutcome = Readonly<{
  kind: "terminal" | "cancelling";
  text: string;
}>;

/**
 * Presents the status the server returned. A queued cancellation can be
 * terminal immediately; a running cancellation stays "正在取消" until a later
 * query reports a terminal status, and a completed job wins the race.
 */
export const presentCancellationResult = (returned: {
  shortId: string;
  status: CancellationStatus;
}): CancellationOutcome => {
  if (returned.status === "cancelled") {
    return { kind: "terminal", text: `任务 ${returned.shortId} 已取消。` };
  }
  if (returned.status === "succeeded") {
    return {
      kind: "terminal",
      text: `任务 ${returned.shortId} 已完成，取消未生效。`,
    };
  }
  if (returned.status === "failed" || returned.status === "expired") {
    return {
      kind: "terminal",
      text: `任务 ${returned.shortId} ${STATUS_TEXT[returned.status]}，取消未生效。`,
    };
  }
  return {
    kind: "cancelling",
    text: `任务 ${returned.shortId} 正在取消。`,
  };
};

export const STABLE_ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "RATE_LIMITED",
  "INVALID_REPOSITORY",
  "CONNECTOR_OFFLINE",
  "IDEMPOTENCY_CONFLICT",
  "JOB_NOT_FOUND",
  "REVISION_CONFLICT",
  "APPROVAL_EXPIRED",
  "APPROVAL_CHANNEL_UNAVAILABLE",
  "TRANSPORT_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export type ErrorCode = StableErrorCode | ApprovalRefreshCode;

export type ErrorCopy = Readonly<{
  code: ErrorCode;
  message: string;
  nextAction: string;
  refresh: boolean;
}>;

const ERROR_COPY: Record<ErrorCode, { message: string; nextAction: string }> = {
  AUTHENTICATION_FAILED: {
    message: "连接凭据无效或已过期。",
    nextAction: "请重新连接账号后再试。",
  },
  RATE_LIMITED: {
    message: "服务端请求过多，暂时限流。",
    nextAction: "请稍等片刻再试，不要连续重复请求。",
  },
  INVALID_REPOSITORY: {
    message: "仓库名称不在配置的仓库列表中。",
    nextAction: "请从已配置的仓库名称或编号中重新选择。",
  },
  CONNECTOR_OFFLINE: {
    message: "Mac 连接器当前离线，任务已保留。",
    nextAction: "请稍后重新提交，保留同一个请求编号。",
  },
  IDEMPOTENCY_CONFLICT: {
    message: "该请求编号已经存在。",
    nextAction: "请确认是否要新建任务，不要重复提交同一请求。",
  },
  JOB_NOT_FOUND: {
    message: "没有找到该任务。",
    nextAction: "请重新列出任务并核对短号。",
  },
  REVISION_CONFLICT: {
    message: "任务状态已变化，这次操作没有生效。",
    nextAction: "请刷新任务后再决定是否继续。",
  },
  APPROVAL_EXPIRED: {
    message: "该审批已过期。",
    nextAction: "请刷新待审批列表，如仍需执行请重新发起。",
  },
  APPROVAL_ALREADY_DECIDED: {
    message: "该审批已经被处理过。",
    nextAction: "请刷新待审批列表后再决定。",
  },
  APPROVAL_SUPERSEDED: {
    message: "该审批已被新的操作取代。",
    nextAction: "请刷新待审批列表后再决定。",
  },
  APPROVAL_CHANNEL_UNAVAILABLE: {
    message: "审批通道当前不可用。",
    nextAction: "请稍后重试，或改用其他受支持的审批方式。",
  },
  TRANSPORT_TIMEOUT: {
    message: "请求超时，结果尚未确认。",
    nextAction: "请重新读取任务结果确认实际状态，不要直接重复提交。",
  },
  INTERNAL_ERROR: {
    message: "服务端内部错误。",
    nextAction: "请稍后重试一次，仍然失败请向维护者提供请求编号。",
  },
};

/** Maps a stable error code to one Chinese message and one safe next action. */
export const mapStableError = (code: ErrorCode): ErrorCopy => {
  const copy = ERROR_COPY[code];
  return {
    code,
    message: copy.message,
    nextAction: copy.nextAction,
    refresh: (APPROVAL_REFRESH_CODES as readonly string[]).includes(code),
  };
};
