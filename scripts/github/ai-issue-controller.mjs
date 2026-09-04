import { randomUUID as nodeRandomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertIssueInvariant,
  currentClaimFromReceipts,
  evaluateReadiness,
  LifecycleError,
  parseDependencies,
  parseLifecycleCommand,
  parseReceipts,
  planLifecycleCommand,
  receiptBody,
  STATUS_LABELS,
} from "./ai-issue-policy.mjs";
import { createGitHubClient } from "./github-api.mjs";

const WORKFLOW_LOGIN = "github-actions[bot]";
const LEASE_MILLISECONDS = 24 * 60 * 60 * 1000;
const COMMAND_PREFIX = "/ai-";

const requirePositiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
};

const requireRepository = (event, repository) => {
  if (
    typeof repository !== "string" ||
    event?.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(
      "GitHub event repository does not match configured repository",
    );
  }
};

const labelsOf = (issue) =>
  (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );

const assigneesOf = (issue) =>
  (issue.assignees ?? []).map((assignee) =>
    typeof assignee === "string" ? assignee : assignee?.login,
  );

const statusOf = (issue) => {
  const statuses = labelsOf(issue).filter((label) =>
    STATUS_LABELS.includes(label),
  );
  if (statuses.length !== 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The Issue must have exactly one managed lifecycle label.",
    );
  }
  return statuses[0].slice("status:".length);
};

const replaceStatus = (issue, state) => [
  ...labelsOf(issue).filter((label) => !STATUS_LABELS.includes(label)),
  `status:${state}`,
];

const plusOneLease = (now) => {
  const timestamp = Date.parse(now);
  if (Number.isNaN(timestamp)) throw new Error("Controller time is invalid");
  return new Date(timestamp + LEASE_MILLISECONDS).toISOString();
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

export const closingIssueNumbers = (body) => {
  const publicBody = stripFencedCode(body);
  return [
    ...new Set(
      [
        ...publicBody.matchAll(
          /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/giu,
        ),
      ].map((match) => Number(match[1])),
    ),
  ];
};

export const primaryIssueNumber = (body) => {
  const matches = [
    ...stripFencedCode(body).matchAll(
      /^\s*-\s*Primary Issue:\s*#([1-9]\d*)\s*$/gimu,
    ),
  ];
  if (matches.length !== 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "A governed pull request must name exactly one Primary Issue.",
    );
  }
  const primary = Number(matches[0][1]);
  const closing = closingIssueNumbers(body);
  if (closing.length !== 1 || closing[0] !== primary) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "A governed pull request must close exactly its one Primary Issue.",
    );
  }
  return primary;
};

const closingPullRequestsFor = (pullRequests, issueNumber) =>
  pullRequests.filter(
    (pullRequest) =>
      String(pullRequest.state).toLowerCase() === "open" &&
      closingIssueNumbers(pullRequest.body).includes(issueNumber),
  );

const mergedPullRequestForIssue = async ({
  github,
  issueNumber,
  repository,
  defaultBranch,
}) => {
  const timeline = await github.getAll(
    `/issues/${issueNumber}/timeline`,
    "Issue timeline",
  );
  const candidateNumbers = [
    ...new Set(
      timeline.flatMap((event) => {
        const source = event?.source?.issue;
        if (
          event?.event !== "cross-referenced" ||
          !source?.pull_request ||
          !closingIssueNumbers(source.body).includes(issueNumber)
        ) {
          return [];
        }
        return [requirePositiveInteger(source.number, "timeline pull request")];
      }),
    ),
  ];
  const candidates = await Promise.all(
    candidateNumbers.map((number) => github.get(`/pulls/${number}`)),
  );
  const merged = candidates.filter(
    (pullRequest) =>
      pullRequest.merged === true &&
      pullRequest.state === "closed" &&
      primaryIssueNumber(pullRequest.body) === issueNumber &&
      pullRequest.base?.ref === defaultBranch &&
      pullRequest.base?.repo?.full_name?.toLowerCase() ===
        repository.toLowerCase(),
  );
  if (merged.length !== 1 || !merged[0].merge_commit_sha) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "Completed closure requires exactly one verified merged pull request.",
    );
  }
  const commit = await github.get(`/commits/${merged[0].merge_commit_sha}`);
  if (commit.sha !== merged[0].merge_commit_sha) {
    throw new LifecycleError(
      "GITHUB_STATE_UNAVAILABLE",
      "The closing merge commit is not reachable through the repository API.",
    );
  }
  return merged[0];
};

