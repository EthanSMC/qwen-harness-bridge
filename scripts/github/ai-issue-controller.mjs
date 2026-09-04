import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertIssueInvariant,
  closingIssueNumbers,
  currentClaimFromReceipts,
  evaluateReadiness,
  LifecycleError,
  MANAGED_TYPE_LABELS,
  parseDependencies,
  parseLifecycleCommand,
  parseReceipts,
  planLifecycleCommand,
  RECEIPT_ACTIONS,
  receiptBody,
  STATUS_LABELS,
  stripMarkdownCode,
} from "./ai-issue-policy.mjs";
import { validateLifecycleMutationMode } from "./ai-lifecycle-registry.mjs";
import { createGitHubClient } from "./github-api.mjs";

const WORKFLOW_LOGIN = "github-actions[bot]";
const LEASE_MILLISECONDS = 24 * 60 * 60 * 1000;
const COMMAND_PREFIX = "/ai-";
const MAX_COMMANDS_PER_DRAIN = 1_000;
const COMMAND_SCAN_PAGE_SIZE = 100;
const COMMAND_SCAN_MAX_PAGES = 10;
const MAX_RECONCILIATION_OBJECTS = 1_000;
const SYSTEM_EVENT_BASE = 8_000_000_000_000_000;
const MIGRATION_PATH = resolve(
  import.meta.dirname,
  "../../docs/github/ai-lifecycle-migrations.json",
);

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

export const stableSystemEventId = (...parts) => {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest();
  return SYSTEM_EVENT_BASE + digest.readUIntBE(0, 6);
};

const labelsOf = (issue) =>
  (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );

const assigneesOf = (issue) =>
  (issue.assignees ?? []).map((assignee) =>
    typeof assignee === "string" ? assignee : assignee?.login,
  );

const managedTypeCount = (issue) =>
  labelsOf(issue).filter((label) => MANAGED_TYPE_LABELS.includes(label)).length;

const assertManagedIssue = (issue) => {
  const count = managedTypeCount(issue);
  if (count !== 1) {
    throw new LifecycleError(
      count === 0 ? "NOT_READY" : "STATE_MISMATCH",
      "The Issue must have exactly one managed type label.",
    );
  }
};

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

const observedStatusOf = (issue) => {
  const statuses = labelsOf(issue).filter((label) =>
    STATUS_LABELS.includes(label),
  );
  return statuses.length === 0 ? "unmanaged" : statusOf(issue);
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

export const primaryIssueNumber = (body) => {
  const matches = [
    ...stripMarkdownCode(body).matchAll(
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

const claimReceiptCommentId = ({ body, repository, issueNumber }) => {
  const matches = [
    ...stripMarkdownCode(body).matchAll(
      /^\s*-\s*Claim receipt:\s*(\S+)\s*$/gimu,
    ),
  ];
  if (matches.length !== 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "A governed pull request must name exactly one claim receipt.",
    );
  }
  let url;
  try {
    url = new URL(matches[0][1]);
  } catch {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request claim receipt URL is invalid.",
    );
  }
  const [owner, name] = repository.split("/");
  const expectedPath = `/${owner}/${name}/issues/${issueNumber}`;
  const commentMatch = /^#issuecomment-([1-9]\d*)$/u.exec(url.hash);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    url.search ||
    !commentMatch
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request claim receipt must be the current Issue claim comment.",
    );
  }
  return Number(commentMatch[1]);
};

const requireChronology = ({ claim, pullRequest, issueClosedAt }) => {
  const claimedAt = Date.parse(claim?.claimedAt ?? "");
  const mergedAt = Date.parse(pullRequest?.merged_at ?? "");
  const closedAt = Date.parse(issueClosedAt ?? "");
  if (
    Number.isNaN(claimedAt) ||
    Number.isNaN(mergedAt) ||
    Number.isNaN(closedAt) ||
    mergedAt < claimedAt ||
    closedAt < mergedAt
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The claim, merge, and Issue closure chronology is invalid.",
    );
  }
};

