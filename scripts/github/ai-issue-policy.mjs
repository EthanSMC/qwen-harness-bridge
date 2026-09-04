import { Buffer } from "node:buffer";

export const STATUS_LABELS = Object.freeze([
  "status:waiting",
  "status:ready",
  "status:in-progress",
  "status:review",
  "status:blocked",
  "status:done",
]);

export const MANAGED_TYPE_LABELS = Object.freeze([
  "type:feature",
  "type:bug",
  "type:test",
  "type:docs",
  "type:security",
]);

export const MAX_DEPENDENCIES = 20;
export const MAX_DEPENDENCY_DECLARATION_BYTES = 512;

export const COMMAND_NAMES = Object.freeze([
  "claim",
  "heartbeat",
  "block",
  "resume",
  "release",
]);

export const RECEIPT_ACTIONS = Object.freeze([
  ...COMMAND_NAMES,
  "expire",
  "pr-open",
  "pr-close",
  "merge",
  "close",
  "reopen",
  "initialize",
  "refresh",
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  waiting: Object.freeze(["ready"]),
  ready: Object.freeze(["in-progress"]),
  "in-progress": Object.freeze(["review", "blocked", "ready", "waiting"]),
  blocked: Object.freeze(["in-progress", "ready", "waiting"]),
  review: Object.freeze(["in-progress", "blocked", "done"]),
  done: Object.freeze(["ready", "waiting"]),
});

const STATUS_PREFIX = "status:";
const ELIGIBLE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const MAINTAINER_PERMISSIONS = new Set(["admin", "maintain"]);
const LEASE_MILLISECONDS = 24 * 60 * 60 * 1000;
const RECEIPT_START = "<!-- qhb-ai-lifecycle:v2";
const RECEIPT_END = "-->";
const RECEIPT_PREFIX = "<!-- qhb-ai-lifecycle:v";
const RECEIPT_KEYS = [
  "event-id",
  "claim-id",
  "action",
  "result",
  "actor",
  "agent",
  "from",
  "to",
  "lease-expires-at",
  "pull-request",
  "code",
];

const COMMAND_FIELDS = Object.freeze({
  claim: ["agent"],
  heartbeat: ["summary"],
  block: ["reason", "resume-when"],
  resume: [],
  release: ["reason"],
});

const ERROR_CODES = new Set([
  "NOT_ELIGIBLE",
  "NOT_READY",
  "ALREADY_CLAIMED",
  "DEPENDENCY_OPEN",
  "CLOSING_PR_EXISTS",
  "NOT_OWNER",
  "INVALID_COMMAND",
  "INVALID_TRANSITION",
  "LEASE_EXPIRED",
  "STATE_MISMATCH",
  "GITHUB_STATE_UNAVAILABLE",
]);

const SUCCESS_TRANSITIONS = Object.freeze({
  claim: ["ready", "in-progress"],
  block: ["in-progress", "blocked"],
  resume: ["blocked", "in-progress"],
  "pr-open": ["in-progress", "review"],
  "pr-close": ["review", "in-progress"],
});

const RECEIPT_END_ACTIONS = new Set(["release", "expire", "merge", "close"]);
const UNCLAIMED_ACTIONS = new Set(["reopen", "initialize", "refresh"]);
const OWNER_BOUND_ACTIONS = new Set([
  "heartbeat",
  "block",
  "resume",
  "pr-open",
  "pr-close",
  "merge",
  "close",
]);
const PULL_REQUEST_ACTIONS = new Set(["pr-open", "pr-close", "merge", "close"]);

export class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new LifecycleError(code, message);
};

const normalizedLabels = (issue) =>
  (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );

const normalizedAssignees = (issue) =>
  (issue.assignees ?? []).map((assignee) =>
    typeof assignee === "string" ? assignee : assignee?.login,
  );

const normalizedPermission = (permission) =>
  permission === "push" ? "write" : String(permission ?? "").toLowerCase();

