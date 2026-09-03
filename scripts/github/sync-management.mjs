import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { eligibleCollaborators } from "./verify-pr-review-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const json = (args, input) =>
  JSON.parse(
    execFileSync("gh", args, {
      cwd: root,
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
  const pages = json(["api", path, "--method", "GET", "--paginate", "--slurp"]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("GitHub paginated response was not an array of pages");
  }
  return pages.flat();
};

const repo = json(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
const [owner, name] = repo.split("/");
if (!owner || !name) throw new Error(`invalid repository identity: ${repo}`);

const directCollaborators = paginatedApi(
  `repos/${repo}/collaborators?affiliation=direct&per_page=100`,
);
if (!Array.isArray(directCollaborators))
  throw new Error("GitHub collaborators response was not an array");
const eligibleReviewers = eligibleCollaborators(directCollaborators, owner);
const reviewMode = eligibleReviewers.length > 0 ? "formal" : "solo";
const eligibleReviewerLogins =
  eligibleReviewers.map(({ login }) => login).join(", ") || "none";
console.log(
  `Review mode selected: ${reviewMode}; direct eligible reviewers excluding ${owner}: ${eligibleReviewerLogins}.`,
);

const labelSource = readFileSync(resolve(root, ".github/labels.yml"), "utf8");
const labels = [
  ...labelSource.matchAll(
    /- \{ name: "([^"]+)", color: "([0-9a-f]+)", description: "([^"]+)" \}/g,
  ),
].map(([, labelName, color, description]) => ({
  name: labelName,
  color,
  description,
}));
for (const label of labels) {
  try {
    api(
      `repos/${repo}/labels/${encodeURIComponent(label.name)}`,
      "PATCH",
      label,
    );
  } catch {
    api(`repos/${repo}/labels`, "POST", label);
  }
}

const milestoneSource = readFileSync(
  resolve(root, ".github/milestones.yml"),
  "utf8",
);
const desiredMilestones = [
  ...milestoneSource.matchAll(
    /- \{ key: (M\d), title: "([^"]+)", description: "([^"]+)" \}/g,
  ),
].map(([, key, title, description]) => ({ key, title, description }));
const existingMilestones = api(
  `repos/${repo}/milestones?state=all&per_page=100`,
);
const milestoneNumbers = new Map();
for (const desired of desiredMilestones) {
  const existing = existingMilestones.find(
    (item) => item.title === desired.title,
  );
  const saved = existing
    ? api(`repos/${repo}/milestones/${existing.number}`, "PATCH", {
        title: desired.title,
        description: desired.description,
        state: "open",
      })
    : api(`repos/${repo}/milestones`, "POST", {
        title: desired.title,
        description: desired.description,
      });
  milestoneNumbers.set(desired.key, saved.number);
}

const planDefinitions = [
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
];

const existingIssues = api(
  `repos/${repo}/issues?state=all&per_page=100`,
).filter((item) => !item.pull_request);
for (const definition of planDefinitions) {
  const source = readFileSync(resolve(root, definition.file), "utf8");
  const matches = [...source.matchAll(/^## Task (\d+): (.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const taskNumber = Number(match[1]);
    const taskTitle = match[2];
    const start = match.index;
    const end =
      index + 1 < matches.length
        ? matches[index + 1].index
        : source.indexOf("## Plan Completion Evidence", start);
    const section = source.slice(start, end < 0 ? source.length : end).trim();
    const marker = `<!-- qhb-plan-task:${basename(definition.file)}#task-${taskNumber} -->`;
    const milestoneKey =
      definition.prefix === "Reliability" && taskNumber === 7
        ? "M5"
        : definition.milestone;
    const title = `[${milestoneKey}] ${definition.prefix}: ${taskTitle}`;
    const anchor = `task-${taskNumber}-${taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;
    const body = `${marker}\n\n[Authoritative plan task](https://github.com/${repo}/blob/main/${definition.file}#${anchor})\n\n${section}\n\n## Definition of done\n\n- [ ] Follow every test-first step above.\n- [ ] Keep the focused verification slice green.\n- [ ] Commit the smallest coherent change.\n- [ ] Update release acceptance evidence when this task closes a gate.\n`;
    const risk =
      milestoneKey === "M3" || milestoneKey === "M4" || milestoneKey === "M5"
        ? "risk:high"
        : "risk:medium";
    const type = /Security|Threat|Acceptance|Test|Gate/i.test(taskTitle)
      ? "type:test"
      : "type:feature";
    const issueLabels = [type, ...definition.area, "priority:p1", risk];
    const existing = existingIssues.find((issue) =>
      issue.body?.includes(marker),
    );
    const payload = {
      title,
      body,
      labels: issueLabels,
      milestone: milestoneNumbers.get(milestoneKey),
    };
    if (existing)
      api(`repos/${repo}/issues/${existing.number}`, "PATCH", payload);
    else api(`repos/${repo}/issues`, "POST", payload);
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
const mainBranchProtection = {
  required_status_checks: { strict: true, contexts: ["governance"] },
  // Keep the review gate effective for repository administrators as well.
  enforce_admins: true,
  required_pull_request_reviews: requiredPullRequestReviews,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true,
};
api(`repos/${repo}/branches/main/protection`, "PUT", mainBranchProtection);

console.log(
  `Synchronized ${labels.length} managed labels, ${desiredMilestones.length} milestones, 34 plan issues; review mode: ${reviewMode}; main protection: enabled.`,
);