const requireReviewAdmissionChronology = ({
  claim,
  pullRequest,
  eventAction,
}) => {
  const claimedAt = Date.parse(claim?.claimedAt ?? "");
  const expiresAt = Date.parse(claim?.leaseExpiresAt ?? "");
  const pullCreatedAt = Date.parse(pullRequest?.created_at ?? "");
  const qualifyingAt = Date.parse(
    eventAction === "opened"
      ? (pullRequest?.created_at ?? "")
      : (pullRequest?.updated_at ?? ""),
  );
  if (
    Number.isNaN(claimedAt) ||
    Number.isNaN(expiresAt) ||
    Number.isNaN(pullCreatedAt) ||
    Number.isNaN(qualifyingAt) ||
    pullCreatedAt < claimedAt ||
    qualifyingAt < claimedAt
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The claim and pull request review-admission chronology is invalid.",
    );
  }
  if (pullCreatedAt >= expiresAt || qualifyingAt >= expiresAt) {
    throw new LifecycleError(
      "LEASE_EXPIRED",
      "The claim lease expired before pull request review admission.",
    );
  }
};

const durableReviewAdmissionFor = (receipts, claim, pullRequestNumber) =>
  receipts.findLast(
    (receipt) =>
      receipt.result === "success" &&
      receipt.action === "pr-open" &&
      receipt.claimId === claim?.claimId &&
      receipt.pullRequestNumber === pullRequestNumber,
  ) ?? null;

const assertMergeReachable = async ({
  github,
  mergeCommitSha,
  defaultBranch,
}) => {
  if (!/^[0-9a-f]{7,64}$/iu.test(mergeCommitSha ?? "")) {
    throw new LifecycleError(
      "GITHUB_STATE_UNAVAILABLE",
      "The closing pull request has no valid merge commit.",
    );
  }
  const comparison = await github.get(
    `/compare/${mergeCommitSha}...${encodeURIComponent(defaultBranch)}`,
  );
  if (!["ahead", "identical"].includes(comparison.status)) {
    throw new LifecycleError(
      "GITHUB_STATE_UNAVAILABLE",
      "The closing merge commit is not reachable from the default branch.",
    );
  }
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
  claim,
  issueClosedAt,
  openClosingPullRequests,
}) => {
  if (openClosingPullRequests.length !== 0) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "Completed closure is invalid while a closing pull request is still open.",
    );
  }
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
  const merged = [];
  for (const pullRequest of candidates) {
    let matchesCurrentClaim = false;
    try {
      matchesCurrentClaim =
        pullRequest.merged === true &&
        pullRequest.state === "closed" &&
        primaryIssueNumber(pullRequest.body) === issueNumber &&
        claimReceiptCommentId({
          body: pullRequest.body,
          repository,
          issueNumber,
        }) === claim.claimCommentId &&
        pullRequest.number === claim.pullRequestNumber &&
        pullRequest.user?.login === claim.owner &&
        pullRequest.base?.ref === defaultBranch &&
        pullRequest.base?.repo?.full_name?.toLowerCase() ===
          repository.toLowerCase();
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
    }
    if (!matchesCurrentClaim) continue;
    requireChronology({ claim, pullRequest, issueClosedAt });
    await assertMergeReachable({
      github,
      mergeCommitSha: pullRequest.merge_commit_sha,
      defaultBranch,
    });
    merged.push(pullRequest);
  }
  if (merged.length !== 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "Completed closure requires exactly one merged pull request bound to the current claim.",
    );
  }
  return merged[0];
};

const commentsFor = (github, issueNumber) =>
  github.getAll(`/issues/${issueNumber}/comments`, "Issue comments");

