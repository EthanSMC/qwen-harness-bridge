import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_TRANSITIONS,
  assertIssueInvariant,
  assertReceiptAppendable,
  COMMAND_NAMES,
  closingIssueNumbers,
  evaluateReadiness,
  LifecycleError,
  MANAGED_TYPE_LABELS,
  MAX_DEPENDENCIES,
  parseDependencies,
  parseLifecycleCommand,
  parseReceipts,
  planLifecycleCommand,
  RECEIPT_ACTIONS,
  receiptBody,
  STATUS_LABELS,
  safePublicText,
} from "./ai-issue-policy.mjs";

const NOW = "2026-09-04T12:00:00.000Z";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

const validBody = [
  "Blocked by none",
  "",
  "## Outcome",
  "Deliver a concrete lifecycle result.",
  "",
  "## Verification",
  "Run node --test and record the result.",
  "",
  "## Risk and rollback",
  "Revert the governance commit.",
  "",
  "## Definition of done",
  "- [ ] Required evidence is present.",
].join("\n");

const issue = ({
  number = 46,
  state = "open",
  stateReason = null,
  body = validBody,
  labels = ["type:docs", "status:ready"],
  assignees = [],
} = {}) => ({
  number,
  state,
  state_reason: stateReason,
  body,
  labels: labels.map((name) => ({ name })),
  assignees: assignees.map((login) => ({ login })),
});

const expectCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, code);
    return true;
  });
};

const plan = (overrides = {}) =>
  planLifecycleCommand({
    command: parseLifecycleCommand("/ai-claim\nagent: codex"),
    issue: issue(),
    actor: "alice",
    actorPermission: "write",
    dependencies: [],
    closingPullRequests: [],
    receipts: [],
    now: NOW,
    eventId: 901,
    randomUUID: () => UUID,
    ...overrides,
  });

