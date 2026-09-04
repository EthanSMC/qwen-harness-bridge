import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import test from "node:test";
import { parseDependencies } from "./ai-issue-policy.mjs";
import {
  branchProtectionFor,
  buildPlanIssueGraph,
  createGh,
  deriveLifecycleState,
  loadHistoricalPullRequests,
  loadPlanTasks,
  mergePlanIssueBody,
  renderPlanIssueBody,
  verifyHistoricalClosure,
} from "./sync-management.mjs";

const root = resolve(import.meta.dirname, "../..");
const syncManagement = resolve(root, "scripts/github/sync-management.mjs");
const NOW = "2026-09-04T12:00:00.000Z";

const definitions = [
  { file: "foundation.md", milestone: "M0", taskCount: 7 },
  { file: "connector.md", milestone: "M1", taskCount: 7 },
  { file: "skill.md", milestone: "M2", taskCount: 6 },
  { file: "reliability.md", milestone: "M3", taskCount: 7 },
  { file: "rtc.md", milestone: "M4", taskCount: 7 },
].map((definition) => ({
  ...definition,
  tasks: Array.from({ length: definition.taskCount }, (_, index) => ({
    number: index + 1,
  })),
}));

const existingIssues = (() => {
  let issueNumber = 1;
  return definitions.flatMap((definition) =>
    definition.tasks.map((task) => {
      const issue = {
        number: issueNumber,
        body: `<!-- qhb-plan-task:${basename(definition.file)}#task-${task.number} -->`,
      };
      issueNumber += 1;
      return issue;
    }),
  );
})();

test("orders tasks within each plan and gates each stable plan", () => {
  const graph = buildPlanIssueGraph(definitions, existingIssues);
  assert.deepEqual(graph.get(2).blockedBy, [1]);
  assert.deepEqual(graph.get(8).blockedBy, [7]);
  assert.deepEqual(graph.get(15).blockedBy, [14]);
  assert.deepEqual(graph.get(21).blockedBy, [20]);
  assert.deepEqual(graph.get(29).blockedBy, [28]);
  assert.deepEqual(graph.get(28).blockedBy, []);
  assert.deepEqual(graph.get(27).blockedBy, [26]);
});

const approvedPlans = loadPlanTasks();
const markerIssues = approvedPlans
  .flatMap((definition, planIndex) =>
    definition.tasks.map((task) => ({
      number: 1000 + planIndex * 100 + ((task.number * 3) % 8) * 11,
      body: task.marker,
      state: "open",
      labels: [],
      assignees: [],
    })),
  )
  .reverse();
const issueAt = (planIndex, taskNumber) =>
  markerIssues.find(
    (issue) =>
      issue.body === approvedPlans[planIndex].tasks[taskNumber - 1].marker,
  );
const approvedM1 = [[7], [1], [1], [1], [2, 3, 4], [2, 3, 4, 5], [6]];

test("resolves every approved M1 edge by marker and preserves all other plan edges", () => {
  const graph = buildPlanIssueGraph(approvedPlans, markerIssues);
  assert.equal(graph.size, 34);
  approvedPlans.forEach((definition, planIndex) => {
    definition.tasks.forEach((task) => {
      const prerequisites =
        planIndex === 1
          ? approvedM1[task.number - 1].map(
              (number) => issueAt(task.number === 1 ? 0 : 1, number).number,
            )
          : task.number > 1
            ? [issueAt(planIndex, task.number - 1).number]
            : planIndex > 0 && planIndex <= 3
              ? [
                  issueAt(
                    planIndex - 1,
                    approvedPlans[planIndex - 1].tasks.length,
                  ).number,
                ]
              : [];
      assert.deepEqual(
        graph.get(issueAt(planIndex, task.number).number),
        {
          issueNumber: issueAt(planIndex, task.number).number,
          marker: task.marker,
          blockedBy: prerequisites,
        },
        `${definition.file} Task ${task.number}`,
      );
    });
  });
});

test("fails closed for missing or duplicate M1 task marker identities", () => {
  for (const task of approvedPlans[1].tasks) {
    const issue = issueAt(1, task.number);
    assert.throws(
      () =>
        buildPlanIssueGraph(
          approvedPlans,
          markerIssues.filter((candidate) => candidate !== issue),
        ),
      /found 0/u,
    );
    assert.throws(
      () =>
        buildPlanIssueGraph(approvedPlans, [
          ...markerIssues,
          { ...issue, number: 9999 },
        ]),
      /found 2/u,
    );
  }
});

