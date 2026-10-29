import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ERROR_COPY,
  MAX_TTS_CHARACTERS,
  STATUS_TEXT,
  statusText,
} from "./copy.js";
import { RtcSessionContext } from "./session-context.js";
import type {
  LiveUtterance,
  RouterApproval,
  RouterTask,
  StableApprovalServices,
  StableJobServices,
} from "./types.js";
import { createLiveUtteranceRouter } from "./utterance-router.js";

const SESSION = "ses_0001";
const OWNER = "owner-1";
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const APPROVAL_1 = "33333333-3333-4333-8333-333333333333";
const APPROVAL_2 = "44444444-4444-4444-8444-444444444444";

const receipt = {
  job_id: JOB_A,
  short_id: "QH-AAA1",
  status: "queued" as const,
  connector_status: "online" as const,
  accepted_at: "2026-08-07T10:00:00Z",
  expires_at: "2026-08-07T11:00:00Z",
};

const task = (
  jobId: string,
  shortId: string,
  revision: number,
): RouterTask => ({
  job_id: jobId,
  short_id: shortId,
  status: "running",
  current_stage: "editing",
  revision,
  title: "示例任务",
});

const approval = (
  approvalId: string,
  shortId: string,
  jobRevision: number,
): RouterApproval => ({
  approval_id: approvalId,
  job_short_id: shortId,
  job_revision: jobRevision,
  action_summary: "修改两个文件",
  impact_summary: "写入工作区",
  expires_at: "2026-08-07T10:10:00Z",
});

const makeServices = () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const tables = new Set<string>();
  let tasks = [task(JOB_A, "QH-AAA1", 2), task(JOB_B, "QH-BBB2", 5)];
  let approvals = [
    approval(APPROVAL_1, "QH-AAA1", 2),
    approval(APPROVAL_2, "QH-BBB2", 5),
  ];

  const jobs: StableJobServices = {
    async submit(input) {
      calls.push({ method: "submit", input });
      tables.add("jobs");
      return receipt;
    },
    async list(input) {
      calls.push({ method: "list", input });
      return tasks;
    },
    async get(input) {
      calls.push({ method: "get", input });
      return {
        job_id: input.job_id,
        status: "running",
        current_stage: "editing",
        revision: 2,
        text: "正在编辑",
        pending_approval: null,
      };
    },
    async cancel(input) {
      calls.push({ method: "cancel", input });
      tables.add("jobs");
      return {
        job_id: input.job_id,
        status: "cancelling",
        short_id: "QH-AAA1",
      };
    },
    async getResult(input) {
      calls.push({ method: "getResult", input });
      tables.add("jobs");
      return {
        job_id: input.job_id,
        summary: "测试已通过",
        changed_files: ["src/app.ts"],
        tests: { passed: 3, failed: 0, summary: "全部通过" },
        artifacts: [],
        acknowledged_at: "2026-08-07T10:05:00Z",
      };
    },
  };
  const approvalServices: StableApprovalServices = {
    async listPending(input) {
      calls.push({ method: "listPending", input });
      return approvals;
    },
    async decide(input) {
      calls.push({ method: "decide", input });
      tables.add("approvals");
      return {
        approval_id: input.approval_id,
        decision: input.decision,
        revision: input.expected_job_revision,
      };
    },
  };
  return {
    jobs,
    approvalServices,
    calls,
    tables,
    setTasks(next: RouterTask[]) {
      tasks = next;
    },
    setApprovals(next: RouterApproval[]) {
      approvals = next;
    },
  };
};

const makeRouter = (clock = { now: 1_000_000 }) => {
  const fake = makeServices();
  const router = createLiveUtteranceRouter({
    sessionId: SESSION,
    ownerId: OWNER,
    repositories: [
      { id: "repo-alpha", displayName: "alpha 仓库", aliases: ["alpha"] },
      { id: "repo-gamma", displayName: "gamma 仓库", aliases: ["gamma"] },
    ],
    jobs: fake.jobs,
    approvals: fake.approvalServices,
    now: () => clock.now,
  });
  return { router, fake, clock };
};

const final = (eventId: string, text: string): LiveUtterance => ({
  sessionId: SESSION,
  ownerId: OWNER,
  eventId,
  text,
});

const speak = (response: { speech: string }): string => response.speech;