export const stripMarkdownCode = (body) => {
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

export const closingIssueNumbers = (body) =>
  [
    ...stripMarkdownCode(body).matchAll(
      /^\s*-?\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\s*$/gimu,
    ),
  ].map((match) => Number(match[1]));

const isCompletedDependency = (dependency) =>
  String(dependency.state).toLowerCase() === "closed" &&
  String(dependency.state_reason ?? dependency.stateReason).toLowerCase() ===
    "completed";

const nonemptySection = (body, heading) => {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expectedHeading = new RegExp(
    `^#{2,3}[\\t ]+${escapedHeading}[\\t ]*$`,
    "iu",
  );
  const start = lines.findIndex((line) => expectedHeading.test(line));
  if (start < 0) return false;
  const nextHeading = lines.findIndex(
    (line, index) => index > start && /^#{2,3}[\t ]+/u.test(line),
  );
  const end = nextHeading < 0 ? lines.length : nextHeading;
  return lines.slice(start + 1, end).some((line) => line.trim().length > 0);
};

const plusOneLease = (now) => {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    fail("INVALID_COMMAND", "The event timestamp is invalid.");
  }
  return new Date(date.getTime() + LEASE_MILLISECONDS).toISOString();
};

const isExpired = (leaseExpiresAt, now) => {
  const leaseTime = Date.parse(leaseExpiresAt);
  const nowTime = Date.parse(now);
  if (Number.isNaN(leaseTime) || Number.isNaN(nowTime)) {
    fail("STATE_MISMATCH", "The active claim has an invalid lease timestamp.");
  }
  return nowTime >= leaseTime;
};

const eventIdOf = (receipt) => Number(receipt.eventId);

const hasControlCharacter = (text) =>
  [...text].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });

const receiptIdentity = (receipt) =>
  JSON.stringify({
    version: receipt.version,
    eventId: receipt.eventId,
    claimId: receipt.claimId,
    action: receipt.action,
    result: receipt.result,
    actor: receipt.actor,
    agent: receipt.agent,
    from: receipt.from,
    to: receipt.to,
    leaseExpiresAt: receipt.leaseExpiresAt,
    pullRequestNumber: receipt.pullRequestNumber,
    code: receipt.code,
  });

export const currentClaimFromReceipts = (receipts) => {
  let active = null;
  for (const receipt of receipts) {
    if (receipt.result !== "success") continue;
    if (receipt.action === "claim") {
      active = {
        claimId: receipt.claimId,
        owner: receipt.actor,
        agent: receipt.agent,
        leaseExpiresAt: receipt.leaseExpiresAt,
        pullRequestNumber: null,
        claimCommentId: receipt.commentId ?? null,
        claimedAt: receipt.createdAt ?? null,
      };
      continue;
    }
    if (!active || receipt.claimId !== active.claimId) continue;
    if (RECEIPT_END_ACTIONS.has(receipt.action)) {
      active = null;
    } else if (
      ["heartbeat", "resume", "pr-open", "pr-close"].includes(receipt.action)
    ) {
      active.leaseExpiresAt = receipt.leaseExpiresAt;
      if (receipt.action === "pr-open") {
        active.pullRequestNumber = receipt.pullRequestNumber;
      }
    }
  }
  return active;
};

const makeReceipt = ({
  eventId,
  claimId,
  action,
  actor,
  agent,
  from,
  to,
  leaseExpiresAt = null,
  pullRequestNumber = null,
}) => ({
  version: 2,
  eventId: Number(eventId),
  claimId,
  action,
  result: "success",
  actor,
  agent,
  from,
  to,
  leaseExpiresAt,
  pullRequestNumber,
  code: null,
});

const basePlan = ({
  eventId,
  claim,
  action,
  actor,
  from,
  to,
  leaseExpiresAt = null,
}) => ({
  command: action,
  from,
  to,
  assignee: null,
  removeAssignee: null,
  leaseExpiresAt,
  receipt: makeReceipt({
    eventId,
    claimId: claim.claimId,
    action,
    actor,
    agent: claim.agent,
    from,
    to,
    leaseExpiresAt,
  }),
});