const commentsFor = (github, issueNumber) =>
  github.getAll(`/issues/${issueNumber}/comments`, "Issue comments");

const dependenciesFor = async (github, issue) => {
  const numbers = parseDependencies(issue.body);
  return Promise.all(numbers.map((number) => github.get(`/issues/${number}`)));
};

const loadIssueContext = async (github, issueNumber) => {
  const issue = await github.get(`/issues/${issueNumber}`);
  const [comments, dependencies, openPullRequests] = await Promise.all([
    commentsFor(github, issueNumber),
    dependenciesFor(github, issue),
    github.getAll("/pulls?state=open", "open pull requests"),
  ]);
  return {
    issue,
    comments,
    receipts: parseReceipts(comments),
    dependencies,
    closingPullRequests: closingPullRequestsFor(openPullRequests, issueNumber),
  };
};

const intentBody = (plan) =>
  receiptBody(plan.receipt)
    .replace(
      `AI lifecycle ${plan.receipt.action}:`,
      `Pending AI lifecycle ${plan.receipt.action}:`,
    )
    .replace("<!-- qhb-ai-lifecycle:v1", "<!-- qhb-ai-intent:v1");

const hasIntent = (comments, receipt) => {
  const expectedBody = intentBody({ receipt });
  return comments.some(
    (comment) =>
      comment.user?.login === WORKFLOW_LOGIN && comment.body === expectedBody,
  );
};

const ensureIntent = async (github, issueNumber, plan) => {
  const existing = await commentsFor(github, issueNumber);
  if (hasIntent(existing, plan.receipt)) return;
  await github.mutateAndVerify({
    mutation: {
      method: "POST",
      path: `/issues/${issueNumber}/comments`,
      body: { body: intentBody(plan) },
      idempotencyKey: `ai-intent:${issueNumber}:${plan.receipt.eventId}`,
    },
    read: () => commentsFor(github, issueNumber),
    verify: (comments) => hasIntent(comments, plan.receipt),
  });
};

const pendingIntentFor = (comments, receipts, eventId) => {
  const intents = comments.filter(
    (comment) =>
      comment.user?.login === WORKFLOW_LOGIN &&
      comment.body?.includes("<!-- qhb-ai-intent:v1") &&
      comment.body.includes(`event-id=${eventId}`),
  );
  if (intents.length > 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "One lifecycle event has conflicting pending intents.",
    );
  }
  if (intents.length === 0) return null;
  const synthetic = {
    ...intents[0],
    body: intents[0].body.replace(
      "<!-- qhb-ai-intent:v1",
      "<!-- qhb-ai-lifecycle:v1",
    ),
  };
  const parsed = parseReceipts([
    ...comments.filter(
      (comment) => !comment.body?.includes("<!-- qhb-ai-intent:v1"),
    ),
    synthetic,
  ]).find((receipt) => receipt.eventId === Number(eventId));
  if (parsed?.result !== "success") {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pending lifecycle intent is invalid.",
    );
  }
  const currentClaim = currentClaimFromReceipts(receipts);
  return {
    command: parsed.action,
    from: parsed.from,
    to: parsed.to,
    assignee: parsed.action === "claim" ? parsed.actor : null,
    removeAssignee: ["release", "expire", "merge", "close"].includes(
      parsed.action,
    )
      ? (currentClaim?.owner ?? null)
      : null,
    leaseExpiresAt: parsed.leaseExpiresAt,
    receipt: {
      version: parsed.version,
      eventId: parsed.eventId,
      claimId: parsed.claimId,
      action: parsed.action,
      result: parsed.result,
      actor: parsed.actor,
      agent: parsed.agent,
      from: parsed.from,
      to: parsed.to,
      leaseExpiresAt: parsed.leaseExpiresAt,
      code: parsed.code,
    },
  };
};

