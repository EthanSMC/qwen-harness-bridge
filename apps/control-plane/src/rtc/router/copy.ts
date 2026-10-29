/** Mirrors the Skill presentation contract; a test keeps this copy in sync. */
export const MAX_TTS_CHARACTERS = 120;

export const STATUS_TEXT = {
  queued: "等待 Mac 接单",
  dispatched: "Mac 已接单",
  running: "正在执行",
  waiting_approval: "等待你的批准",
  cancelling: "正在取消",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  expired: "已过期",
} as const;

export type TaskStatus = keyof typeof STATUS_TEXT;

export const statusText = (status: TaskStatus): string => STATUS_TEXT[status];

export type StableErrorCode =
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "INVALID_REPOSITORY"
  | "CONNECTOR_OFFLINE"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CHANNEL_UNAVAILABLE"
  | "TRANSPORT_TIMEOUT"
  | "INTERNAL_ERROR";

export type ErrorCopy = Readonly<{ message: string; nextAction: string }>;

export const ERROR_COPY: Record<StableErrorCode, ErrorCopy> = {
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

export const errorSpeech = (code: string | undefined): string => {
  const copy =
    code !== undefined && code in ERROR_COPY
      ? ERROR_COPY[code as StableErrorCode]
      : ERROR_COPY.INTERNAL_ERROR;
  return copy.message;
};
