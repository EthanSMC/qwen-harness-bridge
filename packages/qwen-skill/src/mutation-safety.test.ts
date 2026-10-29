import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runContractSuite } from "./contract-runner.js";
import {
  APPROVAL_REFRESH_CODES,
  APPROVAL_SNAPSHOT_MAX_AGE_MS,
  type ApprovalSnapshot,
  type CancellationTarget,
  MAX_APPROVAL_ROWS,
  MAX_CONFIRMATION_CHARACTERS,
  mapStableError,
  type PendingApproval,
  parseOrdinal,
  planCancellation,
  planOrdinalDecision,
  presentCancellationResult,
  refreshAfterDecisionError,
  renderApprovalList,
  STABLE_ERROR_CODES,
} from "./mutation.js";

const fixturesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = Date.parse("2026-10-30T10:00:00.000Z");

const approval = (
  overrides: Partial<PendingApproval> = {},
): PendingApproval => ({
  approvalId: "11111111-1111-4111-8111-111111111111",
  shortId: "QH-2K7M",
  action: "运行数据库迁移",
  impact: "改动生产库结构",
  risk: "approval_required",
  expiresAt: "2026-10-30T10:30:00.000Z",
  jobRevision: 4,
  fingerprint: `sha256:${"a".repeat(64)}`,
  ...overrides,
});

const snapshot = (
  items: readonly PendingApproval[],
  listedAt = NOW - 1_000,
): ApprovalSnapshot => ({ listedAt, items });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const FINGERPRINT = /sha256:[0-9a-f]{16,}/iu;
const UNREPRESENTABLE = (value: string): boolean =>
  UUID.test(value) || FINGERPRINT.test(value);

type LooseStep = {
  kind: string;
  tool?: string;
  text?: string;
  arguments?: Record<string, unknown>;
};
type LooseTurn = { request_id: string; steps: LooseStep[] };
type LooseFixture = { fixture_id: string; turns: LooseTurn[] };

const fixture = (name: string): LooseFixture =>
  JSON.parse(
    readFileSync(join(fixturesDirectory, `${name}.json`), "utf8"),
  ) as LooseFixture;

const MUTATION_TOOLS = new Set([
  "submit_task",
  "cancel_task",
  "decide_approval",
]);

const flattened = (value: LooseFixture) =>
  value.turns.flatMap((turn, turnIndex) =>
    turn.steps.map((step, stepIndex) => ({ turnIndex, stepIndex, step })),
  );

const mutationCalls = (value: LooseFixture) =>
  flattened(value).filter(
    (entry) =>
      entry.step.kind === "mcp_call" &&
      MUTATION_TOOLS.has(String(entry.step.tool)),
  );

const precedingResult = (
  value: LooseFixture,
  turnIndex: number,
  stepIndex: number,
): { turnIndex: number; step: LooseStep } | undefined => {
  const entries = flattened(value);
  const position = entries.findIndex(
    (entry) => entry.turnIndex === turnIndex && entry.stepIndex === stepIndex,
  );
  for (let index = position - 1; index >= 0; index -= 1) {
    if (entries[index]?.step.kind === "mcp_result") {
      return {
        turnIndex: entries[index].turnIndex,
        step: entries[index].step,
      };
    }
  }
  return undefined;
};

describe("approval list rendering", () => {
  it("renders at most five rows with short id, action, impact, risk and expiry", () => {
    const items = Array.from({ length: MAX_APPROVAL_ROWS + 1 }, (_, index) =>
      approval({
        approvalId: `1111111${index}-1111-4111-8111-11111111111${index}`,
        shortId: `QH-2K7${index}`,
        jobRevision: index + 1,
      }),
    );
    const rendered = renderApprovalList(snapshot(items), NOW);

    expect(rendered.rows).toHaveLength(MAX_APPROVAL_ROWS);
    expect(rendered.hiddenCount).toBe(1);
    for (const [index, row] of rendered.rows.entries()) {
      expect(row.ordinal).toBe(index + 1);
      expect(row.shortId.length).toBeGreaterThan(0);
      expect(row.action.length).toBeGreaterThan(0);
      expect(row.impact.length).toBeGreaterThan(0);
      expect(row.risk.length).toBeGreaterThan(0);
      expect(row.expiryText.length).toBeGreaterThan(0);
      expect(UNREPRESENTABLE(JSON.stringify(row))).toBe(false);
    }
  });

  it("keeps the MCP order instead of sorting the pending approvals", () => {
    const first = approval({ shortId: "QH-AAAA", action: "先到的审批" });
    const second = approval({
      approvalId: "22222222-2222-4222-8222-222222222222",
      shortId: "QH-BBBB",
      action: "后到的审批",
    });
    const rendered = renderApprovalList(snapshot([first, second]), NOW);

    expect(rendered.rows.map((row) => row.shortId)).toEqual([
      "QH-AAAA",
      "QH-BBBB",
    ]);
  });

  it("renders any ISO offset in UTC instead of trusting the raw wall clock", () => {
    const rendered = renderApprovalList(
      snapshot([approval({ expiresAt: "2026-10-30T18:30:00+08:00" })]),
      NOW,
    );

    expect(rendered.rows[0].expiryText).toContain("10-30 10:30 UTC");
  });
});