const postReceipt = async (github, issueNumber, receipt) => {
  const existing = parseReceipts(await commentsFor(github, issueNumber));
  const prior = existing.find(({ eventId }) => eventId === receipt.eventId);
  if (prior) {
    if (
      prior.action !== receipt.action ||
      prior.result !== receipt.result ||
      prior.claimId !== receipt.claimId
    ) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "The event already has a conflicting lifecycle receipt.",
      );
    }
    return prior;
  }
  await github.mutateAndVerify({
    mutation: {
      method: "POST",
      path: `/issues/${issueNumber}/comments`,
      body: { body: receiptBody(receipt) },
      idempotencyKey: `ai-receipt:${issueNumber}:${receipt.eventId}`,
    },
    read: () => commentsFor(github, issueNumber),
    verify: (comments) =>
      parseReceipts(comments).some(
        (candidate) =>
          candidate.eventId === receipt.eventId &&
          candidate.action === receipt.action &&
          candidate.result === receipt.result,
      ),
  });
  return receipt;
};

const sameAssignees = (left, right) =>
  left.length === right.length &&
  left.every((login, index) => login === right[index]);

const mutateIssueToPlan = async (github, issueNumber, currentIssue, plan) => {
  const desiredAssignees = plan.assignee
    ? [plan.assignee]
    : plan.removeAssignee
      ? []
      : assigneesOf(currentIssue);
  const desiredLabels = replaceStatus(currentIssue, plan.to);
  const currentAssignees = assigneesOf(currentIssue);
  const statusChanged = statusOf(currentIssue) !== plan.to;
  const assigneesChanged = !sameAssignees(currentAssignees, desiredAssignees);
  if (!statusChanged && !assigneesChanged) return currentIssue;

  return (
    await github.mutateAndVerify({
      mutation: {
        method: "PATCH",
        path: `/issues/${issueNumber}`,
        body: { labels: desiredLabels, assignees: desiredAssignees },
      },
      read: () => github.get(`/issues/${issueNumber}`),
      verify: (issue) =>
        statusOf(issue) === plan.to &&
        sameAssignees(assigneesOf(issue), desiredAssignees),
    })
  ).value;
};

const applyPlan = async ({ github, issueNumber, issue, plan }) => {
  await ensureIntent(github, issueNumber, plan);
  await mutateIssueToPlan(github, issueNumber, issue, plan);
  await postReceipt(github, issueNumber, plan.receipt);
  const verifiedIssue = await github.get(`/issues/${issueNumber}`);
  assertIssueInvariant(verifiedIssue);
  return { status: "applied", plan, issue: verifiedIssue };
};

const recoverPendingIntent = async ({
  github,
  issueNumber,
  loaded,
  eventId,
  expectedActions,
}) => {
  const plan = pendingIntentFor(
    loaded.comments,
    loaded.receipts,
    Number(eventId),
  );
  if (!plan) return null;
  if (!expectedActions.includes(plan.command)) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pending lifecycle intent does not match the current event.",
    );
  }
  if (![plan.from, plan.to].includes(statusOf(loaded.issue))) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The Issue no longer matches the pending lifecycle intent.",
    );
  }
  await mutateIssueToPlan(github, issueNumber, loaded.issue, plan);
  await postReceipt(github, issueNumber, plan.receipt);
  const issue = await github.get(`/issues/${issueNumber}`);
  assertIssueInvariant(issue);
  return { status: "applied", plan, issue, recovered: true };
};

const failureReceipt = ({ eventId, action, actor, agent, state, code }) => ({
  version: 1,
  eventId,
  claimId: null,
  action,
  result: "failure",
  actor,
  agent,
  from: state,
  to: state,
  leaseExpiresAt: null,
  code,
});

const rejectCommand = async ({
  github,
  issueNumber,
  mode,
  eventId,
  action,
  actor,
  agent,
  issue,
  error,
}) => {
  const code = error instanceof LifecycleError ? error.code : "STATE_MISMATCH";
  if (mode === "enforce") {
    await postReceipt(
      github,
      issueNumber,
      failureReceipt({
        eventId,
        action,
        actor,
        agent,
        state: statusOf(issue),
        code,
      }),
    );
  }
  return { status: "rejected", code };
};

