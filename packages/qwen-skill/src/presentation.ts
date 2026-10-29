export const TASK_LIST_LIMIT = 5;
export const MAX_DETAIL_CHARACTERS = 600;
export const MAX_TTS_CHARACTERS = 120;
export const MAX_EVENT_SUMMARIES = 5;
export const EMPTY_EVENTS_TEXT = "暂无进度详情";
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

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

export const FRESHNESS_TEXT = {
  fresh: "连接正常",
  stale: "连接不稳定",
  offline: "连接中断，正在协调",
} as const;

export type TaskStatus = keyof typeof STATUS_TEXT;
export type TaskStatusValue = TaskStatus;
export type Freshness = keyof typeof FRESHNESS_TEXT;

export type TaskSummary = Readonly<{
  shortId: string;
  title: string;
  status: TaskStatusValue;
  stage?: string;
  freshness: Freshness;
  unread?: boolean;
  updatedAt: string;
}>;

export type TaskRow = Readonly<{
  ordinal: number;
  shortId: string;
  title: string;
  statusText: string;
  stageText: string;
  freshnessText: string;
  unreadMarker: boolean;
  lastUpdateText: string;
}>;

export type TaskEvent = Readonly<{
  summary: string;
  occurredAt: string;
  jobId?: string;
}>;

export type TaskDetailInput = Readonly<{
  repositoryDisplayName: string;
  shortId: string;
  status: TaskStatusValue;
  stage?: string;
  freshness: Freshness;
  updatedAt: string;
  events: readonly TaskEvent[];
  pendingApproval?: string;
  terminalSummary?: string;
}>;

export type ArtifactImage = Readonly<{
  url: string;
  mediaType: string;
  expiresAt: string;
}>;

export type TaskResultInput = Readonly<{
  summary: string;
  changedFiles?: readonly string[];
  testSummary?: string;
  images?: readonly ArtifactImage[];
  artifactsNote?: string;
}>;

export type RenderedResult =
  | Readonly<{ kind: "image"; url: string; caption: string }>
  | Readonly<{
      kind: "text";
      lines: readonly string[];
      fallbackReason?: string;
    }>;

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const URL_PATTERN = /https?:\/\/[^\s)]+/giu;
const TOKEN_PATTERN = /Bearer\s+\S+/giu;
const PERCENT_PATTERN = /\d+(?:\.\d+)?\s*[%％]/gu;

const bounded = (value: string, limit: number): string => {
  const characters = [...value];
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
};

export const redactSummary = (value: string): string =>
  bounded(
    value
      .replace(UUID_PATTERN, "任务")
      .replace(URL_PATTERN, "链接")
      .replace(TOKEN_PATTERN, "凭据")
      .replace(PERCENT_PATTERN, "")
      .replace(/\s+/gu, " ")
      .trim(),
    120,
  );

const minutesBetween = (later: string, earlier: string): number => {
  const difference = Date.parse(later) - Date.parse(earlier);
  return Number.isFinite(difference)
    ? Math.max(0, Math.round(difference / 60_000))
    : 0;
};

export const relativeUpdateText = (updatedAt: string, now: string): string => {
  const minutes = minutesBetween(now, updatedAt);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
};

export const renderListRows = (
  tasks: readonly TaskSummary[],
  options: { now?: string } = {},
): readonly TaskRow[] => {
  const now = options.now ?? new Date().toISOString();
  const ordered = tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const difference =
        Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt);
      return difference === 0 ? left.index - right.index : difference;
    })
    .slice(0, TASK_LIST_LIMIT);
  return ordered.map(({ task }, position) => ({
    ordinal: position + 1,
    shortId: task.shortId,
    title: bounded(task.title, 24),
    statusText: STATUS_TEXT[task.status],
    stageText: task.stage ?? "",
    freshnessText: FRESHNESS_TEXT[task.freshness],
    unreadMarker: task.unread === true,
    lastUpdateText: relativeUpdateText(task.updatedAt, now),
  }));
};

export const resolveOrdinal = (
  rows: readonly TaskRow[],
  ordinal: number,
): TaskRow | null =>
  Number.isSafeInteger(ordinal)
    ? (rows.find((row) => row.ordinal === ordinal) ?? null)
    : null;