test("synchronizes complete M1 dependencies while preserving notes, checklists and active claims", () => {
  const graph = buildPlanIssueGraph(approvedPlans, markerIssues);
  for (const task of approvedPlans[1].tasks) {
    const blockedBy = graph.get(issueAt(1, task.number).number).blockedBy;
    const expected = approvedM1[task.number - 1].map(
      (number) => issueAt(task.number === 1 ? 0 : 1, number).number,
    );
    const canonicalBody = renderPlanIssueBody({
      definition: approvedPlans[1],
      task,
      repository: "owner/repository",
      blockedBy,
    });
    assert.deepEqual(parseDependencies(canonicalBody), expected);
    const contributorBody = `${canonicalBody.replace("- [ ]", "- [x]")}\n## Contributor notes\nKeep this note.\n`;
    const outdatedBody = contributorBody.replace(
      /^Blocked by .+$/mu,
      "Blocked by #9999",
    );
    assert.equal(
      mergePlanIssueBody({
        existingBody: outdatedBody,
        canonicalBody,
        blockedBy,
        active: false,
      }),
      contributorBody,
    );
    for (const state of ["in-progress", "review", "blocked"]) {
      const issue = {
        ...issueAt(1, task.number),
        body: contributorBody,
        labels: [`status:${state}`],
        assignees: ["owner"],
      };
      assert.deepEqual(
        deriveLifecycleState({ issue, body: canonicalBody, dependencies: [] }),
        { state, assignees: ["owner"] },
      );
      assert.equal(
        mergePlanIssueBody({
          existingBody: issue.body,
          canonicalBody,
          blockedBy,
          active: true,
        }),
        contributorBody,
      );
      assert.throws(
        () =>
          mergePlanIssueBody({
            existingBody: outdatedBody,
            canonicalBody,
            blockedBy,
            active: true,
          }),
        /cannot change/u,
      );
    }
  }
});

test("Task 5 waits for either transport or policy despite completed adapter", () => {
  const graph = buildPlanIssueGraph(approvedPlans, markerIssues);
  const task = approvedPlans[1].tasks[4];
  const issue = issueAt(1, 5);
  const blockedBy = graph.get(issue.number).blockedBy;
  const body = renderPlanIssueBody({
    definition: approvedPlans[1],
    task,
    repository: "owner/repository",
    blockedBy,
  });
  for (const openTask of [2, 3, null]) {
    const dependencies = blockedBy.map((number) => ({
      number,
      state:
        number === (openTask && issueAt(1, openTask).number)
          ? "open"
          : "closed",
      state_reason: "completed",
    }));
    assert.deepEqual(
      deriveLifecycleState({ issue, body, dependencies }),
      {
        state: openTask === null ? "ready" : "waiting",
        assignees: [],
      },
      `open task: ${openTask}`,
    );
  }
});

test("protects main with strict governance and runtime checks", () => {
  for (const reviewMode of ["formal", "solo"]) {
    const protection = branchProtectionFor(reviewMode);
    assert.deepEqual(protection.required_status_checks, {
      strict: true,
      contexts: ["governance", "runtime"],
    });
    assert.equal(protection.enforce_admins, true);
    assert.equal(protection.restrictions, null);
    assert.equal(protection.required_linear_history, true);
    assert.equal(protection.allow_force_pushes, false);
    assert.equal(protection.allow_deletions, false);
    assert.equal(protection.required_conversation_resolution, true);
    assert.equal(
      protection.required_pull_request_reviews === null,
      reviewMode === "solo",
    );
    if (reviewMode === "formal") {
      assert.deepEqual(protection.required_pull_request_reviews, {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      });
    }
  }
});

test("restarts one timed-out GET but never replays a write", () => {
  let getAttempts = 0;
  const getGh = createGh(() => {
    getAttempts += 1;
    if (getAttempts === 1) {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    }
    return "{}";
  }, root);
  assert.deepEqual(getGh.api("repos/octo/example"), {});
  assert.equal(getAttempts, 2);

  let postAttempts = 0;
  const postGh = createGh(() => {
    postAttempts += 1;
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  }, root);
  assert.throws(
    () => postGh.api("repos/octo/example/issues", "POST", { title: "test" }),
    /timed out/i,
  );
  assert.equal(postAttempts, 1);
});