export const safePublicText = (value, maxBytes = 240) => {
  if (typeof value !== "string") {
    fail("INVALID_COMMAND", "Public command fields must be text.");
  }

  const text = value.trim();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > maxBytes ||
    hasControlCharacter(text)
  ) {
    fail("INVALID_COMMAND", "A public command field is empty or too large.");
  }
  if (/codex:\/\//iu.test(text)) {
    fail(
      "INVALID_COMMAND",
      "Private Codex task identifiers are not public data.",
    );
  }
  if (
    /(?:^|\s)(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/iu.test(
      text,
    )
  ) {
    fail("INVALID_COMMAND", "Credential-like assignments are not allowed.");
  }
  if (
    /(?:^|\s)\/(?:Users|home|private|tmp|var\/folders|Volumes)\//u.test(text) ||
    /(?:^|\s)[A-Za-z]:\\/u.test(text)
  ) {
    fail("INVALID_COMMAND", "Local absolute paths are not public data.");
  }

  if (/(?:^|\s)\/(?!\/)[^\s]+/u.test(text)) {
    fail("INVALID_COMMAND", "Absolute Unix paths are not public data.");
  }

  const urls = text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)\]}>,]+/giu) ?? [];
  for (const urlText of urls) {
    let url;
    try {
      url = new URL(urlText);
    } catch {
      fail(
        "INVALID_COMMAND",
        "A public command field contains an invalid URL.",
      );
    }
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (hostname !== "github.com" && !hostname.endsWith(".github.com"))
    ) {
      fail("INVALID_COMMAND", "Only public GitHub URLs are allowed.");
    }
  }
  return text;
};

export const parseLifecycleCommand = (body) => {
  if (typeof body !== "string") {
    fail("INVALID_COMMAND", "The comment must contain one lifecycle command.");
  }
  const lines = body.replace(/\r\n?/gu, "\n").trim().split("\n");
  const commandMatch = /^\/ai-(claim|heartbeat|block|resume|release)$/u.exec(
    lines[0],
  );
  if (!commandMatch) {
    fail("INVALID_COMMAND", "The first line is not a lifecycle command.");
  }

  const name = commandMatch[1];
  const expected = COMMAND_FIELDS[name];
  const fields = {};
  for (const line of lines.slice(1)) {
    const match = /^([a-z][a-z-]*):[\t ]+(.+)$/u.exec(line);
    if (!match || !expected.includes(match[1]) || match[1] in fields) {
      fail("INVALID_COMMAND", "The lifecycle command has invalid fields.");
    }
    fields[match[1]] = safePublicText(match[2]);
  }
  if (
    Object.keys(fields).length !== expected.length ||
    expected.some((field) => !(field in fields))
  ) {
    fail(
      "INVALID_COMMAND",
      "The lifecycle command is missing required fields.",
    );
  }
  if (name === "claim" && !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(fields.agent)) {
    fail("INVALID_COMMAND", "The agent class must be a public slug.");
  }
  return { name, fields };
};

export const parseDependencies = (body) => {
  if (typeof body !== "string") {
    fail("NOT_READY", "The issue body is unavailable.");
  }
  const declarations = body.match(/^Blocked by[\t ]+.+$/gimu) ?? [];
  if (declarations.length !== 1) {
    fail("NOT_READY", "The issue needs exactly one dependency declaration.");
  }
  const declaration = declarations[0].trim();
  if (
    Buffer.byteLength(declaration, "utf8") > MAX_DEPENDENCY_DECLARATION_BYTES
  ) {
    fail("NOT_READY", "The dependency declaration is too large.");
  }
  if (/^Blocked by[\t ]+none$/iu.test(declaration)) return [];

  const match = /^Blocked by[\t ]+(#[1-9]\d*(?:,[\t ]*#[1-9]\d*)*)$/iu.exec(
    declaration,
  );
  if (!match) {
    fail("NOT_READY", "The dependency declaration is not canonical.");
  }
  const numbers = match[1]
    .split(",")
    .map((item) => Number(item.trim().slice(1)));
  if (new Set(numbers).size !== numbers.length) {
    fail("NOT_READY", "The dependency declaration contains duplicates.");
  }
  if (numbers.length > MAX_DEPENDENCIES) {
    fail(
      "NOT_READY",
      `The dependency declaration exceeds ${MAX_DEPENDENCIES} Issues.`,
    );
  }
  return numbers;
};