const postInvalidCommandNotice = async (github, issueNumber, eventId) => {
  const body = [
    "AI lifecycle command rejected (`INVALID_COMMAND`).",
    "",
    "Use one documented `/ai-*` command with its exact required fields.",
    "",
    "<!-- qhb-ai-command-rejection:v1",
    `event-id=${eventId}`,
    "code=INVALID_COMMAND",
    "-->",
  ].join("\n");
  await github.mutateAndVerify({
    mutation: {
      method: "POST",
      path: `/issues/${issueNumber}/comments`,
      body: { body },
      idempotencyKey: `ai-rejection:${issueNumber}:${eventId}`,
    },
    read: () => commentsFor(github, issueNumber),
    verify: (comments) =>
      comments.some(
        (comment) =>
          comment.user?.login === WORKFLOW_LOGIN && comment.body === body,
      ),
  });
};

const assertMode = (mode) => {
  if (!["report", "enforce"].includes(mode)) {
    throw new Error("AI lifecycle mode must be report or enforce");
  }
};

export const handleIssueComment = async ({
  github,
  event,
  repository,
  mode = "report",
  now,
  eventId,
  randomUUID = nodeRandomUUID,
}) => {
  assertMode(mode);
  requireRepository(event, repository);
  if (event.issue?.pull_request) return { status: "ignored" };
  const body = event.comment?.body;
  if (
    typeof body !== "string" ||
    !body.trimStart().startsWith(COMMAND_PREFIX)
  ) {
    return { status: "ignored" };
  }
  const issueNumber = requirePositiveInteger(
    event.issue?.number,
    "Issue number",
  );
  const commentId = requirePositiveInteger(event.comment?.id, "comment ID");
  const actor = event.comment?.user?.login;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new Error("GitHub event comment author is required");
  }
  if (Number(eventId) !== commentId) {
    throw new Error("Lifecycle event ID must match the immutable comment ID");
  }
  const liveComment = await github.get(`/issues/comments/${commentId}`);
  if (
    liveComment.id !== commentId ||
    liveComment.body !== body ||
    liveComment.user?.login !== actor
  ) {
    throw new Error("Live GitHub comment does not match the webhook event");
  }
  const issue = await github.get(`/issues/${issueNumber}`);

  let command;
  try {
    command = parseLifecycleCommand(body);
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
    const inferredAction =
      /^\/ai-(claim|heartbeat|block|resume|release)\b/u.exec(body)?.[1];
    if (!inferredAction) {
      if (mode === "enforce") {
        await postInvalidCommandNotice(github, issueNumber, commentId);
      }
      return { status: "rejected", code: error.code };
    }
    return rejectCommand({
      github,
      issueNumber,
      mode,
      eventId: commentId,
      action: inferredAction,
      actor,
      agent: "none",
      issue,
      error,
    });
  }

  let loaded;
  try {
    loaded = await loadIssueContext(github, issueNumber);
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
    return rejectCommand({
      github,
      issueNumber,
      mode,
      eventId: commentId,
      action: command.name,
      actor,
      agent: command.fields.agent ?? "none",
      issue,
      error,
    });
  }
  const prior = loaded.receipts.find(({ eventId: id }) => id === commentId);
  if (prior) {
    return {
      status: prior.result === "success" ? "applied" : "rejected",
      ...(prior.code ? { code: prior.code } : {}),
      receipt: prior,
      idempotent: true,
    };
  }
  if (mode === "enforce") {
    const recovered = await recoverPendingIntent({
      github,
      issueNumber,
      loaded,
      eventId: commentId,
      expectedActions: [command.name],
    });
    if (recovered) return recovered;
  }
  const permission = await github.get(
    `/collaborators/${encodeURIComponent(actor)}/permission`,
  );
  try {
    const plan = planLifecycleCommand({
      command,
      issue: loaded.issue,
      actor,
      actorPermission: permission.permission ?? permission.role_name,
      dependencies: loaded.dependencies,
      closingPullRequests: loaded.closingPullRequests,
      receipts: loaded.receipts,
      now,
      eventId: commentId,
      randomUUID,
    });
    if (mode === "report") return { status: "report", plan };
    return applyPlan({ github, issueNumber, issue: loaded.issue, plan });
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
    const claim = currentClaimFromReceipts(loaded.receipts);
    return rejectCommand({
      github,
      issueNumber,
      mode,
      eventId: commentId,
      action: command.name,
      actor,
      agent: command.fields.agent ?? claim?.agent ?? "none",
      issue: loaded.issue,
      error,
    });
  }
};