export const fetchDependencies = async (github, numbers, concurrency = 4) => {
  const results = new Array(numbers.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, numbers.length) },
    async () => {
      while (nextIndex < numbers.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await github.get(`/issues/${numbers[index]}`);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const dependenciesFor = async (github, issue) => {
  let numbers;
  try {
    numbers = parseDependencies(issue.body);
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "NOT_READY")
      return [];
    throw error;
  }
  return fetchDependencies(github, numbers);
};

const loadIssueContext = async (
  github,
  issueNumber,
  knownIssue = null,
  knownOpenPullRequests = null,
) => {
  const issue = knownIssue ?? (await github.get(`/issues/${issueNumber}`));
  const [comments, dependencies, openPullRequests] = await Promise.all([
    commentsFor(github, issueNumber),
    dependenciesFor(github, issue),
    knownOpenPullRequests ??
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
    .replace("<!-- qhb-ai-lifecycle:v2", "<!-- qhb-ai-intent:v2");

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
      comment.body?.includes("<!-- qhb-ai-intent:v2") &&
      [...comment.body.matchAll(/^event-id=([1-9]\d*)$/gmu)].some(
        (match) => Number(match[1]) === Number(eventId),
      ),
  );
  if (new Set(intents.map(({ body }) => body)).size > 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "One lifecycle event has conflicting pending intents.",
    );
  }
  if (intents.length === 0) return null;
  const synthetic = {
    ...intents[0],
    body: intents[0].body.replace(
      "<!-- qhb-ai-intent:v2",
      "<!-- qhb-ai-lifecycle:v2",
    ),
  };
  const parsed = parseReceipts([
    ...comments.filter(
      (comment) => !comment.body?.includes("<!-- qhb-ai-intent:v2"),
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
      pullRequestNumber: parsed.pullRequestNumber,
      code: parsed.code,
    },
  };
};

const pendingIntentEventIds = (comments, receipts) => {
  const completed = new Set(receipts.map(({ eventId }) => eventId));
  const pending = new Set();
  for (const comment of comments) {
    if (
      comment.user?.login !== WORKFLOW_LOGIN ||
      !comment.body?.includes("<!-- qhb-ai-intent:v2")
    ) {
      continue;
    }
    const matches = [...comment.body.matchAll(/^event-id=([1-9]\d*)$/gmu)];
    if (matches.length !== 1) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "A pending lifecycle intent has an invalid event ID.",
      );
    }
    const intentEventId = Number(matches[0][1]);
    if (!completed.has(intentEventId)) pending.add(intentEventId);
  }
  return [...pending];
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
  const statusChanged = observedStatusOf(currentIssue) !== plan.to;
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
  const requestedEventId = Number(eventId);
  const requestedPlan = pendingIntentFor(
    loaded.comments,
    loaded.receipts,
    requestedEventId,
  );
  const observedState = observedStatusOf(loaded.issue);
  const currentClaim = currentClaimFromReceipts(loaded.receipts);
  const matchesCurrentClaim = (candidate) =>
    candidate.command === "claim"
      ? currentClaim === null ||
        currentClaim?.claimId === candidate.receipt.claimId
      : candidate.receipt.claimId === (currentClaim?.claimId ?? null);
  if (
    requestedPlan &&
    (!expectedActions.includes(requestedPlan.command) ||
      ![requestedPlan.from, requestedPlan.to].includes(observedState) ||
      !matchesCurrentClaim(requestedPlan))
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pending lifecycle intent does not match the current event or Issue state.",
    );
  }
  const candidatePlans = pendingIntentEventIds(loaded.comments, loaded.receipts)
    .map((candidateEventId) =>
      pendingIntentFor(loaded.comments, loaded.receipts, candidateEventId),
    )
    .filter(
      (candidate) =>
        candidate &&
        expectedActions.includes(candidate.command) &&
        [candidate.from, candidate.to].includes(observedState) &&
        matchesCurrentClaim(candidate),
    );
  if (candidatePlans.length > 1) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "More than one pending lifecycle intent matches the current Issue state.",
    );
  }
  const plan = requestedPlan ?? candidatePlans[0] ?? null;
  if (!plan) return null;
  await mutateIssueToPlan(github, issueNumber, loaded.issue, plan);
  await postReceipt(github, issueNumber, plan.receipt);
  const issue = await github.get(`/issues/${issueNumber}`);
  try {
    assertManagedIssue(issue);
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "NOT_READY") {
      return { status: "ignored", code: error.code };
    }
    throw error;
  }
  assertIssueInvariant(issue);
  return { status: "applied", plan, issue, recovered: true };
};

const failureReceipt = ({ eventId, action, actor, agent, state, code }) => ({
  version: 2,
  eventId,
  claimId: null,
  action,
  result: "failure",
  actor,
  agent,
  from: state,
  to: state,
  leaseExpiresAt: null,
  pullRequestNumber: null,
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
    let state;
    try {
      state = statusOf(issue);
    } catch (stateError) {
      if (!(stateError instanceof LifecycleError)) throw stateError;
      await postCommandRejectionNotice(github, issueNumber, eventId, code);
      return { status: "rejected", code };
    }
    await postReceipt(
      github,
      issueNumber,
      failureReceipt({
        eventId,
        action,
        actor,
        agent,
        state,
        code,
      }),
    );
  }
  return { status: "rejected", code };
};