describe("final utterance router", () => {
  it("submits through the stable coordinator with a derived idempotency key", async () => {
    const { router, fake } = makeRouter();
    const utterance = final("evt-1", "让 DeepSeek 在 alpha 仓库跑一下测试");
    const response = await router.handleFinal(utterance);

    expect(response.intent).toMatchObject({
      kind: "submit",
      repositoryId: "repo-alpha",
      mode: "normal",
    });
    expect(fake.calls.filter((call) => call.method === "submit")).toHaveLength(
      1,
    );
    const input = fake.calls.find((call) => call.method === "submit")
      ?.input as {
      client_request_id: string;
      repository_id: string;
      mode: string;
    };
    expect(input.repository_id).toBe("repo-alpha");
    expect(input.client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(speak(response)).toContain("QH-AAA1");
    expect(Array.from(speak(response)).length).toBeLessThanOrEqual(
      MAX_TTS_CHARACTERS,
    );
  });

  it("returns the same receipt for a duplicate final without resubmitting", async () => {
    const { router, fake } = makeRouter();
    const utterance = final("evt-dup", "让 DeepSeek 在 alpha 仓库跑一下测试");
    const first = await router.handleFinal(utterance);
    const second = await router.handleFinal(utterance);

    expect(second.speech).toBe(first.speech);
    expect(fake.calls.filter((call) => call.method === "submit")).toHaveLength(
      1,
    );
  });

  it("never mutates state from a partial hypothesis", async () => {
    const { router, fake } = makeRouter();
    expect(router.handlePartial("让 DeepSeek 在 alpha")).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("answers with one clarification for an unclear pronoun", async () => {
    const { router, fake } = makeRouter();
    const response = await router.handleFinal(
      final("evt-pronoun", "它现在怎么样"),
    );
    expect(response.intent.kind).toBe("clarify");
    expect(fake.calls).toHaveLength(0);
    expect(Array.from(speak(response)).length).toBeLessThanOrEqual(
      MAX_TTS_CHARACTERS,
    );
  });

  it("lists tasks then inspects the ordinal from the adjacent list", async () => {
    const { router, fake } = makeRouter();
    const listResponse = await router.handleFinal(
      final("evt-list", "列出最近的任务"),
    );
    expect(listResponse.intent).toEqual({ kind: "list" });
    expect(speak(listResponse)).toContain("2");

    const detail = await router.handleFinal(final("evt-detail", "第一个详情"));
    expect(detail.intent).toEqual({ kind: "inspect", jobId: JOB_A });
    expect(detail.focusedJobId).toBe(JOB_A);
    expect(fake.calls.filter((call) => call.method === "get")).toHaveLength(1);
  });

  it("maps the ordinal to the newest list after a conflicting list", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-l1", "列出最近的任务"));
    fake.setTasks([task(JOB_B, "QH-BBB2", 5), task(JOB_A, "QH-AAA1", 2)]);
    await router.handleFinal(final("evt-l2", "列出最近的任务"));

    const detail = await router.handleFinal(final("evt-d2", "第一个详情"));
    expect(detail.intent).toEqual({ kind: "inspect", jobId: JOB_B });
  });

  it("expires the ordinal context after two minutes", async () => {
    const clock = { now: 1_000_000 };
    const { router, fake } = makeRouter(clock);
    await router.handleFinal(final("evt-l3", "列出最近的任务"));
    clock.now += 120_001;

    const detail = await router.handleFinal(final("evt-d3", "第一个详情"));
    expect(detail.intent.kind).toBe("clarify");
    expect(fake.calls.filter((call) => call.method === "get")).toHaveLength(0);
  });

  it("approves the first pending approval with its expected job revision", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-ap-list", "看一下待审批"));
    const response = await router.handleFinal(
      final("evt-approve", "批准第一个"),
    );

    expect(response.intent).toEqual({
      kind: "approve",
      approvalId: APPROVAL_1,
      expectedJobRevision: 2,
    });
    const decide = fake.calls.find((call) => call.method === "decide")
      ?.input as {
      approval_id: string;
      decision: string;
      expected_job_revision: number;
    };
    expect(decide).toEqual({
      approval_id: APPROVAL_1,
      decision: "approve",
      expected_job_revision: 2,
    });
    expect(speak(response)).toContain(statusText("succeeded"));
  });

  it("cancels an exact job by short id and current revision", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-c-list", "列出最近的任务"));
    const response = await router.handleFinal(
      final("evt-cancel", "取消 QH-BBB2"),
    );

    expect(response.intent).toEqual({
      kind: "cancel",
      jobId: JOB_B,
      expectedRevision: 5,
    });
    const cancel = fake.calls.find((call) => call.method === "cancel")
      ?.input as {
      job_id: string;
      expected_revision: number;
    };
    expect(cancel).toEqual({ job_id: JOB_B, expected_revision: 5 });
  });

  it("reads the focused task result", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-r-list", "列出最近的任务"));
    await router.handleFinal(final("evt-r-detail", "第一个详情"));
    const response = await router.handleFinal(
      final("evt-result", "读一下结果"),
    );

    expect(response.intent).toEqual({ kind: "result", jobId: JOB_A });
    expect(speak(response)).toContain("测试已通过");
    expect(
      fake.calls.filter((call) => call.method === "getResult"),
    ).toHaveLength(1);
  });

  it("asks one clarification when the repository is ambiguous", async () => {
    const fake = makeServices();
    const router = createLiveUtteranceRouter({
      sessionId: SESSION,
      ownerId: OWNER,
      repositories: [
        { id: "repo-alpha", displayName: "alpha", aliases: ["alpha"] },
        { id: "repo-beta", displayName: "beta alpha", aliases: ["alpha"] },
      ],
      jobs: fake.jobs,
      approvals: fake.approvalServices,
      now: () => 1_000_000,
    });
    const response = await router.handleFinal(
      final("evt-amb", "在 alpha 跑测试"),
    );

    expect(response.intent.kind).toBe("clarify");
    expect(fake.calls).toHaveLength(0);
  });

  it("treats exit as leaving live mode without cancelling work", async () => {
    const { router, fake } = makeRouter();
    const response = await router.handleFinal(
      final("evt-exit", "退出实时模式"),
    );

    expect(response.intent).toEqual({ kind: "exit" });
    expect(speak(response)).toBe("已退出实时模式。");
    expect(fake.calls).toHaveLength(0);
  });

  it("does nothing for an aborted session or a foreign owner", async () => {
    const controller = new AbortController();
    const { router, fake } = makeRouter();
    controller.abort();
    const aborted = await router.handleFinal(
      final("evt-abort", "列出最近的任务"),
      controller.signal,
    );
    const foreign = await router.handleFinal({
      sessionId: "ses_other",
      ownerId: "owner-2",
      eventId: "evt-foreign",
      text: "列出最近的任务",
    });

    expect(aborted.intent.kind).toBe("clarify");
    expect(foreign.intent.kind).toBe("clarify");
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the session context bounded and free of transcripts", async () => {
    const context = new RtcSessionContext({ ttlMs: 120_000 });
    context.recordTaskList(
      [task(JOB_A, "QH-AAA1", 2), task(JOB_B, "QH-BBB2", 5)].map((item) => ({
        jobId: item.job_id,
        shortId: item.short_id,
        revision: item.revision,
      })),
      1_000,
    );
    context.recordFinalDigest("digest-1");
    const snapshot = context.snapshot(1_000);
    expect(snapshot.taskIds).toEqual([JOB_A, JOB_B]);
    expect(snapshot.lastFinalDigest).toBe("digest-1");
    expect(Object.keys(snapshot)).not.toContain("text");
    expect(context.snapshot(121_001).ordinalFresh).toBe(false);
  });
});

describe("skill localization reuse", () => {
  const skillRoot = "../../../../../packages/qwen-skill/src";
  it("mirrors the Skill status and error copy exactly", () => {
    const presentation = readFileSync(
      new URL(`${skillRoot}/presentation.ts`, import.meta.url),
      "utf8",
    );
    const mutation = readFileSync(
      new URL(`${skillRoot}/mutation.ts`, import.meta.url),
      "utf8",
    );
    expect(presentation).toContain("MAX_TTS_CHARACTERS = 120");
    for (const [status, text] of Object.entries(STATUS_TEXT)) {
      expect(presentation).toContain(`${status}: "${text}"`);
    }
    for (const [code, copy] of Object.entries(ERROR_COPY)) {
      expect(mutation).toContain(`${code}: {`);
      expect(mutation).toContain(`message: "${copy.message}"`);
      expect(mutation).toContain(`nextAction: "${copy.nextAction}"`);
    }
  });
});