test("renders one canonical dependency declaration and definition of done", () => {
  const body = renderPlanIssueBody({
    definition: {
      file: "foundation.md",
      milestone: "M0",
      prefix: "Foundation",
    },
    task: {
      number: 2,
      title: "Implement",
      marker: "<!-- qhb-plan-task:foundation.md#task-2 -->",
      section: "## Task 2: Implement\n\n## Definition of done\n\n- [ ] Pass",
    },
    repository: "owner/repository",
    blockedBy: [1],
  });
  assert.equal(body.match(/^Blocked by #1$/gmu)?.length, 1);
  assert.equal(body.match(/^## Definition of done$/gmu)?.length, 1);
});

test("preserves contributor notes and refuses active dependency rewrites", () => {
  const canonicalBody = [
    "<!-- qhb-plan-task:plan.md#task-2 -->",
    "",
    "Blocked by #1",
    "",
    "## Outcome",
    "Canonical outcome",
    "## Verification",
    "Canonical verification",
    "## Risk and rollback",
    "Canonical risk",
    "## Definition of done",
    "- [ ] Complete",
  ].join("\n");
  const existingBody = `${canonicalBody}\n\n## Contributor notes\nKeep this note.`;
  assert.match(
    mergePlanIssueBody({
      existingBody,
      canonicalBody,
      blockedBy: [3],
      active: false,
    }),
    /Contributor notes\nKeep this note/u,
  );
  assert.equal(
    mergePlanIssueBody({
      existingBody,
      canonicalBody,
      blockedBy: [1],
      active: true,
    }),
    existingBody,
  );
  assert.throws(
    () =>
      mergePlanIssueBody({
        existingBody,
        canonicalBody,
        blockedBy: [3],
        active: true,
      }),
    /cannot change/i,
  );
});

test("verifies one historical merge is reachable from main", () => {
  const issue = {
    number: 7,
    closed_at: "2026-09-04T12:00:00Z",
  };
  const pullRequest = {
    number: 36,
    state: "closed",
    merged_at: "2026-09-04T11:00:00Z",
    merge_commit_sha: "abcdef1",
    body: "Closes #7\n\n- Closes #7",
    base: { ref: "main", repo: { full_name: "octo/example" } },
  };
  const gh = { api: () => ({ status: "ahead" }) };
  assert.deepEqual(
    verifyHistoricalClosure({
      issue,
      pullRequests: [pullRequest],
      repository: "octo/example",
      defaultBranch: "main",
      gh,
    }),
    { verified: true, pullRequest: 36, mergeCommit: "abcdef1" },
  );
  assert.throws(
    () =>
      verifyHistoricalClosure({
        issue,
        pullRequests: [],
        repository: "octo/example",
        defaultBranch: "main",
        gh,
      }),
    /exactly one historical/i,
  );
});

test("loads paginated historical evidence and rejects truncated timelines", () => {
  let calls = 0;
  const pullSource = {
    __typename: "PullRequest",
    number: 36,
    state: "MERGED",
    mergedAt: "2026-09-04T11:00:00Z",
    mergeCommit: { oid: "abcdef1" },
    body: "Closes #7",
    baseRefName: "main",
    repository: { nameWithOwner: "octo/example" },
  };
  const gh = {
    graphql: () => {
      calls += 1;
      return {
        data: {
          repository: {
            issues: {
              pageInfo: {
                hasNextPage: calls === 1,
                endCursor: calls === 1 ? "cursor-1" : null,
              },
              nodes:
                calls === 1
                  ? []
                  : [
                      {
                        number: 7,
                        timelineItems: {
                          pageInfo: { hasNextPage: false },
                          nodes: [{ source: pullSource }],
                        },
                      },
                    ],
            },
          },
        },
      };
    },
  };
  assert.deepEqual(
    loadHistoricalPullRequests({
      gh,
      issues: [{ number: 7, state: "closed" }],
      repository: "octo/example",
    }),
    [
      {
        number: 36,
        state: "closed",
        merged_at: "2026-09-04T11:00:00Z",
        merge_commit_sha: "abcdef1",
        body: "Closes #7",
        base: { ref: "main", repo: { full_name: "octo/example" } },
      },
    ],
  );
  assert.equal(calls, 2);

  assert.throws(
    () =>
      loadHistoricalPullRequests({
        gh: {
          graphql: () => ({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      number: 7,
                      timelineItems: {
                        pageInfo: { hasNextPage: true },
                        nodes: [],
                      },
                    },
                  ],
                },
              },
            },
          }),
        },
        issues: [{ number: 7, state: "closed" }],
        repository: "octo/example",
      }),
    /timeline cap/i,
  );
});

