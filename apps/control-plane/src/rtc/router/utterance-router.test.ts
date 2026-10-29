import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_COPY, MAX_TTS_CHARACTERS, STATUS_TEXT } from "./copy.js";
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

type Gate = Readonly<{ promise: Promise<void>; open: () => void }>;

const createGate = (): Gate => {
  let open: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open?.() };
};

const makeServices = () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const tables = new Set<string>();
  let tasks = [task(JOB_A, "QH-AAA1", 2), task(JOB_B, "QH-BBB2", 5)];
  let approvals = [
    approval(APPROVAL_1, "QH-AAA1", 2),
    approval(APPROVAL_2, "QH-BBB2", 5),
  ];
  let detailStatus: "queued" | "running" | "failed" | "succeeded" = "running";
  let cancelStatus: string | undefined = "cancelling";
  let listGate: Promise<void> | undefined;
  let decideGate: Promise<void> | undefined;
  let decideMutates = true;

  const jobs: StableJobServices = {
    async submit(input) {
      calls.push({ method: "submit", input });
      tables.add("jobs");
      return receipt;
    },
    async list(input) {
      calls.push({ method: "list", input });
      if (listGate !== undefined) await listGate;
      return tasks;
    },
    async get(input) {
      calls.push({ method: "get", input });
      return {
        job_id: input.job_id,
        status: detailStatus,
        current_stage: "editing",
        revision: 2,
      };
    },
    async cancel(input) {
      calls.push({ method: "cancel", input });
      tables.add("jobs");
      return {
        job_id: input.job_id,
        status: cancelStatus,
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
    async listPending(input, signal) {
      calls.push({ method: "listPending", input });
      if (listGate !== undefined) await listGate;
      if (signal?.aborted) throw { code: "TRANSPORT_TIMEOUT" };
      return approvals;
    },
    async decide(input, signal) {
      calls.push({ method: "decide", input });
      if (decideGate !== undefined) await decideGate;
      if (decideMutates) tables.add("approvals");
      if (signal?.aborted) throw { code: "TRANSPORT_TIMEOUT" };
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
    setDetailStatus(next: "queued" | "running" | "failed" | "succeeded") {
      detailStatus = next;
    },
    setCancelStatus(next: string | undefined) {
      cancelStatus = next;
    },
    setApprovalListGate(gate: Gate | undefined) {
      listGate = gate?.promise;
    },
    setDecideGate(gate: Gate | undefined) {
      decideGate = gate?.promise;
      decideMutates = gate === undefined;
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

describe("final utterance router", () => {
  it("submits through the stable coordinator with a derived idempotency key", async () => {
    const { router, fake } = makeRouter();
    const response = await router.handleFinal(
      final("evt-1", "让 DeepSeek 在 alpha 仓库跑一下测试"),
    );

    expect(response.intent).toMatchObject({
      kind: "submit",
      repositoryId: "repo-alpha",
      mode: "normal",
    });
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
    expect(response.speech).toContain("QH-AAA1");
    expect(Array.from(response.speech).length).toBeLessThanOrEqual(
      MAX_TTS_CHARACTERS,
    );
  });

  it("uses a read-only mode when the user asks not to change code", async () => {
    const { router, fake } = makeRouter();
    const response = await router.handleFinal(
      final("evt-ro", "只在 alpha 仓库只读检查一下测试"),
    );
    expect(response.intent).toMatchObject({
      kind: "submit",
      mode: "read_only",
    });
    expect(fake.calls.filter((call) => call.method === "submit")).toHaveLength(
      1,
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

  it("deduplicates a concurrently delivered final", async () => {
    const { router, fake } = makeRouter();
    const utterance = final(
      "evt-concurrent",
      "让 DeepSeek 在 alpha 仓库跑一下测试",
    );
    const [first, second] = await Promise.all([
      router.handleFinal(utterance),
      router.handleFinal(utterance),
    ]);
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
  });

  it("lists tasks then inspects the ordinal from the adjacent list", async () => {
    const { router, fake } = makeRouter();
    const listResponse = await router.handleFinal(
      final("evt-list", "列出最近的任务"),
    );
    expect(listResponse.intent).toEqual({ kind: "list" });
    expect(listResponse.speech).toContain("2");

    const detail = await router.handleFinal(final("evt-detail", "第一个详情"));
    expect(detail.intent).toEqual({ kind: "inspect", jobId: JOB_A });
    expect(detail.focusedJobId).toBe(JOB_A);
    expect(fake.calls.filter((call) => call.method === "get")).toHaveLength(1);
  });

  it("inspects a task by short id after a list", async () => {
    const { router } = makeRouter();
    await router.handleFinal(final("evt-sid-list", "列出最近的任务"));
    const detail = await router.handleFinal(
      final("evt-sid-detail", "QH-BBB2 详情"),
    );
    expect(detail.intent).toEqual({ kind: "inspect", jobId: JOB_B });
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

  it("approves the first pending approval without claiming the job succeeded", async () => {
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
    expect(response.speech).toContain("已批准");
    expect(response.speech).not.toContain(STATUS_TEXT.succeeded);
  });

  it("rejects the second pending approval", async () => {
    const { router } = makeRouter();
    await router.handleFinal(final("evt-rj-list", "看一下待审批"));
    const response = await router.handleFinal(
      final("evt-reject", "拒绝第二个"),
    );
    expect(response.intent).toMatchObject({
      kind: "reject",
      approvalId: APPROVAL_2,
    });
    expect(response.speech).toContain("已拒绝");
  });

  it("reports the provider cancel status instead of assuming success", async () => {
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
    expect(response.speech).toContain("正在取消");
    expect(response.speech).not.toContain(STATUS_TEXT.succeeded);

    fake.setCancelStatus("succeeded");
    await router.handleFinal(final("evt-c-list2", "列出最近的任务"));
    const terminal = await router.handleFinal(
      final("evt-cancel2", "取消 QH-BBB2"),
    );
    expect(terminal.speech).toContain("取消未生效");
    expect(terminal.speech).toContain(STATUS_TEXT.succeeded);
  });

  it("reads the focused task result with its refreshed status", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-r-list", "列出最近的任务"));
    await router.handleFinal(final("evt-r-detail", "第一个详情"));
    const response = await router.handleFinal(
      final("evt-result", "读一下结果"),
    );

    expect(response.intent).toEqual({ kind: "result", jobId: JOB_A });
    expect(response.speech).toContain("测试已通过");
    expect(response.speech).toContain(STATUS_TEXT.running);
    expect(response.speech).not.toContain(STATUS_TEXT.succeeded);
    expect(
      fake.calls.filter((call) => call.method === "getResult"),
    ).toHaveLength(1);
  });

  it("does not claim success when the refreshed job failed", async () => {
    const { router, fake } = makeRouter();
    fake.setDetailStatus("failed");
    await router.handleFinal(final("evt-f-list", "列出最近的任务"));
    await router.handleFinal(final("evt-f-detail", "第一个详情"));
    const response = await router.handleFinal(
      final("evt-f-result", "读一下结果"),
    );
    expect(response.speech).toContain(STATUS_TEXT.failed);
    expect(response.speech).not.toContain(STATUS_TEXT.succeeded);
  });

  it("clears the focused task when a new list arrives", async () => {
    const { router } = makeRouter();
    await router.handleFinal(final("evt-cf-list", "列出最近的任务"));
    await router.handleFinal(final("evt-cf-detail", "第一个详情"));
    await router.handleFinal(final("evt-cf-list2", "列出最近的任务"));
    const response = await router.handleFinal(
      final("evt-cf-result", "读一下结果"),
    );
    expect(response.intent.kind).toBe("clarify");
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
    expect(response.speech).toBe("已退出实时模式。");
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

  it("does not mutate when the session closes during an approval list", async () => {
    const { router, fake } = makeRouter();
    const gate = createGate();
    fake.setApprovalListGate(gate);
    const controller = new AbortController();
    const pending = router.handleFinal(
      final("evt-abort-list", "看一下待审批"),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    gate.open();
    const response = await pending;

    expect(response.intent.kind).toBe("clarify");
    expect(fake.calls.filter((call) => call.method === "decide")).toHaveLength(
      0,
    );
    expect(router.contextSnapshot().approvalIds).toEqual([]);
  });

  it("does not record a decision when the session closes while deciding", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-dd-list", "看一下待审批"));
    const gate = createGate();
    fake.setDecideGate(gate);
    const controller = new AbortController();
    const pending = router.handleFinal(
      final("evt-dd-approve", "批准第一个"),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    gate.open();
    const response = await pending;

    expect(response.intent.kind).toBe("clarify");
    expect(fake.tables.has("approvals")).toBe(false);
  });

  it("keeps duplicate finals idempotent after more than sixteen later finals", async () => {
    const { router, fake } = makeRouter();
    await router.handleFinal(final("evt-dup-ap-list", "看一下待审批"));
    const approve = await router.handleFinal(
      final("evt-dup-approve", "批准第一个"),
    );
    for (let index = 0; index < 20; index += 1) {
      await router.handleFinal(final(`evt-bulk-${index}`, "列出最近的任务"));
    }
    const again = await router.handleFinal(
      final("evt-dup-approve", "批准第一个"),
    );

    expect(again.speech).toBe(approve.speech);
    expect(fake.calls.filter((call) => call.method === "decide")).toHaveLength(
      1,
    );
  });

  it("keeps the session context bounded and free of transcripts", () => {
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