describe("ordinal approval decisions", () => {
  it("requires list_pending_approvals immediately before an ordinal decision", () => {
    const withoutSnapshot = planOrdinalDecision({
      utterance: "批准第二个",
      decision: "approve",
      now: NOW,
    });
    const staleSnapshot = planOrdinalDecision({
      utterance: "批准第二个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([approval()], NOW - APPROVAL_SNAPSHOT_MAX_AGE_MS - 1),
    });

    expect(withoutSnapshot.kind).toBe("list-required");
    expect(staleSnapshot.kind).toBe("list-required");
    expect(withoutSnapshot).not.toHaveProperty("arguments");
    expect(staleSnapshot).not.toHaveProperty("arguments");
  });

  it("maps the ordinal to the exact approval and revision from the preceding list", () => {
    const first = approval({ shortId: "QH-AAAA", jobRevision: 3 });
    const second = approval({
      approvalId: "22222222-2222-4222-8222-222222222222",
      shortId: "QH-BBBB",
      jobRevision: 8,
    });
    const plan = planOrdinalDecision({
      utterance: "批准第二个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([first, second]),
    });

    expect(plan.kind).toBe("decide");
    if (plan.kind !== "decide") return;
    expect(plan.arguments.approval_id).toBe(second.approvalId);
    expect(plan.arguments.decision).toBe("approve");
    expect(plan.arguments.expected_job_revision).toBe(8);
  });

  it("speaks one confirmation sentence with action and impact but never the fingerprint", () => {
    const item = approval({
      action: "运行数据库迁移",
      impact: "改动生产库结构",
    });
    const plan = planOrdinalDecision({
      utterance: "批准第一个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([item]),
    });

    expect(plan.kind).toBe("decide");
    if (plan.kind !== "decide") return;
    expect(plan.confirmation).toContain(item.action);
    expect(plan.confirmation).toContain(item.impact);
    expect(plan.confirmation).not.toContain(item.fingerprint);
    expect([...plan.confirmation].length).toBeLessThanOrEqual(
      MAX_CONFIRMATION_CHARACTERS,
    );
    expect(UNREPRESENTABLE(plan.confirmation)).toBe(false);
  });

  it("asks for clarification with zero mutation when the request has no ordinal", () => {
    const plan = planOrdinalDecision({
      utterance: "批准它",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([approval()]),
    });
    const emptyPlan = planOrdinalDecision({
      utterance: "批准第二个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([]),
    });

    expect(plan.kind).toBe("clarify");
    expect(emptyPlan.kind).toBe("clarify");
    expect(plan).not.toHaveProperty("arguments");
    expect(emptyPlan).not.toHaveProperty("arguments");
  });

  it("refuses an ordinal outside the current list without mutating", () => {
    const plan = planOrdinalDecision({
      utterance: "批准第五个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([approval()]),
    });

    expect(plan.kind).toBe("clarify");
    expect(plan).not.toHaveProperty("arguments");
  });

  it("refuses an ordinal that only addresses a hidden approval row", () => {
    const items = Array.from({ length: MAX_APPROVAL_ROWS + 1 }, (_, index) =>
      approval({
        approvalId: `0000000${index}-0000-4000-8000-00000000000${index}`,
        shortId: `QH-H1D${index}`,
        jobRevision: index + 1,
      }),
    );
    const hidden = planOrdinalDecision({
      utterance: "批准第六个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot(items),
    });
    const visible = planOrdinalDecision({
      utterance: "批准第五个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot(items),
    });

    expect(hidden.kind).toBe("clarify");
    expect(hidden).not.toHaveProperty("arguments");
    expect(visible.kind).toBe("decide");
    if (visible.kind !== "decide") return;
    expect(visible.arguments.approval_id).toBe(
      items[MAX_APPROVAL_ROWS - 1].approvalId,
    );
    expect(visible.arguments.expected_job_revision).toBe(MAX_APPROVAL_ROWS);
  });

  it("refuses an approval whose expiry cannot be parsed", () => {
    const plan = planOrdinalDecision({
      utterance: "批准第一个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([approval({ expiresAt: "not-a-timestamp" })]),
    });

    expect(plan.kind).toBe("clarify");
    expect(plan).not.toHaveProperty("arguments");
    if (plan.kind === "clarify") expect(plan.reason).toContain("有效期");
  });

  it("refuses an expired approval and requires a fresh list", () => {
    const plan = planOrdinalDecision({
      utterance: "批准第一个",
      decision: "approve",
      now: NOW,
      snapshot: snapshot([approval({ expiresAt: "2026-10-30T09:59:00.000Z" })]),
    });

    expect(plan.kind).toBe("clarify");
    expect(plan).not.toHaveProperty("arguments");
    if (plan.kind === "clarify") {
      expect(plan.reason).toContain("过期");
    }
  });

  it("rejects with the same revision source as an approval", () => {
    const plan = planOrdinalDecision({
      utterance: "拒绝第一个",
      decision: "reject",
      now: NOW,
      snapshot: snapshot([approval({ jobRevision: 6 })]),
    });

    expect(plan.kind).toBe("decide");
    if (plan.kind !== "decide") return;
    expect(plan.arguments.decision).toBe("reject");
    expect(plan.arguments.expected_job_revision).toBe(6);
  });

  it("parses Chinese ordinals and refuses texts without one", () => {
    expect(parseOrdinal("批准第一个")).toBe(1);
    expect(parseOrdinal("批准第2个")).toBe(2);
    expect(parseOrdinal("拒绝第三个")).toBe(3);
    expect(parseOrdinal("批准它")).toBeUndefined();
    expect(parseOrdinal("批准这个")).toBeUndefined();
  });
});

