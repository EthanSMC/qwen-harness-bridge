import { describe, expect, it } from "vitest";
import { MAX_TTS_CHARACTERS } from "../../apps/control-plane/src/rtc/router/copy.js";
import type {
  LiveUtterance,
  RouterApproval,
  RouterTask,
  StableApprovalServices,
  StableJobServices,
} from "../../apps/control-plane/src/rtc/router/types.js";
import { createLiveUtteranceRouter } from "../../apps/control-plane/src/rtc/router/utterance-router.js";

const SESSION = "ses_integration";
const OWNER = "owner-integration";
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const APPROVAL_1 = "33333333-3333-4333-8333-333333333333";

type StableTable = "jobs" | "approvals";
type StableCall = {
  service: "jobs" | "approvals";
  method: string;
  input: unknown;
};

const createStableServices = () => {
  const calls: StableCall[] = [];
  const writes: Array<{ table: StableTable; id: string }> = [];
  const tasks: RouterTask[] = [
    {
      job_id: JOB_A,
      short_id: "QH-AAA1",
      status: "running",
      current_stage: "editing",
      revision: 2,
      title: "修复测试",
    },
    {
      job_id: JOB_B,
      short_id: "QH-BBB2",
      status: "waiting_approval",
      current_stage: "approval",
      revision: 5,
      title: "发布检查",
    },
  ];
  const approvals: RouterApproval[] = [
    {
      approval_id: APPROVAL_1,
      job_short_id: "QH-AAA1",
      job_revision: 2,
      action_summary: "修改两个文件",
      impact_summary: "写入工作区",
      expires_at: "2026-08-07T10:10:00Z",
    },
  ];
  const jobs: StableJobServices = {
    async submit(input) {
      calls.push({ service: "jobs", method: "submit", input });
      writes.push({ table: "jobs", id: JOB_A });
      return {
        job_id: JOB_A,
        short_id: "QH-AAA1",
        status: "queued",
        connector_status: "online",
        accepted_at: "2026-08-07T10:00:00Z",
        expires_at: "2026-08-07T11:00:00Z",
      };
    },
    async list(input) {
      calls.push({ service: "jobs", method: "list", input });
      return tasks;
    },
    async get(input) {
      calls.push({ service: "jobs", method: "get", input });
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
      calls.push({ service: "jobs", method: "cancel", input });
      writes.push({ table: "jobs", id: input.job_id });
      return {
        job_id: input.job_id,
        status: "cancelling",
        short_id: "QH-BBB2",
      };
    },
    async getResult(input) {
      calls.push({ service: "jobs", method: "getResult", input });
      writes.push({ table: "jobs", id: input.job_id });
      return {
        job_id: input.job_id,
        summary: "测试已通过",
        changed_files: [
          "apps/control-plane/src/rtc/router/utterance-router.ts",
        ],
        tests: { passed: 12, failed: 0, summary: "全部通过" },
        artifacts: [],
        acknowledged_at: "2026-08-07T10:05:00Z",
      };
    },
  };
  const approvalServices: StableApprovalServices = {
    async listPending(input) {
      calls.push({ service: "approvals", method: "listPending", input });
      return approvals;
    },
    async decide(input) {
      calls.push({ service: "approvals", method: "decide", input });
      writes.push({ table: "approvals", id: input.approval_id });
      return {
        approval_id: input.approval_id,
        decision: input.decision,
        revision: input.expected_job_revision,
      };
    },
  };
  return { jobs, approvalServices, calls, writes, tasks, approvals };
};

const createConversation = () => {
  const stable = createStableServices();
  const router = createLiveUtteranceRouter({
    sessionId: SESSION,
    ownerId: OWNER,
    repositories: [
      { id: "repo-alpha", displayName: "alpha 仓库", aliases: ["alpha"] },
      { id: "repo-gamma", displayName: "gamma 仓库", aliases: ["gamma"] },
    ],
    jobs: stable.jobs,
    approvals: stable.approvalServices,
    now: () => 2_000_000,
  });
  return { router, stable };
};

const final = (eventId: string, text: string): LiveUtterance => ({
  sessionId: SESSION,
  ownerId: OWNER,
  eventId,
  text,
});

const count = (calls: StableCall[], method: string): number =>
  calls.filter((call) => call.method === method).length;

