import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertIssueInvariant,
  closingIssueNumbers,
  currentClaimFromReceipts,
  evaluateReadiness,
  LifecycleError,
  parseDependencies,
  parseReceipts,
  safePublicText,
} from "./ai-issue-policy.mjs";
import {
  LifecycleRegistryError,
  validateLifecycleValidationMode,
} from "./ai-lifecycle-registry.mjs";
import { createGitHubClient } from "./github-api.mjs";

const WORKFLOW_LOGIN = "github-actions[bot]";
const MIGRATION_PATH = resolve(
  import.meta.dirname,
  "../../docs/github/ai-lifecycle-migrations.json",
);

export class LifecycleValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LifecycleValidationError";
  }
}

const fail = (message) => {
  throw new LifecycleValidationError(message);
};

const normalizeLogin = (value) =>
  String(value ?? "")
    .replace(/^@/u, "")
    .toLowerCase();

const requirePositiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return number;
};

const requireTimestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail(`${label} must be a GitHub UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) fail(`${label} must be a valid timestamp`);
  const normalized = new Date(timestamp).toISOString();
  if (normalized !== value && normalized.replace(".000Z", "Z") !== value) {
    fail(`${label} must be a real canonical timestamp`);
  }
  return timestamp;
};

const stripFencedCode = (body) => {
  let fenced = false;
  return String(body ?? "")
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (/^\s*```/u.test(line)) {
        fenced = !fenced;
        return [];
      }
      return fenced ? [] : [line.replace(/`[^`]*`/gu, "")];
    })
    .join("\n");
};

const safePullRequestBody = (body) => {
  if (typeof body !== "string" || body.trim().length === 0) {
    fail("Pull request body is required");
  }
  if (Buffer.byteLength(body, "utf8") > 60_000) {
    fail("Pull request body exceeds the public evidence limit");
  }
  try {
    for (const line of body.split(/\r?\n/u)) {
      const evidenceText = line.replace(/[`*_~]/gu, "");
      if (evidenceText.trim()) safePublicText(evidenceText, 10_000);
    }
  } catch (error) {
    if (error instanceof LifecycleError) fail(error.message);
    throw error;
  }
  return stripFencedCode(body);
};

const fieldValue = (body, label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...body.matchAll(new RegExp(`^\\s*-\\s*${escaped}:\\s*(.*?)\\s*$`, "gimu")),
  ];
  if (matches.length !== 1 || matches[0][1].trim().length === 0) {
    fail(`${label} is required exactly once with a completed value`);
  }
  return matches[0][1].trim();
};

const closingIssueNumber = (body) => {
  const matches = closingIssueNumbers(body);
  if (matches.length !== 1)
    fail("PR body must contain exactly one closing Issue");
  return matches[0];
};

const parseReceiptUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Claim receipt must be a valid public GitHub Issue comment URL");
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/u.exec(url.pathname);
  const commentMatch = /^#issuecomment-([1-9]\d*)$/u.exec(url.hash);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.search ||
    !match ||
    !commentMatch
  ) {
    fail("Claim receipt must be a concrete public GitHub Issue comment URL");
  }
  return {
    repository: `${match[1]}/${match[2]}`,
    issueNumber: Number(match[3]),
    commentId: Number(commentMatch[1]),
  };
};

export const extractLifecycleFields = (body) => {
  const publicBody = safePullRequestBody(body);
  const closing = closingIssueNumber(publicBody);
  const primaryValue = fieldValue(publicBody, "Primary Issue");
  const primaryMatch = /^#([1-9]\d*)$/u.exec(primaryValue);
  if (!primaryMatch || Number(primaryMatch[1]) !== closing) {
    fail("Primary Issue must match the exactly one closing Issue");
  }
  const receiptUrl = fieldValue(publicBody, "Claim receipt");
  const parsedUrl = parseReceiptUrl(receiptUrl);
  if (parsedUrl.issueNumber !== closing) {
    fail("Claim receipt Issue must match the Primary Issue");
  }
  const ownerValue = fieldValue(publicBody, "Accountable owner");
  const owner = ownerValue.replace(/^@/u, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u.test(owner)) {
    fail("Accountable owner must be one concrete GitHub login");
  }
  const agent = fieldValue(publicBody, "Implementer agent class");
  try {
    safePublicText(agent, 64);
  } catch {
    fail("Implementer agent class contains prohibited private data");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(agent)) {
    fail("Implementer agent class must be a safe lowercase slug");
  }
  return { issueNumber: closing, receiptUrl, owner, agent };
};

