import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closingIssueNumbers } from "./ai-issue-controller.mjs";
import {
  assertIssueInvariant,
  parseDependencies,
  STATUS_LABELS,
} from "./ai-issue-policy.mjs";
import { validateMigrationRegistry } from "./verify-ai-lifecycle.mjs";
import { eligibleCollaborators } from "./verify-pr-review-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");

export const PLAN_DEFINITIONS = Object.freeze([
  {
    file: "docs/superpowers/plans/2026-09-01-foundation-control-plane.md",
    milestone: "M0",
    prefix: "Foundation",
    area: ["area:protocol", "area:control-plane"],
  },
  {
    file: "docs/superpowers/plans/2026-09-01-harness-plugin-connector.md",
    milestone: "M1",
    prefix: "Harness Connector",
    area: ["area:connector", "area:harness"],
  },
  {
    file: "docs/superpowers/plans/2026-09-01-qwen-skill-device-ux.md",
    milestone: "M2",
    prefix: "Qwen Skill",
    area: ["area:qwen-skill"],
  },
  {
    file: "docs/superpowers/plans/2026-09-01-reliability-operations.md",
    milestone: "M3",
    prefix: "Reliability",
    area: ["area:operations"],
  },
  {
    file: "docs/superpowers/plans/2026-09-01-experimental-rtc.md",
    milestone: "M4",
    prefix: "RTC",
    area: ["area:rtc"],
  },
]);

export const taskMarker = (file, taskNumber) =>
  `<!-- qhb-plan-task:${basename(file)}#task-${taskNumber} -->`;