export const renderEventSummaries = (
  events: readonly TaskEvent[],
): readonly string[] => {
  const ordered = [...events]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const difference =
        Date.parse(left.event.occurredAt) - Date.parse(right.event.occurredAt);
      return difference === 0 ? left.index - right.index : difference;
    })
    .slice(-MAX_EVENT_SUMMARIES);
  return ordered.map(({ event }) => redactSummary(event.summary));
};

export const renderDetail = (
  input: TaskDetailInput,
  options: { now?: string } = {},
): string => {
  const now = options.now ?? new Date().toISOString();
  const head = [
    `仓库：${input.repositoryDisplayName}`,
    `短号：${input.shortId}`,
    `状态：${STATUS_TEXT[input.status]}`,
    ...(input.stage === undefined ? [] : [`阶段：${input.stage}`]),
    `连接：${FRESHNESS_TEXT[input.freshness]}`,
    `最近更新：${relativeUpdateText(input.updatedAt, now)}`,
    ...(input.pendingApproval === undefined
      ? []
      : [`待审批：${redactSummary(input.pendingApproval)}`]),
    ...(input.terminalSummary === undefined
      ? []
      : [`结论：${redactSummary(input.terminalSummary)}`]),
  ];
  const summaries = renderEventSummaries(input.events);
  const render = (items: readonly string[]): string =>
    [
      ...head,
      "进度：",
      ...(items.length === 0 ? [EMPTY_EVENTS_TEXT] : items),
    ].join("\n");
  let items = summaries;
  let body = render(items);
  while ([...body].length > MAX_DETAIL_CHARACTERS && items.length > 0) {
    items = items.slice(1);
    body = render(items);
  }
  if ([...body].length > MAX_DETAIL_CHARACTERS) {
    body = bounded(body, MAX_DETAIL_CHARACTERS);
  }
  return body;
};

const imageFallbackReason = (
  images: readonly ArtifactImage[],
  now: string,
): string | null => {
  if (images.length === 0) return "没有可展示的图片";
  if (images.length > 1) return "仅支持单图展示，已回退为文本";
  const image = images[0] as ArtifactImage;
  if (!/^https:\/\//u.test(image.url))
    return "图片链接仅允许 HTTPS，已回退为文本";
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(image.mediaType)) {
    return "图片格式不受支持，已回退为文本";
  }
  if (!Number.isFinite(Date.parse(image.expiresAt))) {
    return "图片有效期未知，已回退为文本";
  }
  if (Date.parse(image.expiresAt) <= Date.parse(now)) {
    return "图片已过期，已回退为文本";
  }
  return null;
};

export const renderResult = (
  input: TaskResultInput,
  options: { now?: string } = {},
): RenderedResult => {
  const now = options.now ?? new Date().toISOString();
  const images = input.images ?? [];
  const reason = imageFallbackReason(images, now);
  if (reason === null) {
    const image = images[0] as ArtifactImage;
    return {
      kind: "image",
      url: image.url,
      caption: bounded(input.summary, 200),
    };
  }
  const lines = [
    `结果：${bounded(input.summary, 240)}`,
    ...(input.changedFiles === undefined || input.changedFiles.length === 0
      ? []
      : [`改动文件：${input.changedFiles.join("、")}`]),
    ...(input.testSummary === undefined ? [] : [`测试：${input.testSummary}`]),
    ...(input.artifactsNote === undefined
      ? []
      : [`产物：${input.artifactsNote}`]),
    `图片不可用：${reason}`,
  ];
  return { kind: "text", lines, fallbackReason: reason };
};

export const renderTts = (input: {
  shortId: string;
  status: TaskStatusValue;
  stage?: string;
}): string => {
  const base = `任务 ${input.shortId}`;
  const speech = (() => {
    switch (input.status) {
      case "queued":
        return `${base} 已创建，等待 Mac 接单`;
      case "dispatched":
        return `${base} Mac 已接单`;
      case "running":
        return input.stage === undefined
          ? `${base} 正在执行`
          : `${base} 正在执行，阶段：${input.stage}`;
      case "waiting_approval":
        return `${base} 等待你的批准`;
      case "cancelling":
        return `${base} 正在取消`;
      case "succeeded":
        return `${base} 已完成，结果已显示`;
      case "failed":
        return `${base} 执行失败`;
      case "cancelled":
        return `${base} 已取消`;
      case "expired":
        return `${base} 已过期`;
      default:
        return `${base} 状态已更新`;
    }
  })();
  return bounded(speech, MAX_TTS_CHARACTERS);
};