export const validateMigrationRegistry = (
  migrations,
  { mode, pullRequestNumber, issueNumber, now },
) => {
  try {
    return validateLifecycleValidationMode(migrations, {
      mode,
      pullRequestNumber,
      issueNumber,
      now,
    });
  } catch (error) {
    if (error instanceof LifecycleRegistryError) fail(error.message);
    throw error;
  }
};

const requireIdentityMatch = (actual, expected, label) => {
  if (normalizeLogin(actual) !== normalizeLogin(expected)) {
    fail(`${label} must match the accountable owner`);
  }
};

const strictLifecycleEvidence = ({
  repository,
  defaultBranch,
  pullRequest,
  issue,
  comments,
  dependencies,
  closingPullRequests,
  reviewedHeadSha,
  now,
  fields,
}) => {
  if (pullRequest.state !== "open") fail("Pull request must still be open");
  if (
    pullRequest.base?.ref !== defaultBranch ||
    pullRequest.base?.repo?.full_name?.toLowerCase() !==
      repository.toLowerCase()
  ) {
    fail("Pull request must target the repository default branch");
  }
  const expectedBranch = new RegExp(
    `^(?:feat|fix|security|docs)/${fields.issueNumber}-[a-z0-9][a-z0-9-]*$`,
    "u",
  );
  if (!expectedBranch.test(pullRequest.head?.ref ?? "")) {
    fail("Pull request branch must contain its Primary Issue number");
  }
  if (!issue || typeof issue !== "object") {
    throw new Error("Live Issue state is unavailable");
  }
  if (issue.number !== fields.issueNumber) {
    fail("Live Issue does not match the Primary Issue");
  }
  const invariant = (() => {
    try {
      return assertIssueInvariant(issue);
    } catch (error) {
      if (
        error instanceof LifecycleError &&
        error.code === "GITHUB_STATE_UNAVAILABLE"
      ) {
        throw new Error(error.message);
      }
      if (error instanceof LifecycleError) fail(error.message);
      throw error;
    }
  })();
  if (invariant.state !== "review") {
    fail("Primary Issue must have status:review before merge");
  }
  requireIdentityMatch(pullRequest.user?.login, fields.owner, "PR author");
  requireIdentityMatch(invariant.assignee, fields.owner, "Issue assignee");

  const receiptUrl = parseReceiptUrl(fields.receiptUrl);
  if (receiptUrl.repository.toLowerCase() !== repository.toLowerCase()) {
    fail("Claim receipt must belong to this repository");
  }
  const receipts = (() => {
    try {
      return parseReceipts(comments, { workflowLogin: WORKFLOW_LOGIN });
    } catch (error) {
      if (error instanceof LifecycleError) fail(error.message);
      throw error;
    }
  })();
  const claimReceipt = receipts.find(
    (receipt) =>
      receipt.commentId === receiptUrl.commentId &&
      receipt.action === "claim" &&
      receipt.result === "success",
  );
  if (!claimReceipt) {
    fail(
      "Claim receipt URL does not identify a verified workflow claim receipt",
    );
  }
  requireIdentityMatch(claimReceipt.actor, fields.owner, "Claim receipt actor");
  if (claimReceipt.agent !== fields.agent) {
    fail("Claim receipt agent class must match the PR agent class");
  }
  const activeClaim = currentClaimFromReceipts(receipts);
  if (!activeClaim || activeClaim.claimId !== claimReceipt.claimId) {
    fail("Claim receipt generation is no longer active or was released");
  }
  if (
    Date.parse(activeClaim.leaseExpiresAt) <=
    requireTimestamp(now, "Validation time")
  ) {
    fail("Active claim lease has expired; renew it before merge");
  }
  requireIdentityMatch(activeClaim.owner, fields.owner, "Active claim owner");

  const readiness = evaluateReadiness({
    issue,
    dependencies,
    closingPullRequests: [],
  });
  if (!readiness.ready) {
    if (readiness.code === "GITHUB_STATE_UNAVAILABLE") {
      throw new Error(
        "Primary Issue dependency/readiness evidence is unavailable",
      );
    }
    fail(
      `Primary Issue dependency/readiness evidence failed: ${readiness.code}`,
    );
  }
  if (
    closingPullRequests.length !== 1 ||
    closingPullRequests[0].number !== pullRequest.number
  ) {
    fail("Primary Issue must have exactly one closing pull request: this PR");
  }
  if (reviewedHeadSha !== pullRequest.head?.sha) {
    fail("Recorded reviewed head must match the current head");
  }
  return {
    valid: true,
    claimReceipt,
    fields,
  };
};