test("exports exactly the six managed lifecycle labels", () => {
  assert.deepEqual(STATUS_LABELS, [
    "status:waiting",
    "status:ready",
    "status:in-progress",
    "status:review",
    "status:blocked",
    "status:done",
  ]);
  assert.deepEqual(COMMAND_NAMES, [
    "claim",
    "heartbeat",
    "block",
    "resume",
    "release",
  ]);
  assert.deepEqual(ALLOWED_TRANSITIONS.ready, ["in-progress"]);
  assert.deepEqual(MANAGED_TYPE_LABELS, [
    "type:feature",
    "type:bug",
    "type:test",
    "type:docs",
    "type:security",
  ]);
  assert.deepEqual(RECEIPT_ACTIONS, [
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
});

test("parses every lifecycle command with exact fields", () => {
  assert.deepEqual(parseLifecycleCommand("/ai-claim\nagent: codex"), {
    name: "claim",
    fields: { agent: "codex" },
  });
  assert.deepEqual(
    parseLifecycleCommand(
      `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: parser passes; controller remains`,
    ),
    {
      name: "heartbeat",
      fields: {
        "claim-id": UUID,
        summary: "parser passes; controller remains",
      },
    },
  );
  assert.deepEqual(
    parseLifecycleCommand(
      `/ai-block\nclaim-id: ${UUID}\nreason: staging unavailable\nresume-when: staging recovers`,
    ),
    {
      name: "block",
      fields: {
        "claim-id": UUID,
        reason: "staging unavailable",
        "resume-when": "staging recovers",
      },
    },
  );
  assert.deepEqual(parseLifecycleCommand(`/ai-resume\nclaim-id: ${UUID}`), {
    name: "resume",
    fields: { "claim-id": UUID },
  });
  assert.deepEqual(
    parseLifecycleCommand(
      `/ai-release\nclaim-id: ${UUID}\nreason: work is abandoned`,
    ),
    {
      name: "release",
      fields: { "claim-id": UUID, reason: "work is abandoned" },
    },
  );
});

test("requires one canonical claim generation on every post-claim command", () => {
  for (const body of [
    "/ai-heartbeat\nsummary: missing generation",
    "/ai-block\nreason: missing generation\nresume-when: later",
    "/ai-resume",
    "/ai-release\nreason: missing generation",
    "/ai-heartbeat\nclaim-id: 550E8400-E29B-41D4-A716-446655440000\nsummary: uppercase",
    "/ai-heartbeat\nclaim-id: not-a-uuid\nsummary: malformed",
  ]) {
    expectCode(() => parseLifecycleCommand(body), "INVALID_COMMAND");
  }
});

test("rejects malformed, duplicate, unknown, missing, and extra command fields", () => {
  expectCode(() => parseLifecycleCommand("hello"), "INVALID_COMMAND");
  expectCode(
    () => parseLifecycleCommand("/ai-claim\nagent: codex\nagent: other"),
    "INVALID_COMMAND",
  );
  expectCode(
    () => parseLifecycleCommand("/ai-heartbeat\nextra: value"),
    "INVALID_COMMAND",
  );
  expectCode(() => parseLifecycleCommand("/ai-claim"), "INVALID_COMMAND");
  expectCode(
    () => parseLifecycleCommand("/ai-resume\nreason: not allowed"),
    "INVALID_COMMAND",
  );
});

test("rejects unsafe agent classes and private public-field content", () => {
  expectCode(
    () => parseLifecycleCommand("/ai-claim\nagent: Codex Private"),
    "INVALID_COMMAND",
  );
  expectCode(
    () => parseLifecycleCommand(`/ai-claim\nagent: ${"a".repeat(33)}`),
    "INVALID_COMMAND",
  );
  expectCode(
    () =>
      parseLifecycleCommand(
        `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: codex://threads/01private`,
      ),
    "INVALID_COMMAND",
  );
  expectCode(
    () =>
      parseLifecycleCommand(
        `/ai-block\nclaim-id: ${UUID}\nreason: token=secret\nresume-when: rotate it`,
      ),
    "INVALID_COMMAND",
  );
  expectCode(
    () =>
      parseLifecycleCommand(
        `/ai-release\nclaim-id: ${UUID}\nreason: files are in /Users/alice/private`,
      ),
    "INVALID_COMMAND",
  );
  expectCode(
    () =>
      parseLifecycleCommand(
        `/ai-release\nclaim-id: ${UUID}\nreason: inspect http://github.com/org/repo/issues/1`,
      ),
    "INVALID_COMMAND",
  );
  expectCode(() => safePublicText("界".repeat(81), 240), "INVALID_COMMAND");
  assert.equal(safePublicText("safe result", 240), "safe result");
});

test("accepts exactly one canonical dependency declaration", () => {
  assert.deepEqual(parseDependencies("Blocked by none"), []);
  assert.deepEqual(
    parseDependencies("intro\nBlocked by #12, #19\nend"),
    [12, 19],
  );
  expectCode(
    () => parseDependencies("Blocked by #12\nBlocked by #19"),
    "NOT_READY",
  );
  expectCode(() => parseDependencies("Blocked by #12, #12"), "NOT_READY");
  expectCode(
    () =>
      parseDependencies(
        `Blocked by ${Array.from(
          { length: MAX_DEPENDENCIES + 1 },
          (_, index) => `#${index + 1}`,
        ).join(", ")}`,
      ),
    "NOT_READY",
  );
  expectCode(
    () => parseDependencies(`Blocked by #${"9".repeat(600)}`),
    "NOT_READY",
  );
  expectCode(() => parseDependencies("No dependencies"), "NOT_READY");
});

test("recognizes only one standalone closing line outside Markdown code", () => {
  assert.deepEqual(closingIssueNumbers("- Closes #46"), [46]);
  assert.deepEqual(
    closingIssueNumbers("This prose closes #46 eventually."),
    [],
  );
  assert.deepEqual(closingIssueNumbers("Closes #46\nCloses #46"), [46, 46]);
  assert.deepEqual(
    closingIssueNumbers("```text\nCloses #46\n```\n`Closes #47`"),
    [],
  );
});

test("enforces lifecycle label, assignee, and open/closed invariants", () => {
  assert.equal(assertIssueInvariant(issue()).state, "ready");
  assert.equal(
    assertIssueInvariant(
      issue({
        labels: ["type:docs", "status:in-progress"],
        assignees: ["alice"],
      }),
    ).assignee,
    "alice",
  );
  expectCode(
    () =>
      assertIssueInvariant(
        issue({ labels: ["status:waiting", "status:ready"] }),
      ),
    "STATE_MISMATCH",
  );
  expectCode(
    () => assertIssueInvariant(issue({ labels: ["status:in-progress"] })),
    "STATE_MISMATCH",
  );
  expectCode(
    () =>
      assertIssueInvariant(
        issue({ labels: ["status:ready"], assignees: ["alice"] }),
      ),
    "STATE_MISMATCH",
  );
  assert.equal(
    assertIssueInvariant(
      issue({
        state: "closed",
        stateReason: "completed",
        labels: ["type:docs", "status:done"],
      }),
    ).state,
    "done",
  );
  expectCode(
    () =>
      assertIssueInvariant(issue({ state: "open", labels: ["status:done"] })),
    "STATE_MISMATCH",
  );
  expectCode(
    () => assertIssueInvariant(issue({ labels: ["status:ready"] })),
    "STATE_MISMATCH",
  );
  expectCode(
    () =>
      assertIssueInvariant(
        issue({ labels: ["type:docs", "type:test", "status:ready"] }),
      ),
    "STATE_MISMATCH",
  );
});

test("accepts canonical GitHub Issue Form section headings", () => {
  const formBody = validBody.replace(/^## /gmu, "### ");
  assert.equal(
    evaluateReadiness({
      issue: issue({ body: formBody }),
      dependencies: [],
      closingPullRequests: [],
    }).ready,
    true,
  );
});

test("readiness rejects an unmanaged type and a self dependency", () => {
  assert.equal(
    evaluateReadiness({
      issue: issue({ labels: ["status:ready"] }),
      dependencies: [],
      closingPullRequests: [],
    }).code,
    "NOT_READY",
  );
  assert.equal(
    evaluateReadiness({
      issue: issue({
        body: validBody.replace("Blocked by none", "Blocked by #46"),
      }),
      dependencies: [
        { number: 46, state: "closed", state_reason: "completed" },
      ],
      closingPullRequests: [],
    }).code,
    "NOT_READY",
  );
});

test("evaluates complete readiness and rejects incomplete evidence", () => {
  assert.deepEqual(
    evaluateReadiness({
      issue: issue(),
      dependencies: [],
      closingPullRequests: [],
    }),
    { ready: true, code: null, dependencyNumbers: [] },
  );
  assert.equal(
    evaluateReadiness({
      issue: issue({ body: "Blocked by none" }),
      dependencies: [],
      closingPullRequests: [],
    }).code,
    "NOT_READY",
  );
});

test("readiness rejects open, missing, or non-completed dependencies", () => {
  const body = validBody.replace("Blocked by none", "Blocked by #12");
  assert.equal(
    evaluateReadiness({
      issue: issue({ body }),
      dependencies: [{ number: 12, state: "open", state_reason: null }],
      closingPullRequests: [],
    }).code,
    "DEPENDENCY_OPEN",
  );
  assert.equal(
    evaluateReadiness({
      issue: issue({ body }),
      dependencies: [],
      closingPullRequests: [],
    }).code,
    "GITHUB_STATE_UNAVAILABLE",
  );
  assert.equal(
    evaluateReadiness({
      issue: issue({ body }),
      dependencies: [
        { number: 12, state: "closed", state_reason: "not_planned" },
      ],
      closingPullRequests: [],
    }).code,
    "DEPENDENCY_OPEN",
  );
});

test("readiness rejects an existing open closing pull request", () => {
  assert.equal(
    evaluateReadiness({
      issue: issue(),
      dependencies: [],
      closingPullRequests: [{ number: 51, state: "open" }],
    }).code,
    "CLOSING_PR_EXISTS",
  );
});

test("plans an exact 24-hour exclusive claim", () => {
  const result = plan();
  assert.equal(result.from, "ready");
  assert.equal(result.to, "in-progress");
  assert.equal(result.assignee, "alice");
  assert.equal(result.leaseExpiresAt, "2026-09-05T12:00:00.000Z");
  assert.deepEqual(result.receipt, {
    version: 2,
    eventId: 901,
    claimId: UUID,
    action: "claim",
    result: "success",
    actor: "alice",
    agent: "codex",
    from: "ready",
    to: "in-progress",
    leaseExpiresAt: "2026-09-05T12:00:00.000Z",
    pullRequestNumber: null,
    code: null,
  });
});

test("rejects an ineligible or competing claimant", () => {
  expectCode(() => plan({ actorPermission: "read" }), "NOT_ELIGIBLE");
  expectCode(
    () =>
      plan({
        actor: "bob",
        issue: issue({
          labels: ["type:docs", "status:in-progress"],
          assignees: ["alice"],
        }),
      }),
    "ALREADY_CLAIMED",
  );
});

test("rejects a different expected claim generation before planning owner or maintainer actions", () => {
  const claimReceipt = plan().receipt;
  const activeIssue = issue({
    labels: ["type:docs", "status:in-progress"],
    assignees: ["alice"],
  });
  const staleClaimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const { actor, actorPermission, body } of [
    {
      actor: "alice",
      actorPermission: "write",
      body: `/ai-heartbeat\nclaim-id: ${staleClaimId}\nsummary: stale worker`,
    },
    {
      actor: "alice",
      actorPermission: "write",
      body: `/ai-block\nclaim-id: ${staleClaimId}\nreason: stale worker\nresume-when: never`,
    },
    {
      actor: "alice",
      actorPermission: "write",
      body: `/ai-resume\nclaim-id: ${staleClaimId}`,
    },
    {
      actor: "maintainer",
      actorPermission: "maintain",
      body: `/ai-release\nclaim-id: ${staleClaimId}\nreason: stale recovery`,
    },
  ]) {
    expectCode(
      () =>
        plan({
          command: parseLifecycleCommand(body),
          issue: activeIssue,
          actor,
          actorPermission,
          receipts: [claimReceipt],
          eventId: 902,
        }),
      "CLAIM_MISMATCH",
    );
  }
});

test("claim mismatch recovery stops stale executors instead of sharing the current generation", () => {
  const claimReceipt = plan().receipt;
  assert.throws(
    () =>
      plan({
        command: parseLifecycleCommand(
          "/ai-heartbeat\nclaim-id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nsummary: stale worker",
        ),
        issue: issue({
          labels: ["type:docs", "status:in-progress"],
          assignees: ["alice"],
        }),
        receipts: [claimReceipt],
        eventId: 902,
      }),
    (error) => {
      assert.equal(error.code, "CLAIM_MISMATCH");
      assert.match(error.message, /stop.*assigned executor.*handoff/is);
      assert.doesNotMatch(
        error.message,
        /retry with (?:its|the) exact claim-id/i,
      );
      return true;
    },
  );

  const publicReceipt = receiptBody({
    ...claimReceipt,
    eventId: 902,
    result: "failure",
    claimId: null,
    from: "in-progress",
    to: "in-progress",
    leaseExpiresAt: null,
    code: "CLAIM_MISMATCH",
  });
  assert.match(publicReceipt, /stop.*assigned executor.*fresh claim/is);
  assert.doesNotMatch(
    publicReceipt,
    /retry with (?:its|the|that) exact `?claim-id/i,
  );
});

test("round-trips a workflow-authored receipt and ignores other comments", () => {
  const claim = plan().receipt;
  const body = receiptBody(claim);
  assert.match(body, /qhb-ai-lifecycle:v2/);
  assert.deepEqual(
    parseReceipts([
      { id: 10, body: "ordinary", user: { login: "alice" } },
      {
        id: 11,
        body,
        created_at: NOW,
        user: { login: "github-actions[bot]" },
      },
    ]),
    [{ ...claim, commentId: 11, createdAt: NOW }],
  );
});

test("rejects a conflicting duplicate receipt event", () => {
  const first = plan().receipt;
  const second = { ...first, actor: "mallory" };
  expectCode(
    () =>
      parseReceipts([
        {
          id: 11,
          body: receiptBody(first),
          user: { login: "github-actions[bot]" },
        },
        {
          id: 12,
          body: receiptBody(second),
          user: { login: "github-actions[bot]" },
        },
      ]),
    "STATE_MISMATCH",
  );
});

test("prevalidates a candidate receipt against the current durable ledger", () => {
  const claim = plan().receipt;
  const comments = [
    {
      id: 11,
      body: receiptBody(claim),
      user: { login: "github-actions[bot]" },
    },
  ];
  const heartbeat = plan({
    command: parseLifecycleCommand(
      `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: implementation continues`,
    ),
    issue: issue({
      labels: ["type:docs", "status:in-progress"],
      assignees: ["alice"],
    }),
    receipts: [claim],
    eventId: 902,
  }).receipt;

  assert.doesNotThrow(() => assertReceiptAppendable(comments, heartbeat));
  expectCode(
    () =>
      assertReceiptAppendable(comments, {
        ...heartbeat,
        leaseExpiresAt: claim.leaseExpiresAt,
      }),
    "STATE_MISMATCH",
  );
});

test("rejects malformed, unsupported, or inconsistent receipts", () => {
  const claim = plan().receipt;
  const validComment = (body, id = 11) => ({
    id,
    body,
    user: { login: "github-actions[bot]" },
  });
  expectCode(
    () =>
      parseReceipts([
        validComment(receiptBody({ ...claim, claimId: "not-a-uuid" })),
      ]),
    "STATE_MISMATCH",
  );
  expectCode(
    () =>
      parseReceipts([
        validComment(
          receiptBody(claim).replace(
            "lease-expires-at=2026-09-05T12:00:00.000Z",
            "lease-expires-at=tomorrow",
          ),
        ),
      ]),
    "STATE_MISMATCH",
  );
  expectCode(
    () =>
      parseReceipts([
        validComment(
          receiptBody(claim).replace("lifecycle:v2", "lifecycle:v3"),
        ),
      ]),
    "STATE_MISMATCH",
  );

  const heartbeat = plan({
    command: parseLifecycleCommand(
      `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: implementation continues`,
    ),
    issue: issue({
      labels: ["type:docs", "status:in-progress"],
      assignees: ["alice"],
    }),
    receipts: [claim],
    eventId: 902,
  }).receipt;
  expectCode(
    () =>
      parseReceipts([
        validComment(receiptBody(claim), 11),
        validComment(receiptBody({ ...heartbeat, actor: "mallory" }), 12),
      ]),
    "STATE_MISMATCH",
  );
});

test("round-trips a bounded failure receipt without creating a claim", () => {
  const failure = {
    version: 2,
    eventId: 902,
    claimId: null,
    action: "claim",
    result: "failure",
    actor: "bob",
    agent: "codex",
    from: "in-progress",
    to: "in-progress",
    leaseExpiresAt: null,
    pullRequestNumber: null,
    code: "ALREADY_CLAIMED",
  };
  assert.deepEqual(
    parseReceipts([
      {
        id: 12,
        body: receiptBody(failure),
        created_at: NOW,
        user: { login: "github-actions[bot]" },
      },
    ]),
    [{ ...failure, commentId: 12, createdAt: NOW }],
  );
});

test("parses system transitions and retains the active claim generation", () => {
  const claim = plan().receipt;
  const prOpen = {
    ...claim,
    eventId: 902,
    action: "pr-open",
    from: "in-progress",
    to: "review",
    leaseExpiresAt: null,
    pullRequestNumber: 51,
  };
  const prClose = {
    ...claim,
    eventId: 903,
    action: "pr-close",
    from: "review",
    to: "in-progress",
    leaseExpiresAt: "2026-09-06T12:00:00.000Z",
    pullRequestNumber: 51,
  };
  const parsed = parseReceipts(
    [claim, prOpen, prClose].map((receipt, index) => ({
      id: 20 + index,
      body: receiptBody(receipt),
      user: { login: "github-actions[bot]" },
    })),
  );
  const heartbeat = plan({
    command: parseLifecycleCommand(
      `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: resumed after a closed pull request`,
    ),
    issue: issue({
      labels: ["type:docs", "status:in-progress"],
      assignees: ["alice"],
    }),
    receipts: parsed,
    eventId: 904,
    now: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(heartbeat.receipt.claimId, UUID);

  const reopened = {
    version: 2,
    eventId: 905,
    claimId: null,
    action: "reopen",
    result: "success",
    actor: "github-actions[bot]",
    agent: "none",
    from: "done",
    to: "ready",
    leaseExpiresAt: null,
    code: null,
  };
  assert.equal(
    parseReceipts([
      {
        id: 30,
        body: receiptBody(reopened),
        user: { login: "github-actions[bot]" },
      },
    ])[0].action,
    "reopen",
  );

  const initialize = {
    ...reopened,
    eventId: 906,
    action: "initialize",
    from: "unmanaged",
    to: "waiting",
  };
  const refresh = {
    ...reopened,
    eventId: 907,
    action: "refresh",
    from: "waiting",
    to: "ready",
  };
  assert.deepEqual(
    parseReceipts(
      [initialize, refresh].map((receipt, index) => ({
        id: 31 + index,
        body: receiptBody(receipt),
        user: { login: "github-actions[bot]" },
      })),
    ).map(({ action }) => action),
    ["initialize", "refresh"],
  );
});

test("one claim generation cannot bind receipts from two pull requests", () => {
  const claim = plan().receipt;
  const review = {
    ...claim,
    eventId: 902,
    action: "pr-open",
    from: "in-progress",
    to: "review",
    leaseExpiresAt: null,
    pullRequestNumber: 51,
  };
  const returned = {
    ...review,
    eventId: 903,
    action: "pr-close",
    from: "review",
    to: "in-progress",
    leaseExpiresAt: "2026-09-06T12:00:00.000Z",
  };
  const replacement = {
    ...review,
    eventId: 904,
    pullRequestNumber: 52,
  };
  expectCode(
    () =>
      parseReceipts(
        [claim, review, returned, replacement].map((receipt, index) => ({
          id: 40 + index,
          body: receiptBody(receipt),
          user: { login: "github-actions[bot]" },
        })),
      ),
    "STATE_MISMATCH",
  );
});

test("rejects a claim receipt whose state does not follow the prior receipt", () => {
  const claim = plan().receipt;
  const blocked = {
    ...claim,
    eventId: 902,
    action: "block",
    from: "in-progress",
    to: "blocked",
  };
  const staleHeartbeat = {
    ...claim,
    eventId: 903,
    action: "heartbeat",
    from: "in-progress",
    to: "in-progress",
    leaseExpiresAt: "2026-09-06T12:00:00.000Z",
  };
  expectCode(
    () =>
      parseReceipts(
        [claim, blocked, staleHeartbeat].map((receipt, index) => ({
          id: 50 + index,
          body: receiptBody(receipt),
          user: { login: "github-actions[bot]" },
        })),
      ),
    "STATE_MISMATCH",
  );
});

test("rejects a claim receipt that rolls an active lease backward", () => {
  const claim = plan().receipt;
  const renewed = {
    ...claim,
    eventId: 902,
    action: "heartbeat",
    from: "in-progress",
    to: "in-progress",
    leaseExpiresAt: "2026-09-07T12:00:00.000Z",
  };
  const staleHeartbeat = {
    ...renewed,
    eventId: 903,
    leaseExpiresAt: "2026-09-06T12:00:00.000Z",
  };
  expectCode(
    () =>
      parseReceipts(
        [claim, renewed, staleHeartbeat].map((receipt, index) => ({
          id: 60 + index,
          body: receiptBody(receipt),
          user: { login: "github-actions[bot]" },
        })),
      ),
    "STATE_MISMATCH",
  );
});

test("treats an identical event receipt as idempotent", () => {
  const existing = plan().receipt;
  assert.deepEqual(plan({ receipts: [existing] }), {
    idempotent: true,
    receipt: existing,
  });
});

test("renews only the current owner's active claim", () => {
  const claim = plan().receipt;
  const activeIssue = issue({
    labels: ["type:docs", "status:in-progress"],
    assignees: ["alice"],
  });
  const heartbeat = plan({
    command: parseLifecycleCommand(
      `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: policy tests pass; controller remains`,
    ),
    issue: activeIssue,
    receipts: [claim],
    eventId: 902,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(heartbeat.to, "in-progress");
  assert.equal(heartbeat.leaseExpiresAt, "2026-09-06T00:00:00.000Z");
  assert.equal(heartbeat.receipt.claimId, UUID);
  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: unauthorized renewal`,
        ),
        actor: "bob",
        issue: activeIssue,
        receipts: [claim],
        eventId: 903,
      }),
    "NOT_OWNER",
  );
  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: attempted after lease expiry`,
        ),
        issue: activeIssue,
        receipts: [claim],
        eventId: 904,
        now: "2026-09-05T12:00:00.000Z",
      }),
    "LEASE_EXPIRED",
  );
});

test("rejects heartbeats after a claim receives its durable review lock", () => {
  const claim = plan().receipt;
  const review = {
    ...claim,
    eventId: 902,
    action: "pr-open",
    from: "in-progress",
    to: "review",
    leaseExpiresAt: null,
  };
  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: final review is still in progress`,
        ),
        issue: issue({
          labels: ["type:docs", "status:review"],
          assignees: ["alice"],
        }),
        receipts: [claim, review],
        eventId: 903,
        now: "2026-09-05T00:00:00.000Z",
      }),
    "INVALID_TRANSITION",
  );
});