export const assertIssueInvariant = (issue) => {
  if (!issue || typeof issue !== "object") {
    fail("GITHUB_STATE_UNAVAILABLE", "The issue state is unavailable.");
  }
  const managedLabels = normalizedLabels(issue).filter((label) =>
    STATUS_LABELS.includes(label),
  );
  if (managedLabels.length !== 1) {
    fail("STATE_MISMATCH", "The issue must have exactly one lifecycle label.");
  }
  const managedTypes = normalizedLabels(issue).filter((label) =>
    MANAGED_TYPE_LABELS.includes(label),
  );
  if (managedTypes.length !== 1) {
    fail(
      "STATE_MISMATCH",
      "The issue must have exactly one managed type label.",
    );
  }
  const state = managedLabels[0].slice(STATUS_PREFIX.length);
  const assignees = normalizedAssignees(issue).filter(Boolean);
  const assignedStates = new Set(["in-progress", "review", "blocked"]);
  const expectedAssignees = assignedStates.has(state) ? 1 : 0;
  if (assignees.length !== expectedAssignees) {
    fail(
      "STATE_MISMATCH",
      "The assignee count does not match lifecycle state.",
    );
  }

  const githubState = String(issue.state ?? "").toLowerCase();
  const stateReason = String(
    issue.state_reason ?? issue.stateReason ?? "",
  ).toLowerCase();
  if (
    (state === "done" &&
      (githubState !== "closed" || stateReason !== "completed")) ||
    (state !== "done" && githubState !== "open")
  ) {
    fail(
      "STATE_MISMATCH",
      "GitHub open/closed state disagrees with lifecycle state.",
    );
  }
  return { state, assignee: assignees[0] ?? null };
};

export const evaluateReadiness = ({
  issue,
  dependencies,
  closingPullRequests,
}) => {
  if (
    !issue ||
    !Array.isArray(dependencies) ||
    !Array.isArray(closingPullRequests)
  ) {
    return {
      ready: false,
      code: "GITHUB_STATE_UNAVAILABLE",
      dependencyNumbers: [],
    };
  }

  let dependencyNumbers;
  try {
    dependencyNumbers = parseDependencies(issue.body);
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
    return { ready: false, code: error.code, dependencyNumbers: [] };
  }

  const managedTypes = normalizedLabels(issue).filter((label) =>
    MANAGED_TYPE_LABELS.includes(label),
  );
  if (managedTypes.length !== 1) {
    return { ready: false, code: "NOT_READY", dependencyNumbers };
  }
  if (dependencyNumbers.includes(Number(issue.number))) {
    return { ready: false, code: "NOT_READY", dependencyNumbers };
  }

  const body = issue.body;
  if (
    !nonemptySection(body, "Outcome") ||
    !nonemptySection(body, "Verification") ||
    !nonemptySection(body, "Risk and rollback") ||
    !nonemptySection(body, "Definition of done")
  ) {
    return { ready: false, code: "NOT_READY", dependencyNumbers };
  }

  const dependencyMap = new Map(
    dependencies.map((dependency) => [Number(dependency.number), dependency]),
  );
  if (
    dependencyMap.size !== dependencyNumbers.length ||
    dependencyNumbers.some((number) => !dependencyMap.has(number))
  ) {
    return {
      ready: false,
      code: "GITHUB_STATE_UNAVAILABLE",
      dependencyNumbers,
    };
  }
  if (
    dependencyNumbers.some(
      (number) => !isCompletedDependency(dependencyMap.get(number)),
    )
  ) {
    return { ready: false, code: "DEPENDENCY_OPEN", dependencyNumbers };
  }
  if (
    closingPullRequests.some(
      (pullRequest) => String(pullRequest.state).toLowerCase() === "open",
    )
  ) {
    return { ready: false, code: "CLOSING_PR_EXISTS", dependencyNumbers };
  }
  return { ready: true, code: null, dependencyNumbers };
};