const postCommandRejectionNotice = async (
  github,
  issueNumber,
  eventId,
  code,
) => {
  const body = [
    `AI lifecycle command rejected (\`${code}\`).`,
    "",
    code === "INVALID_COMMAND"
      ? "Use one documented `/ai-*` command with its exact required fields."
      : "This Issue is not currently eligible for an AI lifecycle command.",
    "",
    "<!-- qhb-ai-command-rejection:v1",
    `event-id=${eventId}`,
    `code=${code}`,
    "-->",
  ].join("\n");
  const existing = await commentsFor(github, issueNumber);
  if (
    existing.some(
      (comment) =>
        comment.user?.login === WORKFLOW_LOGIN && comment.body === body,
    )
  ) {
    return;
  }
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
  const typeCount = managedTypeCount(issue);
  if (typeCount !== 1) {
    const code = typeCount === 0 ? "NOT_ELIGIBLE" : "STATE_MISMATCH";
    if (mode === "enforce") {
      await postCommandRejectionNotice(github, issueNumber, commentId, code);
    }
    return { status: "rejected", code };
  }
  assertManagedIssue(issue);

  let command;
  try {
    command = parseLifecycleCommand(body);
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
    const inferredAction =
      /^\/ai-(claim|heartbeat|block|resume|release)\b/u.exec(body)?.[1];
    if (!inferredAction) {
      if (mode === "enforce") {
        await postCommandRejectionNotice(
          github,
          issueNumber,
          commentId,
          "INVALID_COMMAND",
        );
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
    loaded = await loadIssueContext(github, issueNumber, issue);
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
      expectedActions: RECEIPT_ACTIONS,
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
      now: liveComment.created_at,
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
  pullRequestNumber = null,
}) => ({
  version: 2,
  eventId: Number(eventId),
  claimId: claim?.claimId ?? null,
  action,
  result: "success",
  actor: claim?.owner ?? WORKFLOW_LOGIN,
  agent: claim?.agent ?? "none",
  from,
  to,
  leaseExpiresAt,
  pullRequestNumber,
  code: null,
});

const systemPlan = ({
  eventId,
  claim,
  action,
  from,
  to,
  leaseExpiresAt,
  pullRequestNumber = null,
}) => ({
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
    pullRequestNumber,
  }),
});