describe("rtc conversation integration", () => {
  it("routes a multi-turn conversation through stable services only", async () => {
    const { router, stable } = createConversation();

    const submitted = await router.handleFinal(
      final("evt-1", "让 DeepSeek 在 alpha 仓库跑一下测试"),
    );
    expect(submitted.intent.kind).toBe("submit");
    expect(submitted.speech).toContain("QH-AAA1");

    const listed = await router.handleFinal(final("evt-2", "列出最近的任务"));
    expect(listed.intent).toEqual({ kind: "list" });
    expect(listed.speech).toContain("2");

    const detail = await router.handleFinal(final("evt-3", "第一个详情"));
    expect(detail.intent).toEqual({ kind: "inspect", jobId: JOB_A });
    expect(detail.focusedJobId).toBe(JOB_A);

    const approvals = await router.handleFinal(final("evt-4", "看一下待审批"));
    expect(approvals.intent.kind).toBe("list");
    expect(approvals.speech).toContain("1");

    const approved = await router.handleFinal(final("evt-5", "批准第一个"));
    expect(approved.intent).toEqual({
      kind: "approve",
      approvalId: APPROVAL_1,
      expectedJobRevision: 2,
    });

    const cancelled = await router.handleFinal(final("evt-6", "取消 QH-BBB2"));
    expect(cancelled.intent).toEqual({
      kind: "cancel",
      jobId: JOB_B,
      expectedRevision: 5,
    });

    const result = await router.handleFinal(final("evt-7", "读一下结果"));
    expect(result.intent).toEqual({ kind: "result", jobId: JOB_A });
    expect(result.speech).toContain("测试已通过");

    const pronoun = await router.handleFinal(final("evt-8", "它现在怎么样"));
    expect(pronoun.intent.kind).toBe("clarify");

    const ambiguous = await router.handleFinal(
      final("evt-9", "在 gamma 和 alpha 仓库跑测试"),
    );
    expect(ambiguous.intent.kind).toBe("clarify");

    const duplicate = await router.handleFinal(
      final("evt-1", "让 DeepSeek 在 alpha 仓库跑一下测试"),
    );
    expect(duplicate.speech).toBe(submitted.speech);

    const callsBeforePartial = stable.calls.length;
    expect(router.handlePartial("让 DeepSeek 在 alpha")).toBeNull();
    expect(stable.calls.length).toBe(callsBeforePartial);

    const exited = await router.handleFinal(final("evt-10", "退出实时模式"));
    expect(exited.intent).toEqual({ kind: "exit" });

    expect(count(stable.calls, "submit")).toBe(1);
    expect(count(stable.calls, "decide")).toBe(1);
    expect(count(stable.calls, "cancel")).toBe(1);
    expect(count(stable.calls, "get")).toBe(2);
    expect(count(stable.calls, "getResult")).toBe(1);

    const tables = new Set(stable.writes.map((write) => write.table));
    expect([...tables].sort()).toEqual(["approvals", "jobs"]);
    expect(
      stable.writes.every((write) => /^(jobs|approvals)$/u.test(write.table)),
    ).toBe(true);

    const snapshot = router.contextSnapshot();
    expect(snapshot.taskIds).toEqual([JOB_A, JOB_B]);
    expect(snapshot.approvalIds).toEqual([APPROVAL_1]);
    expect(snapshot.focusedJobId).toBeUndefined();
    expect(snapshot.lastFinalDigest).toBeDefined();
    expect(Object.keys(snapshot)).not.toContain("text");
    expect(JSON.stringify(snapshot)).not.toContain("跑一下测试");

    for (const response of [
      submitted,
      listed,
      detail,
      approvals,
      approved,
      cancelled,
      result,
      pronoun,
      ambiguous,
      duplicate,
      exited,
    ]) {
      expect(Array.from(response.speech).length).toBeLessThanOrEqual(
        MAX_TTS_CHARACTERS,
      );
      expect(JSON.stringify(response)).not.toMatch(
        /token|fingerprint|rtcToken/iu,
      );
    }
  });

  it("does not call stable services after the session is aborted", async () => {
    const { router, stable } = createConversation();
    const controller = new AbortController();
    controller.abort();
    const response = await router.handleFinal(
      final("evt-abort", "列出最近的任务"),
      controller.signal,
    );
    expect(response.intent.kind).toBe("clarify");
    expect(stable.calls).toHaveLength(0);
  });
});