export const planLifecycleCommand = ({
  command,
  issue,
  actor,
  actorPermission,
  dependencies,
  closingPullRequests,
  receipts,
  now,
  eventId,
  randomUUID,
}) => {
  const existing = (receipts ?? []).find(
    (receipt) => eventIdOf(receipt) === Number(eventId),
  );
  if (existing) return { idempotent: true, receipt: existing };

  const { state, assignee } = assertIssueInvariant(issue);
  const permission = normalizedPermission(actorPermission);
  const action = command?.name;
  const currentClaim = currentClaimFromReceipts(receipts ?? []);

  if (action === "claim") {
    if (!ELIGIBLE_PERMISSIONS.has(permission)) {
      fail("NOT_ELIGIBLE", "The actor cannot claim repository work.");
    }
    if (["in-progress", "review", "blocked"].includes(state)) {
      fail("ALREADY_CLAIMED", "The issue already has an accountable owner.");
    }
    if (state !== "ready") {
      fail("NOT_READY", "Only a ready issue can be claimed.");
    }
    const readiness = evaluateReadiness({
      issue,
      dependencies,
      closingPullRequests,
    });
    if (!readiness.ready) fail(readiness.code, "The issue is not claimable.");

    const leaseExpiresAt = plusOneLease(now);
    const claim = {
      claimId: randomUUID(),
      owner: actor,
      agent: command.fields.agent,
    };
    return {
      ...basePlan({
        eventId,
        claim,
        action,
        actor,
        from: state,
        to: "in-progress",
        leaseExpiresAt,
      }),
      assignee: actor,
    };
  }

  if (!currentClaim || currentClaim.owner !== assignee) {
    fail("STATE_MISMATCH", "No active receipt matches the assigned owner.");
  }
  const isOwner = actor === currentClaim.owner;

  if (action === "heartbeat") {
    if (!isOwner) fail("NOT_OWNER", "Only the owner can renew a claim.");
    if (state !== "in-progress") {
      fail(
        "INVALID_TRANSITION",
        "Only in-progress work accepts a heartbeat before review admission.",
      );
    }
    if (isExpired(currentClaim.leaseExpiresAt, now)) {
      fail("LEASE_EXPIRED", "The claim lease expired before this heartbeat.");
    }
    const leaseExpiresAt = plusOneLease(now);
    return basePlan({
      eventId,
      claim: currentClaim,
      action,
      actor,
      from: state,
      to: state,
      leaseExpiresAt,
    });
  }

  if (action === "block") {
    if (!isOwner) fail("NOT_OWNER", "Only the owner can block a claim.");
    if (state !== "in-progress") {
      fail("INVALID_TRANSITION", "Only in-progress work can become blocked.");
    }
    if (isExpired(currentClaim.leaseExpiresAt, now)) {
      fail("LEASE_EXPIRED", "The claim lease expired before it was blocked.");
    }
    return basePlan({
      eventId,
      claim: currentClaim,
      action,
      actor,
      from: state,
      to: "blocked",
      leaseExpiresAt: currentClaim.leaseExpiresAt,
    });
  }

  if (action === "resume") {
    if (!isOwner) fail("NOT_OWNER", "Only the owner can resume a claim.");
    if (state !== "blocked") {
      fail("INVALID_TRANSITION", "Only blocked work can resume.");
    }
    const leaseExpiresAt = plusOneLease(now);
    return basePlan({
      eventId,
      claim: currentClaim,
      action,
      actor,
      from: state,
      to: "in-progress",
      leaseExpiresAt,
    });
  }

  if (action === "release") {
    if (!isOwner && !MAINTAINER_PERMISSIONS.has(permission)) {
      fail("NOT_OWNER", "Only the owner or a maintainer can release a claim.");
    }
    if (!["in-progress", "review", "blocked"].includes(state)) {
      fail("INVALID_TRANSITION", "Only active work can be released.");
    }
    const readiness = evaluateReadiness({
      issue,
      dependencies,
      closingPullRequests,
    });
    if (readiness.code === "CLOSING_PR_EXISTS") {
      fail(readiness.code, "Close or detach the closing pull request first.");
    }
    if (readiness.code === "GITHUB_STATE_UNAVAILABLE") {
      fail(readiness.code, "GitHub dependency state is incomplete.");
    }
    const to = readiness.ready ? "ready" : "waiting";
    return {
      ...basePlan({
        eventId,
        claim: currentClaim,
        action,
        actor,
        from: state,
        to,
      }),
      removeAssignee: assignee,
    };
  }

  fail("INVALID_COMMAND", "The lifecycle command is unsupported.");
};