const systemReceipt = ({
  eventId,
  claim,
  action,
  from,
  to,
  leaseExpiresAt = null,
}) => ({
  version: 1,
  eventId: Number(eventId),
  claimId: claim?.claimId ?? null,
  action,
  result: "success",
  actor: claim?.owner ?? WORKFLOW_LOGIN,
  agent: claim?.agent ?? "none",
  from,
  to,
  leaseExpiresAt,
  code: null,
});

const systemPlan = ({ eventId, claim, action, from, to, leaseExpiresAt }) => ({
  command: action,
  from,
  to,
  assignee: null,
  removeAssignee: ["expire", "merge", "close", "reopen"].includes(action)
    ? (claim?.owner ?? null)
    : null,
  leaseExpiresAt: leaseExpiresAt ?? null,
  receipt: systemReceipt({
    eventId,
    claim,
    action,
    from,
    to,
    leaseExpiresAt: leaseExpiresAt ?? null,
  }),
});

const verifyPullRequestIdentity = (eventPullRequest, currentPullRequest) => {
  for (const [label, eventValue, liveValue] of [
    ["number", eventPullRequest.number, currentPullRequest.number],
    ["state", eventPullRequest.state, currentPullRequest.state],
    ["body", eventPullRequest.body, currentPullRequest.body],
    ["head SHA", eventPullRequest.head?.sha, currentPullRequest.head?.sha],
    ["author", eventPullRequest.user?.login, currentPullRequest.user?.login],
  ]) {
    if (eventValue !== liveValue) {
      throw new LifecycleError(
        "GITHUB_STATE_UNAVAILABLE",
        `The pull request ${label} is stale.`,
      );
    }
  }
};

export const handlePullRequest = async ({
  github,
  event,
  repository,
  mode = "report",
  now,
  eventId,
}) => {
  assertMode(mode);
  requireRepository(event, repository);
  const eventPullRequest = event.pull_request;
  const pullNumber = requirePositiveInteger(
    eventPullRequest?.number,
    "pull request number",
  );
  const pullRequest = await github.get(`/pulls/${pullNumber}`);
  verifyPullRequestIdentity(eventPullRequest, pullRequest);
  const issueNumber = primaryIssueNumber(pullRequest.body);
  const expectedBranch = new RegExp(
    `^(?:feat|fix|security|docs)/${issueNumber}-[a-z0-9][a-z0-9-]*$`,
    "u",
  );
  if (!expectedBranch.test(pullRequest.head?.ref ?? "")) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request branch must include its Primary Issue number.",
    );
  }
  const defaultBranch = event.repository.default_branch;
  if (
    pullRequest.base?.ref !== defaultBranch ||
    pullRequest.base?.repo?.full_name?.toLowerCase() !==
      repository.toLowerCase()
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request must target the repository default branch.",
    );
  }

  const loaded = await loadIssueContext(github, issueNumber);
  const prior = loaded.receipts.find(
    ({ eventId: id }) => id === Number(eventId),
  );
  if (prior) return { status: "applied", receipt: prior, idempotent: true };
  if (mode === "enforce") {
    const recovered = await recoverPendingIntent({
      github,
      issueNumber,
      loaded,
      eventId,
      expectedActions: ["pr-open", "pr-close", "merge"],
    });
    if (recovered) return recovered;
  }
  const observedState = statusOf(loaded.issue);
  if (
    pullRequest.merged === true &&
    observedState === "done" &&
    loaded.issue.state === "closed" &&
    loaded.issue.state_reason === "completed" &&
    assigneesOf(loaded.issue).length === 0
  ) {
    return { status: "unchanged" };
  }
  const { state, assignee } = assertIssueInvariant(
    pullRequest.merged ? { ...loaded.issue, state: "open" } : loaded.issue,
  );
  if (pullRequest.user?.login !== assignee) {
    throw new LifecycleError(
      "NOT_OWNER",
      "The pull request author must be the accountable Issue owner.",
    );
  }
  if (loaded.closingPullRequests.length > 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "An Issue cannot have multiple open closing pull requests.",
    );
  }
  const claim = currentClaimFromReceipts(loaded.receipts);
  if (!claim || claim.owner !== assignee) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request does not have a current verified claim.",
    );
  }

  let plan;
  if (pullRequest.state === "open") {
    if (state === "review") return { status: "unchanged" };
    if (state !== "in-progress") {
      throw new LifecycleError(
        "INVALID_TRANSITION",
        "Only active work enters review.",
      );
    }
    plan = systemPlan({
      eventId,
      claim,
      action: "pr-open",
      from: state,
      to: "review",
      leaseExpiresAt: claim.leaseExpiresAt,
    });
  } else if (pullRequest.merged === true) {
    if (state !== "review") {
      throw new LifecycleError(
        "INVALID_TRANSITION",
        "Only review work can merge.",
      );
    }
    if (
      loaded.issue.state !== "closed" ||
      loaded.issue.state_reason !== "completed" ||
      !pullRequest.merged_at ||
      !pullRequest.merge_commit_sha
    ) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "Merged work must close its Issue as completed and expose a merge commit.",
      );
    }
    const mergeCommit = await github.get(
      `/commits/${pullRequest.merge_commit_sha}`,
    );
    if (mergeCommit.sha !== pullRequest.merge_commit_sha) {
      throw new LifecycleError(
        "GITHUB_STATE_UNAVAILABLE",
        "The merge commit is not reachable through the repository API.",
      );
    }
    plan = systemPlan({
      eventId,
      claim,
      action: "merge",
      from: state,
      to: "done",
    });
  } else {
    if (state !== "review") {
      throw new LifecycleError(
        "INVALID_TRANSITION",
        "Only review work can return after an unmerged close.",
      );
    }
    plan = systemPlan({
      eventId,
      claim,
      action: "pr-close",
      from: state,
      to: "in-progress",
      leaseExpiresAt: plusOneLease(now),
    });
  }
  if (mode === "report") return { status: "report", plan };
  return applyPlan({ github, issueNumber, issue: loaded.issue, plan });
};