const verifyPullRequestIdentity = (eventPullRequest, currentPullRequest) => {
  for (const [label, eventValue, liveValue] of [
    ["number", eventPullRequest.number, currentPullRequest.number],
    ["state", eventPullRequest.state, currentPullRequest.state],
    ["body", eventPullRequest.body, currentPullRequest.body],
    ["head SHA", eventPullRequest.head?.sha, currentPullRequest.head?.sha],
    ["author", eventPullRequest.user?.login, currentPullRequest.user?.login],
    [
      "updated timestamp",
      eventPullRequest.updated_at,
      currentPullRequest.updated_at,
    ],
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
  openPullRequests = null,
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

  const issue = await github.get(`/issues/${issueNumber}`);
  assertManagedIssue(issue);
  const loaded = await loadIssueContext(
    github,
    issueNumber,
    issue,
    openPullRequests,
  );
  if (pullRequest.state === "open") {
    if (
      loaded.closingPullRequests.length !== 1 ||
      loaded.closingPullRequests[0].number !== pullRequest.number
    ) {
      throw new LifecycleError(
        "STATE_MISMATCH",
        "An open pull request must be the Issue's only open closing pull request.",
      );
    }
  } else if (loaded.closingPullRequests.length > 0) {
    throw new LifecycleError(
      "CLOSING_PR_EXISTS",
      "A terminal pull request event cannot leave another open closing pull request.",
    );
  }
  const prior = loaded.receipts.find(
    ({ eventId: id }) => id === Number(eventId),
  );
  if (!(pullRequest.merged === true && prior?.action === "pr-open") && prior) {
    return { status: "applied", receipt: prior, idempotent: true };
  }
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
  const claim = currentClaimFromReceipts(loaded.receipts);
  if (!claim || claim.owner !== assignee) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request does not have a current verified claim.",
    );
  }
  if (
    claimReceiptCommentId({
      body: pullRequest.body,
      repository,
      issueNumber,
    }) !== claim.claimCommentId
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The pull request claim receipt is not the current claim generation.",
    );
  }
  if (
    claim.pullRequestNumber !== null &&
    claim.pullRequestNumber !== pullRequest.number
  ) {
    throw new LifecycleError(
      "STATE_MISMATCH",
      "The claim generation is already bound to another pull request.",
    );
  }
  if (
    state === "in-progress" &&
    (pullRequest.state === "open" || pullRequest.merged === true)
  ) {
    requireReviewAdmissionChronology({
      claim,
      pullRequest,
      eventAction: event.action,
    });
  }

  let plan;
  if (pullRequest.state === "open") {
    if (state === "review") {
      if (
        claim.leaseExpiresAt !== null ||
        !durableReviewAdmissionFor(loaded.receipts, claim, pullRequest.number)
      ) {
        throw new LifecycleError(
          "STATE_MISMATCH",
          "Review state requires a durable review admission for the current claim.",
        );
      }
      return { status: "unchanged" };
    }
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
      leaseExpiresAt: null,
      pullRequestNumber: pullRequest.number,
    });
  } else if (pullRequest.merged === true) {
    if (!["in-progress", "review"].includes(state)) {
      throw new LifecycleError(
        "INVALID_TRANSITION",
        "Only active or review work can reconcile a verified merge.",
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
    requireChronology({
      claim,
      pullRequest,
      issueClosedAt: loaded.issue.closed_at,
    });
    await assertMergeReachable({
      github,
      mergeCommitSha: pullRequest.merge_commit_sha,
      defaultBranch,
    });
    const mergeEventId =
      state === "in-progress"
        ? stableSystemEventId(
            "pull-merge",
            pullRequest.number,
            pullRequest.merged_at,
            pullRequest.merge_commit_sha,
          )
        : eventId;
    if (state === "in-progress") {
      const catchup = systemPlan({
        eventId,
        claim,
        action: "pr-open",
        from: "in-progress",
        to: "review",
        leaseExpiresAt: null,
        pullRequestNumber: pullRequest.number,
      });
      if (mode === "report") {
        return {
          status: "report",
          plans: [
            catchup,
            systemPlan({
              eventId: mergeEventId,
              claim,
              action: "merge",
              from: "review",
              to: "done",
              pullRequestNumber: pullRequest.number,
            }),
          ],
        };
      }
      await ensureIntent(github, issueNumber, catchup);
      await postReceipt(github, issueNumber, catchup.receipt);
      const existingMerge = parseReceipts(
        await commentsFor(github, issueNumber),
      ).find(({ eventId: id }) => id === mergeEventId);
      if (existingMerge) {
        return {
          status: "applied",
          receipt: existingMerge,
          idempotent: true,
        };
      }
    }
    plan = systemPlan({
      eventId: mergeEventId,
      claim,
      action: "merge",
      from: "review",
      to: "done",
      pullRequestNumber: pullRequest.number,
    });
  } else {
    if (state === "in-progress") return { status: "unchanged" };
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
      pullRequestNumber: pullRequest.number,
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
  openPullRequests = null,
}) => {
  assertMode(mode);
  requireRepository(event, repository);
  if (event.issue?.pull_request) return { status: "ignored" };
  const issueNumber = requirePositiveInteger(
    event.issue?.number,
    "Issue number",
  );
  const issue = await github.get(`/issues/${issueNumber}`);
  if (issue.pull_request) return { status: "ignored" };
  const typeCount = managedTypeCount(issue);
  if (typeCount === 0) return { status: "ignored" };
  assertManagedIssue(issue);
  const loaded = await loadIssueContext(
    github,
    issueNumber,
    issue,
    openPullRequests,
  );
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
      expectedActions: ["close", "reopen", "initialize", "refresh", "expire"],
    });
    if (recovered) return recovered;
  }
  const managedStatuses = labelsOf(loaded.issue).filter((label) =>
    STATUS_LABELS.includes(label),
  );
  const claim = currentClaimFromReceipts(loaded.receipts);

  let plan;
  if (
    loaded.issue.state === "open" &&
    managedStatuses.length === 0 &&
    assigneesOf(loaded.issue).length === 0
  ) {
    const readiness = evaluateReadiness({
      issue: loaded.issue,
      dependencies: loaded.dependencies,
      closingPullRequests: loaded.closingPullRequests,
    });
    if (readiness.code === "GITHUB_STATE_UNAVAILABLE") {
      throw new LifecycleError(
        readiness.code,
        "Cannot initialize Issue state.",
      );
    }
    plan = systemPlan({
      eventId,
      claim: null,
      action: "initialize",
      from: "unmanaged",
      to: readiness.ready ? "ready" : "waiting",
    });
  } else {
    const state = statusOf(loaded.issue);
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
      const mergedPullRequest = await mergedPullRequestForIssue({
        github,
        issueNumber,
        repository,
        defaultBranch: event.repository.default_branch,
        claim,
        issueClosedAt: loaded.issue.closed_at,
        openClosingPullRequests: loaded.closingPullRequests,
      });
      plan = systemPlan({
        eventId,
        claim,
        action: "close",
        from: "review",
        to: "done",
        pullRequestNumber: mergedPullRequest.number,
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
    } else if (
      loaded.issue.state === "open" &&
      ["waiting", "ready"].includes(state) &&
      assigneesOf(loaded.issue).length === 0
    ) {
      const readiness = evaluateReadiness({
        issue: loaded.issue,
        dependencies: loaded.dependencies,
        closingPullRequests: loaded.closingPullRequests,
      });
      if (readiness.code === "GITHUB_STATE_UNAVAILABLE") {
        throw new LifecycleError(
          readiness.code,
          "Cannot refresh Issue readiness.",
        );
      }
      const to = readiness.ready ? "ready" : "waiting";
      if (to === state) return { status: "unchanged" };
      plan = systemPlan({
        eventId,
        claim: null,
        action: "refresh",
        from: state,
        to,
      });
    } else {
      try {
        const invariant = assertIssueInvariant(loaded.issue);
        if (["in-progress", "review", "blocked"].includes(invariant.state)) {
          if (!claim || claim.owner !== invariant.assignee) {
            throw new LifecycleError(
              "STATE_MISMATCH",
              "Active Issue state requires a current claim matching its assignee.",
            );
          }
          if (
            invariant.state === "review" &&
            (claim.leaseExpiresAt !== null ||
              !durableReviewAdmissionFor(
                loaded.receipts,
                claim,
                loaded.closingPullRequests[0]?.number,
              ) ||
              loaded.closingPullRequests.length !== 1)
          ) {
            throw new LifecycleError(
              "STATE_MISMATCH",
              "Review state requires one open closing pull request and a durable review admission.",
            );
          }
        }
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
  const openPullRequests = await github.getAll(
    "/pulls?state=open",
    "open pull requests",
  );
  const released = [];
  const failures = [];
  for (const listedIssue of issues) {
    try {
      const issueNumber = requirePositiveInteger(
        listedIssue.number,
        "Issue number",
      );
      const loaded = await loadIssueContext(
        github,
        issueNumber,
        null,
        openPullRequests,
      );
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
        ["GITHUB_STATE_UNAVAILABLE", "CLOSING_PR_EXISTS"].includes(
          readiness.code,
        )
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
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} expired claim(s) failed after reconciliation continued`,
    );
  }
  return { status: mode === "enforce" ? "applied" : "report", released };
};

const completedCommandEventIds = (comments) =>
  new Set(
    comments.flatMap((comment) => {
      if (
        comment.user?.login !== WORKFLOW_LOGIN ||
        typeof comment.body !== "string"
      ) {
        return [];
      }
      const match =
        /<!-- qhb-ai-(?:lifecycle:v2|command-rejection:v1)[\s\S]*?^event-id=([1-9]\d*)$/mu.exec(
          comment.body,
        );
      return match ? [Number(match[1])] : [];
    }),
  );

const issueNumberFromComment = (comment, repository) => {
  let url;
  try {
    url = new URL(comment.issue_url);
  } catch {
    throw new Error("Repository comment is missing a valid Issue URL");
  }
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^/repos/${escapedRepository}/issues/([1-9]\\d*)$`,
    "iu",
  ).exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.github.com" ||
    url.search ||
    url.hash ||
    !match
  ) {
    throw new Error("Repository comment Issue URL is outside the repository");
  }
  return Number(match[1]);
};

const recentRepositoryComments = async (github) => {
  const comments = [];
  for (let page = 1; page <= COMMAND_SCAN_MAX_PAGES; page += 1) {
    const pageComments = await github.get(
      `/issues/comments?sort=created&direction=desc&per_page=${COMMAND_SCAN_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(pageComments)) {
      throw new Error(
        `Repository Issue comments page ${page} must be an array`,
      );
    }
    if (pageComments.length > COMMAND_SCAN_PAGE_SIZE) {
      throw new Error(
        `Repository Issue comments page ${page} exceeded the requested page size`,
      );
    }
    comments.push(...pageComments);
    if (pageComments.length < COMMAND_SCAN_PAGE_SIZE) break;
  }
  return comments;
};

export const reconcileLifecycleCommands = async ({
  github,
  repository,
  defaultBranch,
  mode = "report",
  now,
  issueNumber = null,
  maxCommands = MAX_COMMANDS_PER_DRAIN,
}) => {
  assertMode(mode);
  requirePositiveInteger(maxCommands, "AI lifecycle command drain cap");
  const comments = issueNumber
    ? await commentsFor(github, issueNumber)
    : await recentRepositoryComments(github);
  const completed = completedCommandEventIds(comments);
  let candidates = comments.filter(
    (comment) =>
      comment.user?.login !== WORKFLOW_LOGIN &&
      typeof comment.body === "string" &&
      comment.body.trimStart().startsWith(COMMAND_PREFIX) &&
      !completed.has(Number(comment.id)),
  );
  if (!issueNumber) {
    const numberedCandidates = candidates.map((comment) => ({
      comment,
      issueNumber: issueNumberFromComment(comment, repository),
    }));
    const issueNumbers = [
      ...new Set(numberedCandidates.map(({ issueNumber: number }) => number)),
    ];
    const parents = await fetchDependencies(github, issueNumbers);
    const parentByNumber = new Map(
      parents.map((parent, index) => [issueNumbers[index], parent]),
    );
    candidates = numberedCandidates
      .filter(
        ({ issueNumber: number }) => !parentByNumber.get(number)?.pull_request,
      )
      .map(({ comment, issueNumber: number }) => ({
        ...comment,
        governedIssueNumber: number,
      }));
  }
  const pending = candidates
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, maxCommands);
  const results = [];
  const failures = [];
  for (const comment of pending) {
    try {
      const number = issueNumber ?? comment.governedIssueNumber;
      results.push(
        await handleIssueComment({
          github,
          event: {
            repository: {
              full_name: repository,
              default_branch: defaultBranch,
            },
            issue: { number },
            comment,
          },
          repository,
          mode,
          now,
          eventId: comment.id,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} lifecycle command(s) failed after the ordered drain continued`,
    );
  }
  return { status: mode, processed: pending.length, results };
};

export const reconcileRepositoryState = async ({
  github,
  repository,
  defaultBranch,
  mode = "report",
  now,
  maxObjects = MAX_RECONCILIATION_OBJECTS,
}) => {
  assertMode(mode);
  const [listedIssues, listedPullRequests] = await Promise.all([
    github.getAll(
      "/issues?state=all&sort=updated&direction=asc",
      "repository Issues",
    ),
    github.getAll(
      "/pulls?state=all&sort=updated&direction=asc",
      "repository pull requests",
    ),
  ]);
  const issues = listedIssues.filter(
    (issue) => !issue.pull_request && managedTypeCount(issue) > 0,
  );
  const openPullRequests = listedPullRequests.filter(
    (pullRequest) => pullRequest.state === "open",
  );
  const pullRequests = listedPullRequests.filter((pullRequest) => {
    try {
      const issueNumber = primaryIssueNumber(pullRequest.body);
      claimReceiptCommentId({
        body: pullRequest.body,
        repository,
        issueNumber,
      });
      return true;
    } catch (error) {
      if (error instanceof LifecycleError) return false;
      throw error;
    }
  });
  if (issues.length + pullRequests.length > maxObjects) {
    throw new Error(
      `AI lifecycle reconciliation exceeds the ${maxObjects}-object cap`,
    );
  }
  const failures = [];
  const results = [];
  for (const issue of issues) {
    try {
      results.push(
        await handleIssueChange({
          github,
          event: {
            repository: {
              full_name: repository,
              default_branch: defaultBranch,
            },
            issue,
          },
          repository,
          mode,
          eventId: stableSystemEventId(
            "issue-reconcile",
            issue.number,
            issue.updated_at,
            issue.state,
            issue.state_reason,
          ),
          openPullRequests,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  for (const pullRequest of pullRequests) {
    try {
      results.push(
        await handlePullRequest({
          github,
          event: {
            repository: {
              full_name: repository,
              default_branch: defaultBranch,
            },
            pull_request: pullRequest,
          },
          repository,
          mode,
          now,
          openPullRequests,
          eventId: stableSystemEventId(
            "pull-reconcile",
            pullRequest.number,
            pullRequest.updated_at,
            pullRequest.head?.sha,
            pullRequest.merged_at,
          ),
        }),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} repository lifecycle object(s) failed after reconciliation continued`,
    );
  }
  return { status: mode, processed: results.length, results };
};

export const runReconciliationPhases = async (phases) => {
  const results = {};
  const failures = [];
  for (const { name, run } of phases) {
    try {
      results[name] = await run();
    } catch (error) {
      failures.push(
        new Error(`${name}: ${error.message}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} lifecycle reconciliation phase(s) failed after reconciliation continued`,
    );
  }
  return results;
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
  mode = process.env.AI_LIFECYCLE_MUTATION_MODE ?? "report",
  runId = process.env.GITHUB_RUN_ID,
  fetchImpl = globalThis.fetch,
  now = null,
  migrationsPath = MIGRATION_PATH,
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
  const github = createGitHubClient({ fetchImpl, repository, token });
  const authoritativeNow = now ?? (await github.serverTime());
  let migrations;
  try {
    migrations = JSON.parse(readFileSync(resolve(migrationsPath), "utf8"));
  } catch {
    throw new Error("Lifecycle migration registry must contain valid JSON");
  }
  const activation = validateLifecycleMutationMode(migrations, {
    mode,
    now: authoritativeNow,
  });
  if (activation.phase === "activated") {
    const comparison = await github.get(
      `/compare/${activation.activationCommit}...${encodeURIComponent(event.repository.default_branch)}`,
    );
    if (!["ahead", "identical"].includes(comparison.status)) {
      throw new Error(
        "Lifecycle activation commit is not reachable from the default branch",
      );
    }
  }
  const defaultBranch = event.repository?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw new Error("GitHub event default branch is required");
  }
  let result;
  if (eventName === "issue_comment") {
    const issueNumber = requirePositiveInteger(
      event.issue?.number,
      "Issue number",
    );
    result = await runReconciliationPhases([
      {
        name: "commandDrain",
        run: () =>
          reconcileLifecycleCommands({
            github,
            repository,
            defaultBranch,
            mode,
            now: authoritativeNow,
          }),
      },
      {
        name: "lifecycle",
        run: () =>
          handleIssueChange({
            github,
            event,
            repository,
            mode,
            eventId: stableSystemEventId(
              "issue-reconcile",
              issueNumber,
              event.issue?.updated_at,
              event.issue?.state,
              event.issue?.state_reason,
            ),
          }),
      },
    ]);
  } else if (eventName === "issues") {
    const issueNumber = requirePositiveInteger(
      event.issue?.number,
      "Issue number",
    );
    result = await runReconciliationPhases([
      {
        name: "commandDrain",
        run: () =>
          reconcileLifecycleCommands({
            github,
            repository,
            defaultBranch,
            mode,
            now: authoritativeNow,
          }),
      },
      {
        name: "lifecycle",
        run: () =>
          runLifecycleController({
            github,
            event,
            eventName,
            repository,
            mode,
            now: authoritativeNow,
            eventId: stableSystemEventId(
              eventName,
              issueNumber,
              event.issue?.updated_at,
              event.action,
            ),
          }),
      },
    ]);
  } else if (["schedule", "workflow_dispatch"].includes(eventName)) {
    result = await runReconciliationPhases([
      {
        name: "commandDrain",
        run: () =>
          reconcileLifecycleCommands({
            github,
            repository,
            defaultBranch,
            mode,
            now: authoritativeNow,
          }),
      },
      {
        name: "repositoryState",
        run: () =>
          reconcileRepositoryState({
            github,
            repository,
            defaultBranch,
            mode,
            now: authoritativeNow,
          }),
      },
      {
        name: "lifecycle",
        run: () =>
          reconcileExpiredClaims({
            github,
            mode,
            now: authoritativeNow,
            eventId: requirePositiveInteger(runId, "GITHUB_RUN_ID"),
          }),
      },
    ]);
  } else {
    result = await runReconciliationPhases([
      {
        name: "commandDrain",
        run: () =>
          reconcileLifecycleCommands({
            github,
            repository,
            defaultBranch,
            mode,
            now: authoritativeNow,
          }),
      },
      {
        name: "lifecycle",
        run: () =>
          runLifecycleController({
            github,
            event,
            eventName,
            repository,
            mode,
            now: authoritativeNow,
            eventId: stableSystemEventId(
              eventName,
              event.pull_request?.number,
              event.pull_request?.updated_at,
              event.action,
              event.pull_request?.head?.sha,
              event.pull_request?.merged_at,
            ),
          }),
      },
    ]);
  }
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
