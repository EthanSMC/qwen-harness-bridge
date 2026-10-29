export const TASK_LIST_LIMIT = 5;
export const MAX_DETAIL_CHARACTERS = 600;
export const MAX_DETAIL_LINES = 5;
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
export type Freshness = keyof typeof FRESHNESS_TEXT;

export type TaskSummary = Readonly<{
  shortId: string;
  title: string;
  status: TaskStatus;
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
  status: TaskStatus;
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
const SECRET_PATTERN = /\b(?:sk|ghp)_[A-Za-z0-9_-]{8,}/gu;
const PERCENT_PATTERN = /\d+(?:\.\d+)?\s*[%％]/gu;

const characters = (value: string): number => [...value].length;

const bounded = (value: string, limit: number): string => {
  const parts = [...value];
  if (parts.length <= limit) return value;
  return `${parts.slice(0, Math.max(1, limit - 1)).join("")}…`;
};

export const redactSummary = (value: string): string =>
  bounded(
    value
      .replace(UUID_PATTERN, "任务")
      .replace(URL_PATTERN, "链接")
      .replace(TOKEN_PATTERN, "凭据")
      .replace(SECRET_PATTERN, "凭据")
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

export const formatListLine = (row: TaskRow): string =>
  row.ordinal +
  ". " +
  row.shortId +
  " · " +
  row.statusText +
  (row.stageText === "" ? "" : ` · 阶段：${row.stageText}`) +
  (row.freshnessText === FRESHNESS_TEXT.fresh ? "" : ` · ${row.freshnessText}`);

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
    stageText: task.stage === undefined ? "" : bounded(task.stage, 20),
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

export const renderDetailLines = (
  input: TaskDetailInput,
  options: { now?: string } = {},
): readonly string[] => {
  const now = options.now ?? new Date().toISOString();
  const repository = bounded(input.repositoryDisplayName, 24);
  const stage =
    input.stage === undefined ? undefined : bounded(input.stage, 20);
  const approval =
    input.pendingApproval === undefined
      ? undefined
      : bounded(redactSummary(input.pendingApproval), 60);
  const terminal =
    input.terminalSummary === undefined
      ? undefined
      : bounded(redactSummary(input.terminalSummary), 80);
  const head = [
    `仓库：${repository} · 短号：${input.shortId}`,
    "状态：" +
      STATUS_TEXT[input.status] +
      (stage === undefined ? "" : ` · 阶段：${stage}`),
    "连接：" +
      FRESHNESS_TEXT[input.freshness] +
      " · 最近更新：" +
      relativeUpdateText(input.updatedAt, now),
  ];
  const tailLine = [
    ...(approval === undefined ? [] : [`待审批：${approval}`]),
    ...(terminal === undefined ? [] : [`结论：${terminal}`]),
  ].join(" · ");
  const tail = tailLine === "" ? [] : [tailLine];
  let summaries = renderEventSummaries(input.events);
  const progress = (items: readonly string[]): string =>
    `进度：${items.length === 0 ? EMPTY_EVENTS_TEXT : items.join("；")}`;
  let lines = [...head, progress(summaries), ...tail];
  while (
    characters(lines.join("\n")) > MAX_DETAIL_CHARACTERS &&
    summaries.length > 0
  ) {
    summaries = summaries.slice(1);
    lines = [...head, progress(summaries), ...tail];
  }
  if (characters(lines.join("\n")) > MAX_DETAIL_CHARACTERS) {
    lines = [...head, progress([]), ...tail];
  }
  if (characters(lines.join("\n")) > MAX_DETAIL_CHARACTERS) {
    lines = [...head, progress([])];
  }
  return lines.slice(0, MAX_DETAIL_LINES);
};

export const renderDetail = (
  input: TaskDetailInput,
  options: { now?: string } = {},
): string => renderDetailLines(input, options).join("\n");

const imageFallbackReason = (
  images: readonly ArtifactImage[],
  now: string,
): string => {
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
  return "";
};

export const renderResult = (
  input: TaskResultInput,
  options: { now?: string } = {},
): RenderedResult => {
  const now = options.now ?? new Date().toISOString();
  const images = input.images ?? [];
  const lines = [
    `结果：${bounded(input.summary, 240)}`,
    ...(input.changedFiles === undefined || input.changedFiles.length === 0
      ? []
      : [`改动文件：${input.changedFiles.join("、")}`]),
    ...(input.testSummary === undefined ? [] : [`测试：${input.testSummary}`]),
    ...(input.artifactsNote === undefined
      ? []
      : [`产物：${input.artifactsNote}`]),
  ];
  if (images.length === 0) {
    return { kind: "text", lines };
  }
  const reason = imageFallbackReason(images, now);
  if (reason === "") {
    const image = images[0] as ArtifactImage;
    return {
      kind: "image",
      url: image.url,
      caption: bounded(input.summary, 200),
    };
  }
  return {
    kind: "text",
    lines: [...lines, `图片不可用：${reason}`],
    fallbackReason: reason,
  };
};

export type TtsInput = Readonly<{
  shortId: string;
  status: TaskStatus;
  stage?: string;
  freshness?: Freshness;
}>;

const statusSentence = (input: TtsInput): string => {
  const base = `任务 ${input.shortId}`;
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
};

export const renderTts = (input: TtsInput): string => {
  const withDetail = (detail: boolean, connection: boolean): string => {
    const sentence = detail
      ? statusSentence(input)
      : statusSentence({ ...input, stage: undefined });
    const suffix =
      connection && input.freshness !== undefined
        ? `，${FRESHNESS_TEXT[input.freshness]}。`
        : "";
    return sentence + suffix;
  };
  for (const [detail, connection] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const candidate = withDetail(detail, connection);
    if (characters(candidate) <= MAX_TTS_CHARACTERS) return candidate;
  }
  return bounded(withDetail(false, false), MAX_TTS_CHARACTERS);
};
