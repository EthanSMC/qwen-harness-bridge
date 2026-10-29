import { createHash } from "node:crypto";
import type { TaskStatus } from "./copy.js";
import {
  ERROR_COPY,
  errorSpeech,
  MAX_TTS_CHARACTERS,
  statusText,
} from "./copy.js";
import type { ContextSnapshot } from "./session-context.js";
import { RtcSessionContext } from "./session-context.js";
import type {
  LiveIntent,
  LiveUtterance,
  RepositoryOption,
  RouterOptions,
  RouterResponse,
} from "./types.js";

export type LiveUtteranceRouter = Readonly<{
  handleFinal: (
    utterance: LiveUtterance,
    signal?: AbortSignal,
  ) => Promise<RouterResponse>;
  handlePartial: (text: string) => null;
  contextSnapshot: () => ContextSnapshot;
}>;

const ORDINAL_PATTERN =
  /第s*([一二两三四五六七八九十]|\d{1,2})\s*(?:个|条|项)/u;
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
const SHORT_ID_PATTERN = /QH-[A-Z0-9]{4,}/iu;
const EXIT_PATTERN = /退出(?:实时|语音)?模式|结束实时模式|^退出$/u;
const CANCEL_PATTERN = /取消|停止|终止/u;
const DECISION_PATTERN = /批准|同意|通过|拒绝|驳回/u;
const LIST_PATTERN = /列出|列一下|有哪些|列表|最近.{0,4}(?:任务|审批)/u;
const APPROVAL_LIST_PATTERN = /待审批|审批列表/u;
const INSPECT_PATTERN = /详情|看看|是什么|状态|怎么样/u;
const RESULT_PATTERN = /结果|读一下|总结|进展|完成没有/u;
const PRONOUN_PATTERN = /^(?:它|这个|那个|他)/u;
const SUBMIT_PATTERN = /跑|执行|测试|修|改|提交|检查|打开/u;
const READ_ONLY_PATTERN = /只读|别改|不要修改|不改代码/u;

const MAX_TRACKED_RECEIPTS = 16;

const parseOrdinal = (text: string): number | undefined => {
  const match = ORDINAL_PATTERN.exec(text);
  if (match === null) return undefined;
  const raw = match[1];
  const value = /^\d+$/u.test(raw) ? Number(raw) : ORDINAL_NUMERALS[raw];
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
};

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const uuidFrom = (value: string): string => {
  const hex = hash(value).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join("-");
};

const clampSpeech = (value: string): string => {
  const characters = Array.from(value);
  if (characters.length <= MAX_TTS_CHARACTERS) return value;
  return `${characters.slice(0, MAX_TTS_CHARACTERS - 1).join("")}…`;
};

const statusOf = (status: string): string => statusText(status as TaskStatus);

const repositoryMatches = (
  text: string,
  repositories: readonly RepositoryOption[],
): readonly RepositoryOption[] =>
  repositories.filter((repository) =>
    [repository.displayName, ...(repository.aliases ?? [])].some(
      (alias) => alias.length > 0 && text.includes(alias),
    ),
  );

/**
 * Routes final ASR hypotheses through the stable job, task-query, result and
 * approval services. Partial hypotheses are ignored, duplicate finals return the
 * cached receipt, and ordinal context is bounded by two minutes and the latest
 * list. The router never writes to a parallel RTC database.
 */
