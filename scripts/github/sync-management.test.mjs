import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  buildPlanIssueGraph,
  deriveLifecycleState,
  renderPlanIssueBody,
} from "./sync-management.mjs";

const root = resolve(import.meta.dirname, "../..");
const syncManagement = resolve(root, "scripts/github/sync-management.mjs");

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
      },
      body,
      dependencies: [],
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
} else if (args[0] === "api" && args[1].includes("/collaborators?")) {
  response = args.includes("--paginate") && args.includes("--slurp")
    ? [pageOne, pageTwo]
    : pageOne;
} else if (args[0] === "api" && args[1].includes("/milestones?")) {
  response = milestones;
} else if (args[0] === "api" && args[1].includes("/labels?")) {
  response = args.includes("--paginate") && args.includes("--slurp") ? [[]] : [];
} else if (args[0] === "api" && args[1].includes("/issues?")) {
  response = args.includes("--paginate") && args.includes("--slurp") ? [issues] : issues;
} else if (args[0] === "api" && args[1].includes("/pulls?")) {
  response = args.includes("--paginate") && args.includes("--slurp") ? [[]] : [];
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