test("derives ready, waiting, active, and historical states conservatively", () => {
  const body = [
    "## Outcome",
    "## Verification",
    "## Risk and rollback",
    "## Definition of done",
  ].join("\n");
  const base = {
    number: 7,
    state: "open",
    labels: [],
    assignees: [],
    body: "<!-- qhb-plan-task:plan.md#task-7 -->",
  };
  assert.deepEqual(
    deriveLifecycleState({
      issue: base,
      body,
      dependencies: [{ number: 6, state: "closed", state_reason: "completed" }],
    }),
    { state: "ready", assignees: [] },
  );
  assert.deepEqual(
    deriveLifecycleState({
      issue: base,
      body,
      dependencies: [{ number: 6, state: "open", state_reason: null }],
    }),
    { state: "waiting", assignees: [] },
  );
  assert.deepEqual(
    deriveLifecycleState({
      issue: {
        ...base,
        labels: ["status:review"],
        assignees: ["owner"],
      },
      body,
      dependencies: [],
      closingPullRequests: [{ number: 99 }],
    }),
    { state: "review", assignees: ["owner"] },
  );
  assert.deepEqual(
    deriveLifecycleState({
      issue: {
        ...base,
        state: "closed",
        state_reason: "completed",
        closed_at: NOW,
      },
      body,
      dependencies: [],
      historicalEvidence: { verified: true },
    }),
    { state: "done", assignees: [] },
  );
  assert.deepEqual(
    deriveLifecycleState({
      issue: base,
      body,
      dependencies: [],
      closingPullRequests: [{ number: 45 }],
      migrationOwner: "maintainer",
    }),
    { state: "review", assignees: ["maintainer"] },
  );
  assert.throws(
    () =>
      deriveLifecycleState({
        issue: base,
        body,
        dependencies: [],
        closingPullRequests: [{ number: 99 }],
      }),
    /without an active claim/u,
  );
  assert.throws(
    () =>
      deriveLifecycleState({
        issue: { ...base, state: "closed", state_reason: "not_planned" },
        body,
        dependencies: [],
      }),
    /historical evidence/u,
  );
});

test("dry-run selects paginated review mode and performs no writes", async (t) => {
  const fakeBin = await mkdtemp(join(tmpdir(), "qhb-sync-management-"));
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  const fakeGh = join(fakeBin, "gh");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "rate_limit" && args.includes("--include")) {
  process.stdout.write("HTTP/2 200 OK\\ndate: Fri, 04 Sep 2026 12:00:00 GMT\\n\\n{}");
  process.exit(0);
}
const owner = {
  login: "EthanSMC",
  role_name: "admin",
  permissions: { admin: true, maintain: true, push: true, pull: true, triage: true },
};
const pageOne = [
  owner,
  ...Array.from({ length: 99 }, (_, index) => ({
    login: \`read-only-\${index + 1}\`,
    role_name: "pull",
    permissions: { admin: false, maintain: false, push: false, pull: true, triage: false },
  })),
];
const pageTwo = [{
  login: "eligible-reviewer",
  role_name: "push",
  permissions: { admin: false, maintain: false, push: true, pull: true, triage: false },
}];
const plans = [
  ["2026-09-01-foundation-control-plane.md", 7],
  ["2026-09-01-harness-plugin-connector.md", 7],
  ["2026-09-01-qwen-skill-device-ux.md", 6],
  ["2026-09-01-reliability-operations.md", 7],
  ["2026-09-01-experimental-rtc.md", 7],
];
let next = 1;
const issues = plans.flatMap(([file, count]) =>
  Array.from({ length: count }, (_, index) => ({
    id: next,
    number: next++,
    state: "open",
    state_reason: null,
    body: \`<!-- qhb-plan-task:\${file}#task-\${index + 1} -->\`,
    labels: [],
    assignees: [],
  })),
);
const milestones = ["M0", "M1", "M2", "M3", "M4", "M5"].map((key, index) => ({
  number: index + 1,
  title: key === "M0" ? "M0 Foundation" : key,
}));
if (args.includes("POST") || args.includes("PATCH") || args.includes("PUT") || args.includes("DELETE")) {
  process.stderr.write("dry-run attempted a mutation");
  process.exit(2);
}
let response = {};
if (args[0] === "repo" && args[1] === "view") {
  response = { nameWithOwner: "EthanSMC/qwen-harness-bridge" };
} else if (args[0] === "api" && args[1] === "graphql") {
  response = {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  };
} else if (args[0] === "api" && args[1].includes("/collaborators?")) {
  response = args[1].includes("page=2") ? pageTwo : pageOne;
} else if (args[0] === "api" && args[1].includes("/milestones?")) {
  response = milestones;
} else if (args[0] === "api" && args[1].includes("/labels?")) {
  response = [];
} else if (args[0] === "api" && args[1].startsWith("search/issues?")) {
  response = { total_count: 0, items: [] };
} else if (args[0] === "api" && args[1].includes("/issues?")) {
  response = issues;
} else if (args[0] === "api" && args[1].includes("/pulls?")) {
  response = [];
}
process.stdout.write(JSON.stringify(response));
`,
    "utf8",
  );
  await chmod(fakeGh, 0o755);

  const output = execFileSync(process.execPath, [syncManagement, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const ledger = JSON.parse(output);
  assert.equal(ledger.mode, "dry-run");
  assert.equal(ledger.reviewMode, "formal");
  assert.deepEqual(ledger.eligibleReviewers, ["eligible-reviewer"]);
  assert.equal(ledger.issues.length, 34);
  assert.ok(ledger.issues.every(({ operation }) => operation === "update"));
});