export const validatePullRequestLifecycleState = (input) => {
  const mode = input.mode;
  if (!["report", "enforce"].includes(mode)) {
    fail("Lifecycle validation mode must be report or enforce");
  }
  const pullRequestNumber = requirePositiveInteger(
    input.pullRequest?.number,
    "Pull request number",
  );
  let issueNumber = null;
  try {
    const publicBody = safePullRequestBody(input.pullRequest.body);
    issueNumber = closingIssueNumber(publicBody);
    const migration = validateMigrationRegistry(input.migrations, {
      mode,
      pullRequestNumber,
      issueNumber,
      now: input.now,
    });
    if (migration.migrated) {
      return {
        valid: true,
        mode,
        migrated: true,
        issueNumber,
        pullRequestNumber,
      };
    }
    const fields = extractLifecycleFields(input.pullRequest.body);
    const strict = strictLifecycleEvidence({ ...input, fields });
    return {
      valid: true,
      mode,
      migrated: false,
      issueNumber: fields.issueNumber,
      pullRequestNumber,
      claimId: strict.claimReceipt.claimId,
      claimCommentId: strict.claimReceipt.commentId,
      owner: fields.owner,
      agent: fields.agent,
      headSha: input.pullRequest.head.sha,
    };
  } catch (error) {
    if (mode === "enforce" || !(error instanceof LifecycleValidationError)) {
      throw error;
    }
    return {
      valid: false,
      mode,
      migrated: false,
      issueNumber,
      pullRequestNumber,
      violations: [error.message],
    };
  }
};

const reviewedHeadFromBody = (body) => {
  const value = fieldValue(
    stripFencedCode(body),
    "Commit range reviewed (base..head; use the exact event base.sha..head.sha)",
  );
  const match = /^([^\s.]+)\.\.([^\s.]+)$/u.exec(value);
  if (!match) fail("Reviewed commit range must contain exact base..head SHAs");
  return match[2];
};

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
};