const receiptValue = (value) =>
  value === null || value === undefined ? "-" : String(value);

export const receiptBody = (receipt) => {
  const values = {
    "event-id": receipt.eventId,
    "claim-id": receipt.claimId,
    action: receipt.action,
    result: receipt.result,
    actor: receipt.actor,
    agent: receipt.agent,
    from: receipt.from,
    to: receipt.to,
    "lease-expires-at": receipt.leaseExpiresAt,
    "pull-request": receipt.pullRequestNumber,
    code: receipt.code,
  };
  const marker = RECEIPT_KEYS.map(
    (key) => `${key}=${receiptValue(values[key])}`,
  ).join("\n");
  return [
    `AI lifecycle ${receipt.action}: ${receipt.from} → ${receipt.to}.`,
    "",
    RECEIPT_START,
    marker,
    RECEIPT_END,
  ].join("\n");
};

const parseReceiptBody = (body) => {
  const start = body.indexOf(RECEIPT_START);
  if (start < 0) {
    if (body.includes(RECEIPT_PREFIX)) {
      fail("STATE_MISMATCH", "The lifecycle receipt version is unsupported.");
    }
    return null;
  }
  const end = body.indexOf(RECEIPT_END, start + RECEIPT_START.length);
  if (end < 0) fail("STATE_MISMATCH", "A lifecycle receipt is truncated.");
  const content = body
    .slice(start + RECEIPT_START.length, end)
    .trim()
    .split("\n");
  const values = {};
  for (const line of content) {
    const match = /^([a-z][a-z-]*)=(.*)$/u.exec(line);
    if (!match || !RECEIPT_KEYS.includes(match[1]) || match[1] in values) {
      fail("STATE_MISMATCH", "A lifecycle receipt is malformed.");
    }
    values[match[1]] = match[2] === "-" ? null : match[2];
  }
  if (RECEIPT_KEYS.some((key) => !(key in values))) {
    fail("STATE_MISMATCH", "A lifecycle receipt is incomplete.");
  }

  const eventId = Number(values["event-id"]);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid event ID.");
  }
  const receipt = {
    version: 2,
    eventId,
    claimId: values["claim-id"],
    action: values.action,
    result: values.result,
    actor: values.actor,
    agent: values.agent,
    from: values.from,
    to: values.to,
    leaseExpiresAt: values["lease-expires-at"],
    pullRequestNumber:
      values["pull-request"] === null ? null : Number(values["pull-request"]),
    code: values.code,
  };
  if (
    receipt.result === "success" &&
    !UNCLAIMED_ACTIONS.has(receipt.action) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      receipt.claimId ?? "",
    )
  ) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid claim ID.");
  }
  if (!RECEIPT_ACTIONS.includes(receipt.action)) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid action.");
  }
  if (
    (PULL_REQUEST_ACTIONS.has(receipt.action) &&
      (!Number.isSafeInteger(receipt.pullRequestNumber) ||
        receipt.pullRequestNumber < 1)) ||
    (!PULL_REQUEST_ACTIONS.has(receipt.action) &&
      receipt.pullRequestNumber !== null)
  ) {
    fail(
      "STATE_MISMATCH",
      "A lifecycle receipt has an invalid pull request binding.",
    );
  }
  if (!new Set(["success", "failure"]).has(receipt.result)) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid result.");
  }
  if (
    (receipt.result === "success" && receipt.code !== null) ||
    (receipt.result === "failure" && !ERROR_CODES.has(receipt.code))
  ) {
    fail(
      "STATE_MISMATCH",
      "A lifecycle receipt has inconsistent result fields.",
    );
  }
  if (
    !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?|github-actions\[bot\])$/u.test(
      receipt.actor ?? "",
    )
  ) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid actor.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(receipt.agent ?? "")) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid agent class.");
  }
  const states = new Set(
    STATUS_LABELS.map((label) => label.slice(STATUS_PREFIX.length)),
  );
  if (
    (!states.has(receipt.from) &&
      !(receipt.action === "initialize" && receipt.from === "unmanaged")) ||
    !states.has(receipt.to)
  ) {
    fail("STATE_MISMATCH", "A lifecycle receipt has an invalid state.");
  }
  if (
    receipt.leaseExpiresAt !== null &&
    (Number.isNaN(Date.parse(receipt.leaseExpiresAt)) ||
      new Date(receipt.leaseExpiresAt).toISOString() !== receipt.leaseExpiresAt)
  ) {
    fail(
      "STATE_MISMATCH",
      "A lifecycle receipt has an invalid lease timestamp.",
    );
  }
  if (receipt.result === "failure") {
    if (
      receipt.claimId !== null ||
      receipt.from !== receipt.to ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A failure receipt must not claim a transition.");
    }
  } else if (["release", "expire"].includes(receipt.action)) {
    if (
      !["in-progress", "review", "blocked"].includes(receipt.from) ||
      !["ready", "waiting"].includes(receipt.to) ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A release receipt has an invalid transition.");
    }
  } else if (["merge", "close"].includes(receipt.action)) {
    if (
      receipt.from !== "review" ||
      receipt.to !== "done" ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A closure receipt has an invalid transition.");
    }
  } else if (receipt.action === "reopen") {
    if (
      receipt.claimId !== null ||
      receipt.from !== "done" ||
      !["ready", "waiting"].includes(receipt.to) ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A reopen receipt has an invalid transition.");
    }
  } else if (receipt.action === "initialize") {
    if (
      receipt.claimId !== null ||
      receipt.from !== "unmanaged" ||
      !["ready", "waiting"].includes(receipt.to) ||
      receipt.leaseExpiresAt !== null
    ) {
      fail(
        "STATE_MISMATCH",
        "An initialize receipt has an invalid transition.",
      );
    }
  } else if (receipt.action === "refresh") {
    if (
      receipt.claimId !== null ||
      !["ready", "waiting"].includes(receipt.from) ||
      !["ready", "waiting"].includes(receipt.to) ||
      receipt.from === receipt.to ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A refresh receipt has an invalid transition.");
    }
  } else if (receipt.action === "pr-open") {
    if (
      receipt.from !== "in-progress" ||
      receipt.to !== "review" ||
      receipt.leaseExpiresAt !== null
    ) {
      fail("STATE_MISMATCH", "A review admission receipt is invalid.");
    }
  } else {
    const transition = SUCCESS_TRANSITIONS[receipt.action];
    if (
      (receipt.action === "heartbeat"
        ? receipt.from !== "in-progress" || receipt.to !== receipt.from
        : !transition ||
          receipt.from !== transition[0] ||
          receipt.to !== transition[1]) ||
      receipt.leaseExpiresAt === null
    ) {
      fail("STATE_MISMATCH", "A lifecycle receipt has an invalid transition.");
    }
  }
  return receipt;
};

