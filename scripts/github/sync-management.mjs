import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertIssueInvariant,
  closingIssueNumbers,
  parseDependencies,
  STATUS_LABELS,
} from "./ai-issue-policy.mjs";
import { validateMigrationRegistry } from "./verify-ai-lifecycle.mjs";
import { eligibleCollaborators } from "./verify-pr-review-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const GH_COMMAND_TIMEOUT_MS = 10_000;
const MAX_HISTORICAL_PR_CANDIDATES_PER_ISSUE = 20;
const HISTORICAL_EVIDENCE_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, states: CLOSED, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        closedAt
        timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo { hasNextPage }
          nodes {
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest {
                  number
                  state
                  mergedAt
                  mergeCommit { oid }
                  body
                  baseRefName
                  repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

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

const dependencyDeclaration = (blockedBy) =>
  blockedBy.length === 0
    ? "Blocked by none"
    : `Blocked by ${blockedBy.map((number) => `#${number}`).join(", ")}`;

export const mergePlanIssueBody = ({
  existingBody,
  canonicalBody,
  blockedBy,
  active,
}) => {
  const existing = String(existingBody ?? "");
  if (active) {
    const currentDependencies = parseDependencies(existing);
    if (!sameValues(currentDependencies, blockedBy)) {
      throw new Error(
        "Active Issue dependencies cannot change without an explicit migration",
      );
    }
    return existing;
  }
  const declarations = existing.match(/^Blocked by[\t ]+.+$/gimu) ?? [];
  if (declarations.length > 1) {
    throw new Error("Issue body has multiple dependency declarations");
  }
  if (existing.trim() === "" || existing.split(/\r?\n/u).length <= 3) {
    return canonicalBody;
  }
  const desiredDependency = dependencyDeclaration(blockedBy);
  let merged =
    declarations.length === 1
      ? existing.replace(/^Blocked by[\t ]+.+$/imu, desiredDependency)
      : `${existing.trimEnd()}\n\n${desiredDependency}`;
  for (const heading of [
    "## Outcome",
    "## Verification",
    "## Risk and rollback",
    "## Definition of done",
  ]) {
    if (merged.includes(heading)) continue;
    const start = canonicalBody.indexOf(heading);
    const next = canonicalBody.indexOf("\n## ", start + heading.length);
    const section = canonicalBody.slice(
      start,
      next < 0 ? canonicalBody.length : next,
    );
    merged = `${merged.trimEnd()}\n\n${section.trim()}\n`;
  }
  return merged;
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
  historicalEvidence = null,
}) => {
  const states = statusNames(issue);
  const assignees = assigneeLogins(issue);
  if (String(issue.state).toLowerCase() === "closed") {
    if (
      String(issue.state_reason ?? issue.stateReason).toLowerCase() !==
        "completed" ||
      !historicalEvidence?.verified
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

export const verifyHistoricalClosure = ({
  issue,
  pullRequests,
  repository,
  defaultBranch,
  gh,
}) => {
  const issueNumber = Number(issue.number);
  const candidates = pullRequests.filter((pullRequest) => {
    const closing = closingIssueNumbers(pullRequest.body);
    const uniqueClosing = new Set(closing);
    return (
      pullRequest.state === "closed" &&
      Boolean(pullRequest.merged_at) &&
      Boolean(pullRequest.merge_commit_sha) &&
      closing.length > 0 &&
      uniqueClosing.size === 1 &&
      closing[0] === issueNumber &&
      pullRequest.base?.ref === defaultBranch &&
      pullRequest.base?.repo?.full_name?.toLowerCase() ===
        repository.toLowerCase()
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Issue #${issueNumber} needs exactly one historical merged closing pull request`,
    );
  }
  const pullRequest = candidates[0];
  const mergedAt = Date.parse(pullRequest.merged_at);
  const closedAt = Date.parse(issue.closed_at ?? "");
  if (Number.isNaN(mergedAt) || Number.isNaN(closedAt) || closedAt < mergedAt) {
    throw new Error(`Issue #${issueNumber} has invalid closure chronology`);
  }
  const comparison = gh.api(
    `repos/${repository}/compare/${pullRequest.merge_commit_sha}...${encodeURIComponent(defaultBranch)}`,
  );
  if (!["ahead", "identical"].includes(comparison.status)) {
    throw new Error(
      `Issue #${issueNumber} merge commit is not reachable from ${defaultBranch}`,
    );
  }
  return {
    verified: true,
    pullRequest: pullRequest.number,
    mergeCommit: pullRequest.merge_commit_sha,
  };
};

export const loadHistoricalPullRequests = ({ gh, issues, repository }) => {
  const [owner, name] = repository.split("/");
  const closedNumbers = new Set(
    issues
      .filter((issue) => String(issue.state).toLowerCase() === "closed")
      .map((issue) => Number(issue.number)),
  );
  const pullRequests = new Map();
  let cursor = null;
  for (let page = 1; page <= 100; page += 1) {
    const response = gh.graphql(HISTORICAL_EVIDENCE_QUERY, {
      owner,
      name,
      ...(cursor ? { cursor } : {}),
    });
    const connection = response?.data?.repository?.issues;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error(`Historical Issue evidence page ${page} is invalid`);
    }
    for (const issue of connection.nodes) {
      if (!closedNumbers.has(Number(issue.number))) continue;
      const timeline = issue.timelineItems;
      if (!timeline || !Array.isArray(timeline.nodes)) {
        throw new Error(`Issue #${issue.number} timeline evidence is invalid`);
      }
      if (timeline.pageInfo?.hasNextPage === true) {
        throw new Error(
          `Issue #${issue.number} exceeds the 100-event historical timeline cap`,
        );
      }
      const sources = timeline.nodes
        .map((event) => event?.source)
        .filter(
          (source) =>
            source?.__typename === "PullRequest" &&
            source.repository?.nameWithOwner?.toLowerCase() ===
              repository.toLowerCase(),
        );
      if (sources.length > MAX_HISTORICAL_PR_CANDIDATES_PER_ISSUE) {
        throw new Error(
          `Issue #${issue.number} exceeds the historical pull-request candidate cap`,
        );
      }
      for (const source of sources) {
        pullRequests.set(source.number, {
          number: source.number,
          state:
            source.state === "MERGED" ? "closed" : source.state.toLowerCase(),
          merged_at: source.mergedAt,
          merge_commit_sha: source.mergeCommit?.oid ?? null,
          body: source.body,
          base: {
            ref: source.baseRefName,
            repo: { full_name: source.repository.nameWithOwner },
          },
        });
      }
    }
    if (connection.pageInfo?.hasNextPage !== true) {
      return [...pullRequests.values()];
    }
    if (typeof connection.pageInfo.endCursor !== "string") {
      throw new Error(`Historical Issue evidence page ${page} has no cursor`);
    }
    cursor = connection.pageInfo.endCursor;
  }
  if (cursor) {
    throw new Error(
      "Historical Issue evidence reached the 100-page safety cap",
    );
  }
  if (closedNumbers.size > 0) {
    throw new Error("Historical Issue evidence was not returned by GitHub");
  }
  return [...pullRequests.values()];
};

export const createGh = (execFileSyncImpl, workspaceRoot) => {
  const run = (args, input, { readOnly = false } = {}) => {
    const methodIndex = args.indexOf("--method");
    const method =
      methodIndex >= 0 ? String(args[methodIndex + 1]).toUpperCase() : "GET";
    const attempts = method === "GET" || readOnly ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return execFileSyncImpl("gh", args, {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: GH_COMMAND_TIMEOUT_MS,
          input: input === undefined ? undefined : JSON.stringify(input),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        if (error?.code === "ETIMEDOUT" && attempt < attempts) continue;
        const target = args[1] ?? args[0] ?? "command";
        const reason = error?.code === "ETIMEDOUT" ? "timed out" : "failed";
        throw new Error(`GitHub CLI request ${reason}: ${target}`);
      }
    }
    throw new Error("GitHub CLI request exhausted its bounded attempts");
  };
  const json = (args, input) => JSON.parse(run(args, input).trim() || "null");
  const graphql = (query, variables) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      args.push("-F", `${key}=${value}`);
    }
    return JSON.parse(run(args, undefined, { readOnly: true }).trim());
  };
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
    const separator = path.includes("?") ? "&" : "?";
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const pageItems = api(`${path}${separator}page=${page}`);
      if (!Array.isArray(pageItems) || pageItems.length > 100) {
        throw new Error(`GitHub pagination page ${page} is invalid`);
      }
      items.push(...pageItems);
      if (pageItems.length < 100) return items;
    }
    throw new Error("GitHub pagination reached the 100-page safety cap");
  };
  const paginatedSearchApi = (path) => {
    const separator = path.includes("?") ? "&" : "?";
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = api(`${path}${separator}per_page=100&page=${page}`);
      if (
        !response ||
        !Number.isSafeInteger(response.total_count) ||
        response.total_count < 0 ||
        !Array.isArray(response.items) ||
        response.items.length > 100
      ) {
        throw new Error(`GitHub search page ${page} is invalid`);
      }
      if (response.total_count > 1_000) {
        throw new Error("GitHub search exceeds the 1000-result safety cap");
      }
      items.push(...response.items);
      if (items.length >= response.total_count) return items;
    }
    throw new Error("GitHub search reached the 10-page safety cap");
  };
  const serverTime = () => {
    const output = run(
      ["api", "rate_limit", "--method", "GET", "--include"],
      undefined,
    );
    const date = /^date:\s*(.+)$/imu.exec(output)?.[1]?.trim();
    const timestamp = Date.parse(date ?? "");
    if (Number.isNaN(timestamp)) {
      throw new Error("GitHub API did not return a valid Date header");
    }
    return new Date(timestamp).toISOString();
  };
  return { json, api, graphql, paginatedApi, paginatedSearchApi, serverTime };
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
  now = null,
} = {}) => {
  const unknown = argv.filter((value) => value !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown sync option: ${unknown[0]}`);
  const dryRun = argv.includes("--dry-run");
  const gh = createGh(execFileSyncImpl, workspaceRoot);
  const authoritativeNow = now ?? gh.serverTime();
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
  const existingMilestones = gh.paginatedApi(
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
  const openPullRequests = gh.paginatedSearchApi(
    `search/issues?q=${encodeURIComponent(`repo:${repository} is:pr is:open`)}`,
  );
  const historicalPullRequests = loadHistoricalPullRequests({
    gh,
    issues: existingIssues,
    repository,
  });
  const pullRequests = [
    ...new Map(
      [...openPullRequests, ...historicalPullRequests].map((pullRequest) => [
        pullRequest.number,
        pullRequest,
      ]),
    ).values(),
  ];
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
    const canonicalBody = renderPlanIssueBody({
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
          now: authoritativeNow,
        }).migrated,
    );
    if (migratedPullRequests.length > 1) {
      throw new Error(`Issue #${issue.number} has multiple migration records`);
    }
    const migrationOwner = migratedPullRequests[0]?.user?.login ?? null;
    const historicalEvidence =
      String(issue.state).toLowerCase() === "closed"
        ? verifyHistoricalClosure({
            issue,
            pullRequests,
            repository,
            defaultBranch: "main",
            gh,
          })
        : null;
    const lifecycle = deriveLifecycleState({
      issue,
      body: canonicalBody,
      dependencies,
      closingPullRequests,
      migrationOwner,
      historicalEvidence,
    });
    const body = mergePlanIssueBody({
      existingBody: issue.body,
      canonicalBody,
      blockedBy,
      active: ["in-progress", "review", "blocked"].includes(lifecycle.state),
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