export const handleIssueChange = async ({
  github,
  event,
  repository,
  mode = "report",
  eventId,
}) => {
  assertMode(mode);
  requireRepository(event, repository);
  const issueNumber = requirePositiveInteger(
    event.issue?.number,
    "Issue number",
  );
  const loaded = await loadIssueContext(github, issueNumber);
  const prior = loaded.receipts.find(
    ({ eventId: id }) => id === Number(eventId),
  );
  if (prior) return { status: "applied", receipt: prior, idempotent: true };
  if (mode === "enforce") {
    const recovered = await recoverPendingIntent({
      github,
      issueNumber,
      loaded,
      eventId,
      expectedActions: ["close", "reopen"],
    });
    if (recovered) return recovered;
  }
  const state = statusOf(loaded.issue);
  const claim = currentClaimFromReceipts(loaded.receipts);

  let plan;
  if (
    loaded.issue.state === "closed" &&
    loaded.issue.state_reason === "completed"
  ) {
    if (state === "done" && assigneesOf(loaded.issue).length === 0) {
      return { status: "unchanged" };
    }
    if (
      state !== "review" ||
      !claim ||
      assigneesOf(loaded.issue)[0] !== claim.owner
    ) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "Only claimed review work can reconcile to done.",
      );
    }
    await mergedPullRequestForIssue({
      github,
      issueNumber,
      repository,
      defaultBranch: event.repository.default_branch,
    });
    plan = systemPlan({
      eventId,
      claim,
      action: "close",
      from: "review",
      to: "done",
    });
  } else if (loaded.issue.state === "open" && state === "done") {
    const readiness = evaluateReadiness({
      issue: loaded.issue,
      dependencies: loaded.dependencies,
      closingPullRequests: loaded.closingPullRequests,
    });
    if (readiness.code === "GITHUB_STATE_UNAVAILABLE") {
      throw new LifecycleError(
        readiness.code,
        "Cannot reconcile reopened Issue state.",
      );
    }
    plan = systemPlan({
      eventId,
      claim: null,
      action: "reopen",
      from: "done",
      to: readiness.ready ? "ready" : "waiting",
    });
  } else {
    try {
      assertIssueInvariant(loaded.issue);
      return { status: "unchanged" };
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
      if (mode === "report")
        return { status: "repair-required", code: error.code };
      const notice = [
        "AI lifecycle repair required (`STATE_MISMATCH`).",
        "",
        "A maintainer must restore exactly one valid lifecycle label and assignee invariant.",
        "",
        "<!-- qhb-ai-repair-required:v1 -->",
      ].join("\n");
      await github.mutateAndVerify({
        mutation: {
          method: "POST",
          path: `/issues/${issueNumber}/comments`,
          body: { body: notice },
          idempotencyKey: `ai-repair:${issueNumber}:${eventId}`,
        },
        read: () => commentsFor(github, issueNumber),
        verify: (comments) => comments.some(({ body }) => body === notice),
      });
      return { status: "repair-required", code: error.code };
    }
  }
  if (mode === "report") return { status: "report", plan };
  return applyPlan({ github, issueNumber, issue: loaded.issue, plan });
};