test("plans owner block and resume with the same claim generation", () => {
  const claim = plan().receipt;
  const activeIssue = issue({
    labels: ["type:docs", "status:in-progress"],
    assignees: ["alice"],
  });
  const blocked = plan({
    command: parseLifecycleCommand(
      `/ai-block\nclaim-id: ${UUID}\nreason: staging unavailable\nresume-when: staging recovers`,
    ),
    issue: activeIssue,
    receipts: [claim],
    eventId: 902,
  });
  assert.equal(blocked.to, "blocked");
  const resumed = plan({
    command: parseLifecycleCommand(`/ai-resume\nclaim-id: ${UUID}`),
    issue: issue({
      labels: ["type:docs", "status:blocked"],
      assignees: ["alice"],
    }),
    receipts: [claim, blocked.receipt],
    eventId: 903,
  });
  assert.equal(resumed.to, "in-progress");
  assert.equal(resumed.receipt.claimId, UUID);
  assert.equal(resumed.leaseExpiresAt, "2026-09-05T12:00:01.000Z");
  assert.equal(
    parseReceipts(
      [claim, blocked.receipt, resumed.receipt].map((receipt, index) => ({
        id: 70 + index,
        body: receiptBody(receipt),
        user: { login: "github-actions[bot]" },
      })),
    ).length,
    3,
  );
  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-block\nclaim-id: ${UUID}\nreason: invalid repeat\nresume-when: never`,
        ),
        issue: issue({
          labels: ["type:docs", "status:blocked"],
          assignees: ["alice"],
        }),
        receipts: [claim, blocked.receipt],
        eventId: 904,
      }),
    "INVALID_TRANSITION",
  );
});

test("releases to ready or waiting and refuses an open closing PR", () => {
  const claim = plan().receipt;
  const activeIssue = issue({
    labels: ["type:docs", "status:in-progress"],
    assignees: ["alice"],
  });
  const released = plan({
    command: parseLifecycleCommand(
      `/ai-release\nclaim-id: ${UUID}\nreason: implementation is abandoned`,
    ),
    issue: activeIssue,
    receipts: [claim],
    eventId: 902,
  });
  assert.equal(released.to, "ready");
  assert.equal(released.removeAssignee, "alice");

  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-release\nclaim-id: ${UUID}\nreason: implementation is abandoned`,
        ),
        issue: activeIssue,
        receipts: [claim],
        closingPullRequests: [{ number: 51, state: "open" }],
        eventId: 903,
      }),
    "CLOSING_PR_EXISTS",
  );

  const dependencyBody = validBody.replace("Blocked by none", "Blocked by #12");
  const waiting = plan({
    command: parseLifecycleCommand(
      `/ai-release\nclaim-id: ${UUID}\nreason: dependency reopened`,
    ),
    issue: issue({
      body: dependencyBody,
      labels: ["type:docs", "status:in-progress"],
      assignees: ["alice"],
    }),
    receipts: [claim],
    dependencies: [{ number: 12, state: "open", state_reason: null }],
    eventId: 904,
  });
  assert.equal(waiting.to, "waiting");
});

test("allows a maintainer to release but not heartbeat another owner's claim", () => {
  const claim = plan().receipt;
  const activeIssue = issue({
    labels: ["type:docs", "status:blocked"],
    assignees: ["alice"],
  });
  const released = plan({
    command: parseLifecycleCommand(
      `/ai-release\nclaim-id: ${UUID}\nreason: maintainer recovery`,
    ),
    actor: "maintainer",
    actorPermission: "maintain",
    issue: activeIssue,
    receipts: [claim],
    eventId: 902,
  });
  assert.equal(released.to, "ready");
  expectCode(
    () =>
      plan({
        command: parseLifecycleCommand(
          `/ai-heartbeat\nclaim-id: ${UUID}\nsummary: maintainer cannot impersonate owner`,
        ),
        actor: "maintainer",
        actorPermission: "maintain",
        issue: activeIssue,
        receipts: [claim],
        eventId: 903,
      }),
    "NOT_OWNER",
  );
});