describe("decision conflict recovery", () => {
  it.each(APPROVAL_REFRESH_CODES)(
    "refreshes and explains %s without retrying the mutation",
    (code) => {
      const refresh = refreshAfterDecisionError(code, {
        shortId: "QH-2K7M",
        status: "waiting_approval",
      });
      const runningRefresh = refreshAfterDecisionError(code, {
        shortId: "QH-2K7M",
        status: "running",
      });

      expect(refresh.retried).toBe(false);
      expect(refresh.refresh).toBe("list_pending_approvals");
      expect(refresh.explanation).toContain("QH-2K7M");
      expect(refresh.explanation).toContain("等待你的批准");
      expect(runningRefresh.explanation).toContain("正在执行");
      expect(refresh.explanation).not.toMatch(/重试/iu);
      for (const explanation of [
        refresh.explanation,
        runningRefresh.explanation,
      ]) {
        expect(explanation).toContain("状态");
        expect(explanation).not.toMatch(
          /waiting_approval|running|succeeded|failed|cancelled|expired|revision/iu,
        );
        expect(UNREPRESENTABLE(explanation)).toBe(false);
      }
      expect(refresh).not.toHaveProperty("arguments");
    },
  );
});

describe("cancellation", () => {
  const running: CancellationTarget = {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    shortId: "QH-9F3C",
    status: "running",
    revision: 7,
  };

  it("cancels the exact job once with the current revision", () => {
    const plan = planCancellation({ target: running, now: NOW });

    expect(plan.kind).toBe("cancel");
    if (plan.kind !== "cancel") return;
    expect(plan.arguments.job_id).toBe(running.jobId);
    expect(plan.arguments.expected_revision).toBe(7);
    expect(Object.keys(plan.arguments).sort()).toEqual([
      "expected_revision",
      "job_id",
    ]);
    expect(plan.confirmation).toContain("QH-9F3C");
    expect(UNREPRESENTABLE(plan.confirmation)).toBe(false);
  });

  it("never emits a mutation for a terminal or ambiguous job", () => {
    const terminal = planCancellation({
      target: { ...running, status: "succeeded" },
      now: NOW,
    });
    const ambiguous = planCancellation({ now: NOW });
    const alreadyCancelling = planCancellation({
      target: { ...running, status: "cancelling" },
      now: NOW,
    });

    for (const plan of [terminal, ambiguous, alreadyCancelling]) {
      expect(plan.kind).not.toBe("cancel");
      expect(plan).not.toHaveProperty("arguments");
    }
  });

  it("presents the returned authoritative state", () => {
    const queued = presentCancellationResult({
      shortId: "QH-9F3C",
      status: "cancelled",
    });
    const runningState = presentCancellationResult({
      shortId: "QH-9F3C",
      status: "cancelling",
    });
    const raced = presentCancellationResult({
      shortId: "QH-9F3C",
      status: "succeeded",
    });

    expect(queued.kind).toBe("terminal");
    expect(queued.text).toContain("已取消");
    expect(runningState.kind).toBe("cancelling");
    expect(runningState.text).toContain("正在取消");
    expect(raced.kind).toBe("terminal");
    expect(raced.text).toContain("已完成");
    expect(UNREPRESENTABLE(raced.text)).toBe(false);
  });
});