export const main = async ({
  eventPath = process.env.GITHUB_EVENT_PATH,
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  staticResult = process.env.GITHUB_STATIC_RESULT,
  mode = process.env.AI_LIFECYCLE_VALIDATION_MODE ?? "report",
  migrationsPath = MIGRATION_PATH,
  fetchImpl = globalThis.fetch,
  now = null,
} = {}) => {
  if (staticResult !== "success") {
    fail("Static governance checks must succeed before lifecycle validation");
  }
  const event = readJson(eventPath, "GITHUB_EVENT_PATH");
  if (event.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    fail("GitHub event repository does not match GITHUB_REPOSITORY");
  }
  const eventPull = event.pull_request;
  const pullNumber = requirePositiveInteger(
    eventPull?.number,
    "Event pull request number",
  );
  const github = createGitHubClient({ fetchImpl, repository, token });
  const authoritativeNow = now ?? (await github.serverTime());
  const pullRequest = await github.get(`/pulls/${pullNumber}`);
  if (
    pullRequest.body !== eventPull.body ||
    pullRequest.head?.sha !== eventPull.head?.sha ||
    pullRequest.user?.login !== eventPull.user?.login
  ) {
    fail("Pull request event is stale relative to the live GitHub PR");
  }
  const migrations = readJson(migrationsPath, "Lifecycle migration registry");
  const reportSemanticFailure = () => {
    const result = validatePullRequestLifecycleState({
      repository,
      defaultBranch: event.repository.default_branch,
      pullRequest,
      issue: null,
      comments: [],
      dependencies: [],
      closingPullRequests: [],
      reviewedHeadSha: null,
      now: authoritativeNow,
      mode,
      migrations,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  };
  let issueNumber;
  try {
    issueNumber = closingIssueNumber(safePullRequestBody(pullRequest.body));
  } catch (error) {
    if (mode === "report" && error instanceof LifecycleValidationError) {
      return reportSemanticFailure();
    }
    throw error;
  }
  const issue = await github.get(`/issues/${issueNumber}`);
  if (issue.number !== issueNumber) {
    fail("Live Issue does not match the migrated or primary Issue");
  }
  let migration;
  try {
    migration = validateMigrationRegistry(migrations, {
      mode,
      pullRequestNumber: pullNumber,
      issueNumber,
      now: authoritativeNow,
    });
  } catch (error) {
    if (mode === "report" && error instanceof LifecycleValidationError) {
      return reportSemanticFailure();
    }
    throw error;
  }
  if (migration.migrated) {
    const result = validatePullRequestLifecycleState({
      repository,
      defaultBranch: event.repository.default_branch,
      pullRequest,
      issue,
      comments: [],
      dependencies: [],
      closingPullRequests: [],
      reviewedHeadSha: null,
      now: authoritativeNow,
      mode,
      migrations,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  let fields;
  try {
    fields = extractLifecycleFields(pullRequest.body);
  } catch (error) {
    if (mode === "report" && error instanceof LifecycleValidationError) {
      return reportSemanticFailure();
    }
    throw error;
  }
  let dependencyNumbers = [];
  try {
    dependencyNumbers = parseDependencies(issue.body);
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
  }
  const [comments, dependencies, openPullRequests] = await Promise.all([
    github.getAll(`/issues/${fields.issueNumber}/comments`, "Issue comments"),
    Promise.all(
      dependencyNumbers.map((number) => github.get(`/issues/${number}`)),
    ),
    github.getAll("/pulls?state=open", "open pull requests"),
  ]);
  const closingPullRequests = openPullRequests.filter((candidate) =>
    closingIssueNumbers(candidate.body).includes(fields.issueNumber),
  );
  let reviewedHeadSha = null;
  try {
    reviewedHeadSha = reviewedHeadFromBody(pullRequest.body);
  } catch (error) {
    if (mode === "enforce" || !(error instanceof LifecycleValidationError)) {
      throw error;
    }
  }
  const result = validatePullRequestLifecycleState({
    repository,
    defaultBranch: event.repository.default_branch,
    pullRequest,
    issue,
    comments,
    dependencies,
    closingPullRequests,
    reviewedHeadSha,
    now: authoritativeNow,
    mode,
    migrations,
  });
  if (mode === "enforce") {
    const activation = migrations.activation_commit;
    await github.get(`/commits/${activation}`);
    const comparison = await github.get(
      `/compare/${activation}...${encodeURIComponent(event.repository.default_branch)}`,
    );
    if (!["ahead", "identical"].includes(comparison.status)) {
      fail(
        "Lifecycle activation commit is not reachable from the default branch",
      );
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`AI lifecycle validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