export const createLiveUtteranceRouter = (
  options: RouterOptions,
): LiveUtteranceRouter => {
  const now = options.now ?? (() => Date.now());
  const context = new RtcSessionContext({ ttlMs: options.ttlMs });
  const receipts = new Map<string, RouterResponse>();

  const respond = (
    intent: LiveIntent,
    speech: string,
    extra: Readonly<{
      highlight?: string;
      focusedJobId?: string;
      focusedApprovalId?: string;
    }> = {},
  ): RouterResponse => ({
    intent,
    speech: clampSpeech(speech),
    ...extra,
  });

  const clarify = (prompt: string): RouterResponse =>
    respond({ kind: "clarify", prompt }, prompt);

  const remember = (digest: string, response: RouterResponse): void => {
    if (receipts.size >= MAX_TRACKED_RECEIPTS) {
      const oldest = receipts.keys().next().value;
      if (oldest !== undefined) receipts.delete(oldest);
    }
    receipts.set(digest, response);
  };

  const route = async (
    text: string,
    eventId: string,
    signal: AbortSignal | undefined,
  ): Promise<RouterResponse> => {
    const nowMs = now();
    if (EXIT_PATTERN.test(text)) {
      return respond({ kind: "exit" }, "已退出实时模式。");
    }

    const shortId = SHORT_ID_PATTERN.exec(text)?.[0];
    if (shortId !== undefined && CANCEL_PATTERN.test(text)) {
      const tasks = context.taskEntries(nowMs);
      if (tasks === undefined) {
        return clarify("请先列出任务，再说短号。");
      }
      const entry = tasks.find(
        (task) => task.shortId.toUpperCase() === shortId.toUpperCase(),
      );
      if (entry === undefined) {
        return clarify("没有在最近的任务里找到这个短号。");
      }
      await options.jobs.cancel({
        job_id: entry.jobId,
        expected_revision: entry.revision,
      });
      return respond(
        {
          kind: "cancel",
          jobId: entry.jobId,
          expectedRevision: entry.revision,
        },
        `已取消 ${entry.shortId}。`,
        {
          focusedJobId: entry.jobId,
        },
      );
    }

    if (DECISION_PATTERN.test(text)) {
      const ordinal = parseOrdinal(text);
      if (ordinal === undefined) {
        return clarify("请说批准或拒绝第几个。");
      }
      const approvals = context.approvalEntries(nowMs);
      if (approvals === undefined) {
        return clarify("请先看一下待审批列表。");
      }
      const entry = approvals[ordinal - 1];
      if (entry === undefined) {
        return clarify("待审批列表里没有这个序号。");
      }
      const decision = /拒绝|驳回/u.test(text) ? "reject" : "approve";
      await options.approvals.decide({
        approval_id: entry.approvalId,
        decision,
        expected_job_revision: entry.jobRevision,
      });
      const speech =
        decision === "approve"
          ? `已批准${entry.jobShortId}，${statusText("succeeded")}。`
          : `已拒绝${entry.jobShortId}。`;
      return respond(
        {
          kind: decision,
          approvalId: entry.approvalId,
          expectedJobRevision: entry.jobRevision,
        },
        speech,
        { focusedApprovalId: entry.approvalId },
      );
    }

    if (LIST_PATTERN.test(text) || APPROVAL_LIST_PATTERN.test(text)) {
      if (APPROVAL_LIST_PATTERN.test(text)) {
        const approvals = await options.approvals.listPending({ limit: 5 });
        context.recordApprovalList(
          approvals.map((approval) => ({
            approvalId: approval.approval_id,
            jobShortId: approval.job_short_id,
            jobRevision: approval.job_revision,
          })),
          nowMs,
        );
        const summary =
          approvals.length === 0
            ? "当前没有待审批任务。"
            : `当前有 ${approvals.length} 个待审批：${approvals
                .map((approval) => approval.job_short_id)
                .join("、")}。`;
        return respond({ kind: "list" }, summary, {
          ...(approvals[0] === undefined
            ? {}
            : { focusedApprovalId: approvals[0].approval_id }),
        });
      }
      const tasks = await options.jobs.list({ limit: 5, unread_only: false });
      context.recordTaskList(
        tasks.map((task) => ({
          jobId: task.job_id,
          shortId: task.short_id,
          revision: task.revision,
        })),
        nowMs,
      );
      const summary =
        tasks.length === 0
          ? "最近没有任务。"
          : `最近 ${tasks.length} 个任务：${tasks
              .map((task) => `${task.short_id} ${statusOf(task.status)}`)
              .join("；")}。`;
      return respond({ kind: "list" }, summary);
    }

    const ordinal = parseOrdinal(text);
    if (ordinal !== undefined && INSPECT_PATTERN.test(text)) {
      const tasks = context.taskEntries(nowMs);
      if (tasks === undefined) {
        return clarify("请先列出任务。");
      }
      const entry = tasks[ordinal - 1];
      if (entry === undefined) {
        return clarify("任务列表里没有这个序号。");
      }
      const detail = await options.jobs.get({ job_id: entry.jobId });
      context.focus(detail.job_id);
      return respond(
        { kind: "inspect", jobId: detail.job_id },
        `${entry.shortId} ${statusOf(detail.status)}，阶段 ${detail.current_stage}。`,
        { focusedJobId: detail.job_id },
      );
    }

    if (RESULT_PATTERN.test(text)) {
      const focused = context.focusedJobId();
      if (focused === undefined) {
        return clarify("请先说明是哪个任务。");
      }
      const result = await options.jobs.getResult({ job_id: focused });
      context.focus(focused);
      return respond(
        { kind: "result", jobId: focused },
        `${statusText("succeeded")}：${result.summary}，测试 ${result.tests.passed} 通过 ${result.tests.failed} 失败。`,
        { focusedJobId: focused, highlight: result.summary },
      );
    }

    if (PRONOUN_PATTERN.test(text)) {
      return clarify("你指的是哪个任务？请说任务短号或“第一个”。");
    }

    const matched = repositoryMatches(text, options.repositories);
    if (matched.length > 1) {
      return clarify("有两个仓库都匹配，请说清楚是哪一个。");
    }
    if (matched.length === 0) {
      if (/仓库|跑|执行/u.test(text)) {
        return clarify(ERROR_COPY.INVALID_REPOSITORY.message);
      }
      return clarify("我没听清，请再说一次。");
    }
    const repository = matched[0];
    if (repository === undefined) {
      return clarify("我没听清，请再说一次。");
    }
    if (SUBMIT_PATTERN.test(text) && !signal?.aborted) {
      const mode = READ_ONLY_PATTERN.test(text) ? "read_only" : "normal";
      const clientRequestId = uuidFrom(`${options.sessionId}:${eventId}`);
      const receipt = await options.jobs.submit({
        client_request_id: clientRequestId,
        repository_id: repository.id,
        request: text,
        mode,
      });
      return respond(
        {
          kind: "submit",
          repositoryId: repository.id,
          request: text,
          mode,
        },
        `已提交到 ${repository.displayName}，短号 ${receipt.short_id}。`,
        { focusedJobId: receipt.job_id },
      );
    }

    return clarify("我没听清，请再说一次。");
  };

  return {
    async handleFinal(utterance, signal = options.signal) {
      if (signal?.aborted) {
        return clarify("实时模式已结束。");
      }
      if (
        utterance.sessionId !== options.sessionId ||
        utterance.ownerId !== options.ownerId
      ) {
        return clarify("当前会话不可用。");
      }
      const digest = hash(
        `${utterance.sessionId}:${utterance.eventId}:${utterance.text}`,
      );
      const cached = receipts.get(digest);
      if (cached !== undefined) return cached;
      context.recordFinalDigest(digest);
      let response: RouterResponse;
      try {
        response = await route(
          utterance.text.trim(),
          utterance.eventId,
          signal,
        );
      } catch (error) {
        const code =
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined;
        response = clarify(errorSpeech(code));
      }
      remember(digest, response);
      return response;
    },
    handlePartial: () => null,
    contextSnapshot: () => context.snapshot(now()),
  };
};