export const loadPlanTasks = (
  definitions = PLAN_DEFINITIONS,
  workspaceRoot = root,
) =>
  definitions.map((definition) => {
    const source = readFileSync(
      resolve(workspaceRoot, definition.file),
      "utf8",
    );
    const matches = [...source.matchAll(/^## Task (\d+): (.+)$/gmu)];
    const tasks = matches.map((match, index) => {
      const number = Number(match[1]);
      const title = match[2];
      const start = match.index;
      const next = matches[index + 1]?.index;
      const completion = source.indexOf("## Plan Completion Evidence", start);
      const end = next ?? (completion < 0 ? source.length : completion);
      return {
        number,
        title,
        section: source.slice(start, end).trim(),
        marker: taskMarker(definition.file, number),
      };
    });
    if (
      tasks.length === 0 ||
      tasks.some((task, index) => task.number !== index + 1)
    ) {
      throw new Error(`${definition.file} has non-contiguous plan tasks`);
    }
    return { ...definition, tasks };
  });

const issueForTask = (definition, task, existingIssues) => {
  const marker = task.marker ?? taskMarker(definition.file, task.number);
  const matches = existingIssues.filter((issue) =>
    issue.body?.includes(marker),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${marker} must identify exactly one GitHub Issue; found ${matches.length}`,
    );
  }
  return matches[0];
};

export const buildPlanIssueGraph = (planDefinitions, existingIssues) => {
  const graph = new Map();
  const planIssues = planDefinitions.map((definition) =>
    definition.tasks.map((task) =>
      issueForTask(definition, task, existingIssues),
    ),
  );
  for (
    let definitionIndex = 0;
    definitionIndex < planDefinitions.length;
    definitionIndex += 1
  ) {
    const definition = planDefinitions[definitionIndex];
    for (
      let taskIndex = 0;
      taskIndex < definition.tasks.length;
      taskIndex += 1
    ) {
      const issue = planIssues[definitionIndex][taskIndex];
      const blockedBy = [];
      if (taskIndex > 0) {
        blockedBy.push(planIssues[definitionIndex][taskIndex - 1].number);
      } else if (definitionIndex > 0 && definitionIndex <= 3) {
        blockedBy.push(planIssues[definitionIndex - 1].at(-1).number);
      }
      graph.set(issue.number, {
        issueNumber: issue.number,
        marker:
          definition.tasks[taskIndex].marker ??
          taskMarker(definition.file, definition.tasks[taskIndex].number),
        blockedBy,
      });
    }
  }
  return graph;
};

const parseLabels = (workspaceRoot) => {
  const source = readFileSync(
    resolve(workspaceRoot, ".github/labels.yml"),
    "utf8",
  );
  return [
    ...source.matchAll(
      /- \{ name: "([^"]+)", color: "([0-9a-f]+)", description: "([^"]+)" \}/gu,
    ),
  ].map(([, name, color, description]) => ({ name, color, description }));
};

const parseMilestones = (workspaceRoot) => {
  const source = readFileSync(
    resolve(workspaceRoot, ".github/milestones.yml"),
    "utf8",
  );
  return [
    ...source.matchAll(
      /- \{ key: (M\d), title: "([^"]+)", description: "([^"]+)" \}/gu,
    ),
  ].map(([, key, title, description]) => ({ key, title, description }));
};

const taskAnchor = (task) =>
  `task-${task.number}-${task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;

const milestoneFor = (definition, task) =>
  definition.prefix === "Reliability" && task.number === 7
    ? "M5"
    : definition.milestone;

const riskFor = (milestone) =>
  ["M3", "M4", "M5"].includes(milestone) ? "risk:high" : "risk:medium";

const typeFor = (task) =>
  /Security|Threat|Acceptance|Test|Gate/iu.test(task.title)
    ? "type:test"
    : "type:feature";

const baseLabelsFor = (definition, task) => {
  const milestone = milestoneFor(definition, task);
  return [typeFor(task), ...definition.area, "priority:p1", riskFor(milestone)];
};

export const renderPlanIssueBody = ({
  definition,
  task,
  repository,
  blockedBy,
}) => {
  const dependencies =
    blockedBy.length === 0
      ? "Blocked by none"
      : `Blocked by ${blockedBy.map((number) => `#${number}`).join(", ")}`;
  const definitionOfDone = task.section.includes("## Definition of done")
    ? []
    : [
        "## Definition of done",
        "",
        "- [ ] Follow every test-first step above.",
        "- [ ] Keep the focused verification slice green.",
        "- [ ] Commit the smallest coherent change.",
        "- [ ] Update release acceptance evidence when this task closes a gate.",
        "",
      ];
  return [
    task.marker,
    "",
    dependencies,
    "",
    `[Authoritative plan task](https://github.com/${repository}/blob/main/${definition.file}#${taskAnchor(task)})`,
    "",
    "## Outcome",
    "",
    `Complete ${definition.prefix} Task ${task.number}: ${task.title}.`,
    "",
    "## Plan task",
    "",
    task.section,
    "",
    "## Verification",
    "",
    "Run every test-first command in the authoritative task section and record the observed results in the closing pull request.",
    "",
    "## Risk and rollback",
    "",
    `Risk classification: ${riskFor(milestoneFor(definition, task))}. Revert the task's coherent commit or pull request before dependent work proceeds.`,
    "",
    ...definitionOfDone,
  ].join("\n");
};

const statusNames = (issue) =>
  (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((label) => STATUS_LABELS.includes(label));

const assigneeLogins = (issue) =>
  (issue.assignees ?? [])
    .map((assignee) =>
      typeof assignee === "string" ? assignee : assignee?.login,
    )
    .filter(Boolean);

export const deriveLifecycleState = ({
  issue,
  body,
  dependencies,
  closingPullRequests = [],
  migrationOwner = null,
}) => {
  const states = statusNames(issue);
  const assignees = assigneeLogins(issue);
  if (String(issue.state).toLowerCase() === "closed") {
    if (
      String(issue.state_reason ?? issue.stateReason).toLowerCase() !==
        "completed" ||
      !issue.body?.includes("<!-- qhb-plan-task:")
    ) {
      throw new Error(
        `Issue #${issue.number} is closed without completed historical evidence`,
      );
    }
    return { state: "done", assignees: [] };
  }

  const active = states.filter((state) =>
    ["status:in-progress", "status:review", "status:blocked"].includes(state),
  );
  if (active.length > 0) {
    if (states.length !== 1 || assignees.length !== 1) {
      throw new Error(
        `Issue #${issue.number} active lifecycle state requires repair`,
      );
    }
    return { state: active[0].slice("status:".length), assignees };
  }
  if (states.length > 1 || assignees.length > 0) {
    throw new Error(
      `Issue #${issue.number} unclaimed lifecycle state requires repair`,
    );
  }
  if (closingPullRequests.length > 0) {
    if (closingPullRequests.length === 1 && migrationOwner) {
      return { state: "review", assignees: [migrationOwner] };
    }
    throw new Error(
      `Issue #${issue.number} has an open closing pull request without an active claim`,
    );
  }

  const dependencyReady = dependencies.every(
    (dependency) =>
      String(dependency.state).toLowerCase() === "closed" &&
      String(
        dependency.state_reason ?? dependency.stateReason,
      ).toLowerCase() === "completed",
  );
  const evidenceReady = [
    "## Outcome",
    "## Verification",
    "## Risk and rollback",
    "## Definition of done",
  ].every((heading) => body.includes(heading));
  return {
    state: dependencyReady && evidenceReady ? "ready" : "waiting",
    assignees: [],
  };
};

const createGh = (execFileSyncImpl, workspaceRoot) => {
  const json = (args, input) =>
    JSON.parse(
      execFileSyncImpl("gh", args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || "null",
    );
  const api = (path, method = "GET", body) =>
    json(
      [
        "api",
        path,
        "--method",
        method,
        ...(body === undefined ? [] : ["--input", "-"]),
      ],
      body,
    );
  const paginatedApi = (path) => {
    const pages = json([
      "api",
      path,
      "--method",
      "GET",
      "--paginate",
      "--slurp",
    ]);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("GitHub paginated response was not an array of pages");
    }
    return pages.flat();
  };
  return { json, api, paginatedApi };
};

const findTaskIssue = (task, issues) => {
  const matches = issues.filter((issue) => issue.body?.includes(task.marker));
  if (matches.length > 1) {
    throw new Error(`${task.marker} identifies multiple GitHub Issues`);
  }
  return matches[0] ?? null;
};

const sameValues = (left, right) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const verifyIssuePostcondition = ({ issue, desired, blockedBy }) => {
  if (issue.title !== desired.title || issue.body !== desired.body) {
    throw new Error(
      `Issue #${issue.number} did not retain synchronized content`,
    );
  }
  if (!sameValues(statusNames(issue), [`status:${desired.state}`])) {
    throw new Error(
      `Issue #${issue.number} lifecycle label postcondition failed`,
    );
  }
  if (!sameValues(assigneeLogins(issue), desired.assignees)) {
    throw new Error(`Issue #${issue.number} assignee postcondition failed`);
  }
  const parsed = parseDependencies(issue.body);
  if (!sameValues(parsed, blockedBy)) {
    throw new Error(`Issue #${issue.number} dependency postcondition failed`);
  }
  assertIssueInvariant(issue);
};

export const main = ({
  argv = process.argv.slice(2),
  execFileSyncImpl = execFileSync,
  workspaceRoot = root,
} = {}) => {
  const unknown = argv.filter((value) => value !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown sync option: ${unknown[0]}`);
  const dryRun = argv.includes("--dry-run");
  const gh = createGh(execFileSyncImpl, workspaceRoot);
  const repository = gh.json([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]).nameWithOwner;
  const [owner, name] = String(repository).split("/");
  if (!owner || !name)
    throw new Error(`invalid repository identity: ${repository}`);

  const directCollaborators = gh.paginatedApi(
    `repos/${repository}/collaborators?affiliation=direct&per_page=100`,
  );
  const eligibleReviewers = eligibleCollaborators(directCollaborators, owner);
  const reviewMode = eligibleReviewers.length > 0 ? "formal" : "solo";
  const labels = parseLabels(workspaceRoot);
  const migrations = JSON.parse(
    readFileSync(
      resolve(workspaceRoot, "docs/github/ai-lifecycle-migrations.json"),
      "utf8",
    ),
  );
  const existingLabels = gh.paginatedApi(
    `repos/${repository}/labels?per_page=100`,
  );
  const desiredMilestones = parseMilestones(workspaceRoot);
  const existingMilestones = gh.api(
    `repos/${repository}/milestones?state=all&per_page=100`,
  );
  const milestoneNumbers = new Map();
  const milestoneLedger = [];
  for (const desired of desiredMilestones) {
    const existing = existingMilestones.find(
      (item) => item.title === desired.title,
    );
    milestoneLedger.push({
      key: desired.key,
      operation: existing ? "update" : "create",
    });
    if (dryRun) {
      milestoneNumbers.set(desired.key, existing?.number ?? null);
      continue;
    }
    const saved = existing
      ? gh.api(`repos/${repository}/milestones/${existing.number}`, "PATCH", {
          title: desired.title,
          description: desired.description,
          state: "open",
        })
      : gh.api(`repos/${repository}/milestones`, "POST", {
          title: desired.title,
          description: desired.description,
        });
    milestoneNumbers.set(desired.key, saved.number);
  }

  if (!dryRun) {
    for (const label of labels) {
      const existing = existingLabels.find(
        ({ name: value }) => value === label.name,
      );
      if (existing) {
        gh.api(
          `repos/${repository}/labels/${encodeURIComponent(label.name)}`,
          "PATCH",
          label,
        );
      } else {
        gh.api(`repos/${repository}/labels`, "POST", label);
      }
    }
  }

  const definitions = loadPlanTasks(PLAN_DEFINITIONS, workspaceRoot);
  const existingIssues = gh
    .paginatedApi(`repos/${repository}/issues?state=all&per_page=100`)
    .filter((item) => !item.pull_request);
  const openPullRequests = gh.paginatedApi(
    `repos/${repository}/pulls?state=open&per_page=100`,
  );
  const taskIdentities = [];
  for (const definition of definitions) {
    for (const task of definition.tasks) {
      let issue = findTaskIssue(task, existingIssues);
      if (!issue && !dryRun) {
        const milestone = milestoneFor(definition, task);
        issue = gh.api(`repos/${repository}/issues`, "POST", {
          title: `[${milestone}] ${definition.prefix}: ${task.title}`,
          body: `${task.marker}\n\nBlocked by none\n`,
          labels: [...baseLabelsFor(definition, task), "status:waiting"],
          milestone: milestoneNumbers.get(milestone),
        });
        requirePositiveIssue(issue, task.marker);
        existingIssues.push(issue);
      }
      taskIdentities.push({ definition, task, issue });
    }
  }

  const missing = taskIdentities.filter(({ issue }) => !issue);
  if (missing.length > 0 && !dryRun) {
    throw new Error("Issue identity creation did not resolve every plan task");
  }
  const graph =
    missing.length === 0
      ? buildPlanIssueGraph(definitions, existingIssues)
      : null;
  const issueLedger = [];
  const desiredByNumber = new Map();
  for (const { definition, task, issue } of taskIdentities) {
    if (!issue) {
      issueLedger.push({
        operation: "create",
        marker: task.marker,
        blockedBy: [],
      });
      continue;
    }
    const blockedBy = graph.get(issue.number).blockedBy;
    const dependencies = blockedBy.map((number) => {
      const dependency = existingIssues.find(
        (candidate) => candidate.number === number,
      );
      if (!dependency)
        throw new Error(`Issue #${number} dependency is unavailable`);
      return dependency;
    });
    const body = renderPlanIssueBody({
      definition,
      task,
      repository,
      blockedBy,
    });
    const closingPullRequests = openPullRequests.filter((pullRequest) =>
      closingIssueNumbers(pullRequest.body).includes(issue.number),
    );
    const migratedPullRequests = closingPullRequests.filter(
      (pullRequest) =>
        validateMigrationRegistry(migrations, {
          mode: "report",
          pullRequestNumber: pullRequest.number,
          issueNumber: issue.number,
          now: new Date().toISOString(),
        }).migrated,
    );
    if (migratedPullRequests.length > 1) {
      throw new Error(`Issue #${issue.number} has multiple migration records`);
    }
    const migrationOwner = migratedPullRequests[0]?.user?.login ?? null;
    const lifecycle = deriveLifecycleState({
      issue,
      body,
      dependencies,
      closingPullRequests,
      migrationOwner,
    });
    const milestone = milestoneFor(definition, task);
    const desired = {
      title: `[${milestone}] ${definition.prefix}: ${task.title}`,
      body,
      labels: [...baseLabelsFor(definition, task), `status:${lifecycle.state}`],
      milestone: milestoneNumbers.get(milestone),
      state: lifecycle.state,
      assignees: lifecycle.assignees,
    };
    desiredByNumber.set(issue.number, { desired, blockedBy });
    issueLedger.push({
      operation: "update",
      issue: issue.number,
      blockedBy,
      lifecycle: lifecycle.state,
    });
    if (!dryRun) {
      gh.api(`repos/${repository}/issues/${issue.number}`, "PATCH", {
        title: desired.title,
        body: desired.body,
        labels: desired.labels,
        milestone: desired.milestone,
        assignees: desired.assignees,
      });
    }
  }

  const formalReviewRequirements = {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
    require_last_push_approval: true,
  };
  const requiredPullRequestReviews =
    reviewMode === "formal" ? formalReviewRequirements : null;
  const protection = {
    required_status_checks: { strict: true, contexts: ["governance"] },
    enforce_admins: true,
    required_pull_request_reviews: requiredPullRequestReviews,
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
  };
  if (!dryRun) {
    gh.api(`repos/${repository}/branches/main/protection`, "PUT", protection);
    for (const [issueNumber, desiredState] of desiredByNumber) {
      const current = gh.api(`repos/${repository}/issues/${issueNumber}`);
      verifyIssuePostcondition({
        issue: current,
        desired: desiredState.desired,
        blockedBy: desiredState.blockedBy,
      });
    }
  }

  const ledger = {
    mode: dryRun ? "dry-run" : "apply",
    repository,
    reviewMode,
    eligibleReviewers: eligibleReviewers.map(({ login }) => login),
    labels: labels.map(({ name: label }) => label),
    milestones: milestoneLedger,
    issues: issueLedger,
    branchProtection: "enabled",
  };
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(ledger)}\n`);
  } else {
    process.stdout.write(
      `Review mode selected: ${reviewMode}. Synchronized ${labels.length} labels, ${desiredMilestones.length} milestones, ${issueLedger.length} plan Issues; postconditions: verified.\n`,
    );
  }
  return ledger;
};

const requirePositiveIssue = (issue, marker) => {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1) {
    throw new Error(
      `${marker} creation did not return a positive Issue number`,
    );
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Management synchronization failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
