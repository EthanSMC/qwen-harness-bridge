import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closingIssueNumbers,
  MANAGED_TYPE_LABELS,
} from "./ai-issue-policy.mjs";
import { createGitHubClient } from "./github-api.mjs";

const HOUR = 3_600_000;
const RECOVERY =
  "Inspect current claim, branch/PR and tests; ask worker for checkpoint/continue. For handoff, safely close PR before current-claim release/reclaim.";
const positive = (value) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Stalled-work references must be positive integers");
  return value;
};
const timestamp = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, ".000Z")
  )
    throw new Error("Invalid stalled-work timestamp");
  return Date.parse(value);
};
export const classifyStaleWork = (records, serverTime) => {
  const now = timestamp(serverTime);
  const actionable = [];
  for (const record of records) {
    if (!["review", "blocked"].includes(record.state)) continue;
    positive(record.issue_number);
    if (!Array.isArray(record.pr_numbers) || record.pr_numbers.length > 1)
      throw new Error("Ambiguous linked open PRs");
    record.pr_numbers.forEach(positive);
    if (!Array.isArray(record.activities))
      throw new Error("Missing public checkpoints");
    const humanTimes = [];
    for (const activity of record.activities) {
      const time = timestamp(activity.created_at);
      if (time > now) throw new Error("Future public checkpoint timestamp");
      if (
        !activity.user ||
        typeof activity.user.login !== "string" ||
        !["User", "Bot"].includes(activity.user.type)
      )
        throw new Error("Unverifiable checkpoint actor");
      if (
        activity.user.type === "User" &&
        !/\[bot\]$/i.test(activity.user.login)
      )
        humanTimes.push(time);
    }
    if (humanTimes.length === 0) throw new Error("Missing human checkpoint");
    const age = now - Math.max(...humanTimes);
    if (age < (record.state === "review" ? 48 : 24) * HOUR) continue;
    actionable.push({
      issue_number: record.issue_number,
      pr_numbers: [...record.pr_numbers],
      state: record.state,
      elapsed_hours: Math.floor(age / HOUR),
      action: RECOVERY,
    });
  }
  actionable.sort(
    (a, b) =>
      b.elapsed_hours - a.elapsed_hours || a.issue_number - b.issue_number,
  );
  const items = [];
  let references = 0;
  for (const item of actionable) {
    const count = 1 + item.pr_numbers.length;
    if (references + count > 50) break;
    items.push(item);
    references += count;
  }
  return {
    total: actionable.length,
    truncated: actionable.length - items.length,
    items,
  };
};
export const collectStaleWork = async (github) => {
  // Each collection is capped by the shared client's pagination policy.
  const issues = new Map();
  for (const state of ["review", "blocked"]) {
    for (const issue of await github.getAll(
      `/issues?state=open&labels=status:${state}`,
      "stalled Issues",
    )) {
      if (issue.pull_request) continue;
      positive(issue.number);
      if (issue.state !== "open" || !Array.isArray(issue.labels))
        throw new Error("Invalid stalled Issue state");
      const labels = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      );
      const types = labels.filter((label) =>
        MANAGED_TYPE_LABELS.includes(label),
      );
      if (types.length === 0) continue;
      if (
        types.length !== 1 ||
        labels.filter((label) => label.startsWith("status:")).length !== 1 ||
        !labels.includes(`status:${state}`)
      )
        throw new Error("Ambiguous stalled Issue labels");
      issues.set(issue.number, { issue, state });
      if (issues.size > 100)
        throw new Error("Stalled Issue candidate safety cap exceeded");
    }
  }
  if (!issues.size) return classifyStaleWork([], await github.serverTime());
  const linked = new Map();
  let linkedCount = 0;
  for (const pr of await github.getAll(
    "/pulls?state=open",
    "open pull requests",
  )) {
    positive(pr.number);
    for (const number of closingIssueNumbers(pr.body ?? "")) {
      if (!issues.has(number)) continue;
      if (++linkedCount > 100) throw new Error("Linked PR safety cap exceeded");
      if (linked.has(number)) throw new Error("Ambiguous linked open PRs");
      linked.set(number, pr);
    }
  }
  const records = [];
  for (const [number, { issue, state }] of issues) {
    const activities = [
      issue,
      ...(await github.getAll(
        `/issues/${number}/comments`,
        "Issue checkpoints",
      )),
    ];
    const pr = linked.get(number);
    if (state === "review" && !pr)
      throw new Error("Review Issue has no linked open PR");
    if (pr) {
      activities.push(
        pr,
        ...(await github.getAll(
          `/issues/${pr.number}/comments`,
          "PR checkpoints",
        )),
      );
      for (const review of await github.getAll(
        `/pulls/${pr.number}/reviews`,
        "PR review checkpoints",
      )) {
        if (review.state === "PENDING") continue;
        activities.push({ user: review.user, created_at: review.submitted_at });
      }
    }
    records.push({
      issue_number: number,
      pr_numbers: pr ? [pr.number] : [],
      state,
      activities,
    });
  }
  // Read time after checkpoints so concurrent new comments cannot appear future-dated.
  return classifyStaleWork(records, await github.serverTime());
};
export const renderStaleWork = (report) =>
  [
    "## Stalled collaboration",
    `Actionable: ${report.total}; shown: ${report.items.length}; truncated: ${report.truncated}.`,
    "Age measures the last public human checkpoint; local work may still be active.",
    "",
    ...report.items.map(
      (item) =>
        `- Issue #${item.issue_number}${item.pr_numbers.map((number) => ` / PR #${number}`).join("")}: ${item.state}, ${item.elapsed_hours}h. ${item.action}`,
    ),
    "",
  ].join("\n");
export const main = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const output = env.STALE_WORK_REPORT_PATH ?? "stale-work-report.md";
  try {
    const github = createGitHubClient({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN,
      fetchImpl,
      maxPages: 3,
    });
    const text = renderStaleWork(await collectStaleWork(github));
    writeFileSync(output, text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
  } catch {
    const text =
      "## Stalled collaboration\nReport unavailable: GitHub data, timestamps or bounded-read limits could not be verified. Inspect workflow failure and retry; no lifecycle mutation was attempted by this report.\n";
    writeFileSync(output, text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    throw new Error(
      "Stalled-work report unavailable; inspect verified GitHub state and collection bounds",
    );
  }
};
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Stalled-work reporting failed; see Actions summary.");
    process.exitCode = 1;
  });