export const parseReceipts = (
  comments,
  { workflowLogin = "github-actions[bot]" } = {},
) => {
  const receipts = [];
  const events = new Map();
  const sortedComments = [...(comments ?? [])].sort(
    (left, right) => Number(left.id) - Number(right.id),
  );
  const claims = new Map();
  for (const comment of sortedComments) {
    if (
      comment.user?.login !== workflowLogin ||
      typeof comment.body !== "string"
    ) {
      continue;
    }
    const parsed = parseReceiptBody(comment.body);
    if (!parsed) continue;
    const identity = receiptIdentity(parsed);
    const prior = events.get(parsed.eventId);
    if (prior && prior !== identity) {
      fail(
        "STATE_MISMATCH",
        "One event ID has conflicting lifecycle receipts.",
      );
    }
    if (prior) continue;
    if (parsed.result === "failure") {
      events.set(parsed.eventId, identity);
      receipts.push({
        ...parsed,
        commentId: comment.id,
        createdAt: comment.created_at,
      });
      continue;
    }
    if (UNCLAIMED_ACTIONS.has(parsed.action)) {
      events.set(parsed.eventId, identity);
      receipts.push({
        ...parsed,
        commentId: comment.id,
        createdAt: comment.created_at,
      });
      continue;
    }
    const claim = claims.get(parsed.claimId);
    if (parsed.action === "claim") {
      if (claim) {
        fail(
          "STATE_MISMATCH",
          "A claim generation has more than one claim receipt.",
        );
      }
      claims.set(parsed.claimId, {
        owner: parsed.actor,
        agent: parsed.agent,
        state: parsed.to,
        leaseExpiresAt: parsed.leaseExpiresAt,
        pullRequestNumber: null,
        released: false,
      });
    } else {
      if (!claim || claim.released || parsed.agent !== claim.agent) {
        fail(
          "STATE_MISMATCH",
          "A receipt does not match an active claim generation.",
        );
      }
      if (parsed.from !== claim.state) {
        fail(
          "STATE_MISMATCH",
          "A receipt state does not follow its claim generation.",
        );
      }
      if (
        parsed.action === "block" &&
        parsed.leaseExpiresAt !== claim.leaseExpiresAt
      ) {
        fail("STATE_MISMATCH", "A block receipt cannot change its lease.");
      }
      if (
        ["heartbeat", "resume"].includes(parsed.action) &&
        claim.leaseExpiresAt !== null &&
        Date.parse(parsed.leaseExpiresAt) <= Date.parse(claim.leaseExpiresAt)
      ) {
        fail(
          "STATE_MISMATCH",
          "A receipt cannot roll an active claim lease backward.",
        );
      }
      if (
        OWNER_BOUND_ACTIONS.has(parsed.action) &&
        parsed.actor !== claim.owner
      ) {
        fail(
          "STATE_MISMATCH",
          "A receipt actor does not match the claim owner.",
        );
      }
      if (parsed.action === "pr-open") {
        if (
          claim.pullRequestNumber !== null &&
          claim.pullRequestNumber !== parsed.pullRequestNumber
        ) {
          fail(
            "STATE_MISMATCH",
            "A claim generation cannot bind more than one pull request.",
          );
        }
        claim.pullRequestNumber = parsed.pullRequestNumber;
      } else if (
        PULL_REQUEST_ACTIONS.has(parsed.action) &&
        claim.pullRequestNumber !== parsed.pullRequestNumber
      ) {
        fail(
          "STATE_MISMATCH",
          "A pull request receipt does not match its claim generation binding.",
        );
      }
      claim.state = parsed.to;
      claim.leaseExpiresAt = parsed.leaseExpiresAt;
      if (RECEIPT_END_ACTIONS.has(parsed.action)) claim.released = true;
    }
    events.set(parsed.eventId, identity);
    receipts.push({
      ...parsed,
      commentId: comment.id,
      createdAt: comment.created_at,
    });
  }
  return receipts;
};