describe("stable error mapping", () => {
  const UNSAFE = [
    /\bat\s+[\w.$]+:\d+/iu,
    /(?:Error|TypeError|Stack):/u,
    /Bearer\s+\S+/iu,
    /\bsk-[A-Za-z0-9_-]{8,}/u,
    /[A-Za-z]:[\\/]/u,
    /sha256:[0-9a-f]{16,}/iu,
  ];

  it("covers the eleven stable error classes", () => {
    expect(STABLE_ERROR_CODES).toHaveLength(11);
    for (const code of STABLE_ERROR_CODES) {
      const copy = mapStableError(code);
      expect(copy.code).toBe(code);
      expect(copy.message).toMatch(/[\u4e00-\u9fff]/u);
      expect(copy.nextAction).toMatch(/[\u4e00-\u9fff]/u);
      expect(copy.refresh).toBe(APPROVAL_REFRESH_CODES.includes(code as never));
      for (const pattern of UNSAFE) {
        expect(copy.message).not.toMatch(pattern);
        expect(copy.nextAction).not.toMatch(pattern);
      }
    }
  });

  it("documents every stable error and approval refresh code in errors.md", () => {
    const errors = readFileSync(
      join(packageRoot, "references", "errors.md"),
      "utf8",
    );

    for (const code of [...STABLE_ERROR_CODES, ...APPROVAL_REFRESH_CODES]) {
      expect(errors).toContain(code);
    }
    expect(errors).toMatch(/下一步/u);
    for (const pattern of UNSAFE) expect(errors).not.toMatch(pattern);
  });
});

describe("mutation safety fixtures", () => {
  const mutationFixtureNames = [
    "approval-list",
    "approval-confirm",
    "approval-stale",
    "approval-ambiguous",
    "approval-expired",
    "cancel-running",
    "cancel-race",
    "errors",
  ];

  it("ships every mutation-safety fixture without contract violations", () => {
    for (const name of mutationFixtureNames) {
      expect(fixture(name).fixture_id).toBe(name);
    }
    expect(runContractSuite(fixturesDirectory).violations).toEqual([]);
  });

  it.each([
    "approval-list",
    "approval-stale",
    "approval-ambiguous",
    "approval-expired",
  ])("keeps %s free of any mutation call", (name) => {
    expect(mutationCalls(fixture(name))).toEqual([]);
  });

  it("takes expected_job_revision from the approval list immediately before the decision", () => {
    const value = fixture("approval-confirm");
    const decisions = flattened(value).filter(
      (entry) =>
        entry.step.kind === "mcp_call" && entry.step.tool === "decide_approval",
    );
    expect(decisions).toHaveLength(1);

    const decision = decisions[0];
    const prior = precedingResult(
      value,
      decision.turnIndex,
      decision.stepIndex,
    );
    expect(prior?.step.tool).toBe("list_pending_approvals");
    expect(decision.turnIndex - Number(prior?.turnIndex)).toBe(1);

    const list = JSON.parse(String(prior?.step.text)) as {
      approvals: { approval_id: string; job_revision: number }[];
    };
    expect(decision.step.arguments?.approval_id).toBe(
      list.approvals[1].approval_id,
    );
    expect(decision.step.arguments?.expected_job_revision).toBe(
      list.approvals[1].job_revision,
    );
  });

  it.each(["cancel-running", "cancel-race"])(
    "cancels once in %s with the resolved revision",
    (name) => {
      const value = fixture(name);
      const cancellations = mutationCalls(value).filter(
        (entry) => entry.step.tool === "cancel_task",
      );
      expect(cancellations).toHaveLength(1);

      const cancellation = cancellations[0];
      const prior = precedingResult(
        value,
        cancellation.turnIndex,
        cancellation.stepIndex,
      );
      expect(prior?.step.tool).toBe("get_task");
      const detail = JSON.parse(String(prior?.step.text)) as {
        revision: number;
      };
      expect(cancellation.step.arguments?.expected_revision).toBe(
        detail.revision,
      );
    },
  );

  it("keeps a running cancellation in progress and presents the race result", () => {
    const running = fixture("cancel-running");
    const race = fixture("cancel-race");
    const textOf = (value: LooseFixture): string =>
      flattened(value)
        .map((entry) => String(entry.step.text ?? ""))
        .join("\n");

    const runningResult = flattened(running).filter(
      (entry) =>
        entry.step.kind === "mcp_result" && entry.step.tool === "cancel_task",
    );
    expect(String(runningResult[0]?.step.text)).toContain("cancelling");
    expect(textOf(running)).toContain("正在取消");
    expect(textOf(race)).toContain("取消未生效");
    expect(textOf(race)).toContain("已完成");
  });

  it("maps every stable error class inside the errors fixture", () => {
    const text = flattened(fixture("errors"))
      .map((entry) => String(entry.step.text ?? ""))
      .join("\n");

    for (const code of STABLE_ERROR_CODES) {
      expect(text).toContain(code);
    }
  });
});