export const reconcileExpiredClaims = async ({
  github,
  mode = "report",
  now,
  eventId,
}) => {
  assertMode(mode);
  const issues = await github.getAll(
    "/issues?state=open&labels=status%3Ain-progress",
    "in-progress Issues",
  );
  const released = [];
  for (const listedIssue of issues) {
    const issueNumber = requirePositiveInteger(
      listedIssue.number,
      "Issue number",
    );
    const loaded = await loadIssueContext(github, issueNumber);
    if (mode === "enforce") {
      const recovered = await recoverPendingIntent({
        github,
        issueNumber,
        loaded,
        eventId,
        expectedActions: ["expire"],
      });
      if (recovered) {
        released.push(issueNumber);
        continue;
      }
    }
    const { state, assignee } = assertIssueInvariant(loaded.issue);
    if (state !== "in-progress") continue;
    const claim = currentClaimFromReceipts(loaded.receipts);
    if (!claim || claim.owner !== assignee) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        `Issue #${issueNumber} has no matching active claim.`,
      );
    }
    const expiresAt = Date.parse(claim.leaseExpiresAt);
    const currentTime = Date.parse(now);
    if (Number.isNaN(expiresAt) || Number.isNaN(currentTime)) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "A claim lease timestamp is invalid.",
      );
    }
    if (expiresAt > currentTime) continue;
    const readiness = evaluateReadiness({
      issue: loaded.issue,
      dependencies: loaded.dependencies,
      closingPullRequests: loaded.closingPullRequests,
    });
    if (
      ["GITHUB_STATE_UNAVAILABLE", "CLOSING_PR_EXISTS"].includes(readiness.code)
    ) {
      throw new LifecycleError(
        readiness.code,
        `Issue #${issueNumber} cannot expire safely.`,
      );
    }
    const plan = systemPlan({
      eventId,
      claim,
      action: "expire",
      from: state,
      to: readiness.ready ? "ready" : "waiting",
    });
    if (mode === "enforce") {
      await applyPlan({ github, issueNumber, issue: loaded.issue, plan });
    }
    released.push(issueNumber);
  }
  return { status: mode === "enforce" ? "applied" : "report", released };
};

export const runLifecycleController = async (context) => {
  switch (context.eventName) {
    case "issue_comment":
      return handleIssueComment(context);
    case "pull_request_target":
      return handlePullRequest(context);
    case "issues":
      return handleIssueChange(context);
    case "schedule":
    case "workflow_dispatch":
      return reconcileExpiredClaims(context);
    default:
      throw new Error(`Unsupported lifecycle event: ${context.eventName}`);
  }
};

export const main = async ({
  eventPath = process.env.GITHUB_EVENT_PATH,
  eventName = process.env.GITHUB_EVENT_NAME,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  mode = process.env.AI_LIFECYCLE_MODE ?? "report",
  runId = process.env.GITHUB_RUN_ID,
  fetchImpl = globalThis.fetch,
  now = new Date().toISOString(),
} = {}) => {
  if (typeof eventPath !== "string" || eventPath.length === 0) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  let event;
  try {
    event = JSON.parse(readFileSync(resolve(eventPath), "utf8"));
  } catch {
    throw new Error("GITHUB_EVENT_PATH must contain valid JSON");
  }
  const eventId =
    eventName === "issue_comment"
      ? requirePositiveInteger(event.comment?.id, "comment ID")
      : requirePositiveInteger(runId, "GITHUB_RUN_ID");
  const github = createGitHubClient({ fetchImpl, repository, token });
  const result = await runLifecycleController({
    github,
    event,
    eventName,
    repository,
    mode,
    now,
    eventId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`AI lifecycle controller failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
