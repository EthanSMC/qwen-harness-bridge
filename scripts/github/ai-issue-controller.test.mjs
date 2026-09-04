import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchDependencies,
  handleIssueChange,
  handleIssueComment,
  handlePullRequest,
  main,
  reconcileExpiredClaims,
  reconcileLifecycleCommands,
  reconcileRepositoryState,
  runLifecycleController,
  runReconciliationPhases,
  stableSystemEventId,
  validateHistoricalExemptions,
} from "./ai-issue-controller.mjs";
import { currentClaimFromReceipts, parseReceipts } from "./ai-issue-policy.mjs";

const REPOSITORY = "octo/example";
const NOW = "2026-09-04T12:00:00.000Z";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

const issueBody = (dependency = "Blocked by none") =>
  [
    dependency,
    "",
    "## Outcome",
    "Deliver a governed lifecycle.",
    "",
    "## Verification",
    "Run the lifecycle tests.",
    "",
    "## Risk and rollback",
    "Revert the governance change.",
    "",
    "## Definition of done",
    "- [ ] The lifecycle closes cleanly.",
  ].join("\n");

class FakeGitHub {
  constructor() {
    this.issues = new Map([
      [
        46,
        {
          id: 46,
          number: 46,
          state: "open",
          state_reason: null,
          body: issueBody(),
          labels: [{ name: "type:docs" }, { name: "status:ready" }],
          assignees: [],
        },
      ],
    ]);
    this.comments = new Map([[46, []]]);
    this.permissions = new Map([
      ["alice", "write"],
      ["bob", "write"],
      ["maintainer", "maintain"],
    ]);
    this.pulls = new Map();
    this.mutations = [];
    this.nextCommentId = 10_000;
    this.failNextReceiptPost = false;
    this.comparisonStatus = "ahead";

    this.client = {
      get: (path) => this.get(path),
      getAll: (path) => this.getAll(path),
      post: (path, body, options) => this.post(path, body, options),
      patch: (path, body, options) => this.patch(path, body, options),
      delete: (path, options) => this.remove(path, options),
      mutateAndVerify: (input) => this.mutateAndVerify(input),
    };
  }

  clone(value) {
    return structuredClone(value);
  }

  issue(number = 46) {
    return this.clone(this.issues.get(number));
  }

  issueComments(number = 46) {
    return this.clone(this.comments.get(number) ?? []);
  }

  workflowReceipts(number = 46) {
    return parseReceipts(this.issueComments(number));
  }

  command(id, actor, body, number = 46, createdAt = NOW) {
    const comment = {
      id,
      body,
      created_at: createdAt,
      issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${number}`,
      user: { login: actor },
    };
    this.comments.get(number).push(comment);
    return {
      repository: { full_name: REPOSITORY, default_branch: "main" },
      issue: { ...this.issue(number), pull_request: undefined },
      comment: this.clone(comment),
    };
  }

  pull({
    number = 51,
    issueNumber = 46,
    state = "open",
    merged = false,
    user = "alice",
    head = `docs/${issueNumber}-lifecycle`,
    createdAt = NOW,
    updatedAt = createdAt,
  } = {}) {
    const claimReceipt = this.workflowReceipts(issueNumber)
      .filter(
        ({ action, result }) => action === "claim" && result === "success",
      )
      .at(-1);
    const pull = {
      id: number,
      number,
      state,
      draft: false,
      merged,
      created_at: createdAt,
      merged_at: merged ? NOW : null,
      merge_commit_sha: merged ? "abc1234" : null,
      body: [
        "## Tracking",
        `- Primary Issue: #${issueNumber}`,
        `- Claim receipt: https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${claimReceipt?.commentId ?? 1}`,
        "",
        `Closes #${issueNumber}`,
      ].join("\n"),
      user: { login: user },
      updated_at: updatedAt,
      base: {
        ref: "main",
        sha: "base123",
        repo: { full_name: REPOSITORY },
      },
      head: {
        ref: head,
        sha: "head123",
        repo: { full_name: REPOSITORY },
      },
    };
    this.pulls.set(number, pull);
    return this.clone(pull);
  }

  pullEvent(pull, action = undefined) {
    return {
      repository: { full_name: REPOSITORY, default_branch: "main" },
      pull_request: this.clone(pull),
      ...(action ? { action } : {}),
    };
  }

  issueEvent(number = 46) {
    return {
      repository: { full_name: REPOSITORY, default_branch: "main" },
      issue: this.issue(number),
    };
  }

  async get(path) {
    if (path.startsWith("/issues/comments?")) {
      const page = Number(
        new URL(`https://api.github.test${path}`).searchParams.get("page"),
      );
      if (page !== 1) return [];
      return [...this.comments.values()].flatMap((comments) =>
        comments.map((comment) => this.clone(comment)),
      );
    }
    let match = /^\/issues\/(\d+)$/u.exec(path);
    if (match) return this.issue(Number(match[1]));
    match = /^\/issues\/comments\/(\d+)$/u.exec(path);
    if (match) {
      const id = Number(match[1]);
      for (const comments of this.comments.values()) {
        const comment = comments.find((candidate) => candidate.id === id);
        if (comment) return this.clone(comment);
      }
      throw new Error(`missing comment ${id}`);
    }
    match = /^\/collaborators\/([^/]+)\/permission$/u.exec(path);
    if (match) {
      const login = decodeURIComponent(match[1]);
      return { permission: this.permissions.get(login) ?? "read" };
    }
    match = /^\/pulls\/(\d+)$/u.exec(path);
    if (match) return this.clone(this.pulls.get(Number(match[1])));
    match = /^\/commits\/([^/]+)$/u.exec(path);
    if (match) return { sha: match[1] };
    match = /^\/compare\/([^/]+)\.\.\.main$/u.exec(path);
    if (match) return { status: this.comparisonStatus };
    throw new Error(`unexpected GET ${path}`);
  }

  async getAll(path) {
    let match = /^\/issues\/(\d+)\/comments$/u.exec(path);
    if (match) return this.issueComments(Number(match[1]));
    if (path === "/pulls?state=open") {
      return [...this.pulls.values()]
        .filter((pull) => pull.state === "open")
        .map((pull) => this.clone(pull));
    }
    if (path === "/issues?state=all&sort=updated&direction=asc") {
      return [...this.issues.values()].map((issue) => this.clone(issue));
    }
    if (path === "/pulls?state=all&sort=updated&direction=asc") {
      return [...this.pulls.values()].map((pull) => this.clone(pull));
    }
    if (path.startsWith("/issues/comments?")) {
      return [...this.comments.values()].flatMap((comments) =>
        comments.map((comment) => this.clone(comment)),
      );
    }
    match = /^\/issues\/(\d+)\/timeline$/u.exec(path);
    if (match) {
      const issueNumber = Number(match[1]);
      return [...this.pulls.values()]
        .filter((pull) => pull.body.includes(`#${issueNumber}`))
        .map((pull) => ({
          event: "cross-referenced",
          source: {
            issue: {
              number: pull.number,
              body: pull.body,
              state: pull.state,
              pull_request: { url: `/pulls/${pull.number}` },
            },
          },
        }));
    }
    if (path.startsWith("/issues?state=open&labels=status%3Ain-progress")) {
      return [...this.issues.values()]
        .filter(
          (candidate) =>
            candidate.state === "open" &&
            candidate.labels.some(({ name }) => name === "status:in-progress"),
        )
        .map((candidate) => this.clone(candidate));
    }
    throw new Error(`unexpected GET ALL ${path}`);
  }

  async patch(path, body) {
    const match = /^\/issues\/(\d+)$/u.exec(path);
    if (!match) throw new Error(`unexpected PATCH ${path}`);
    const number = Number(match[1]);
    const current = this.issues.get(number);
    if (body.labels) current.labels = body.labels.map((name) => ({ name }));
    if (body.assignees) {
      current.assignees = body.assignees.map((login) => ({ login }));
    }
    if (body.state) current.state = body.state;
    if (Object.hasOwn(body, "state_reason"))
      current.state_reason = body.state_reason;
    this.mutations.push({ method: "PATCH", path, body: this.clone(body) });
    return this.issue(number);
  }

  async post(path, body) {
    const match = /^\/issues\/(\d+)\/comments$/u.exec(path);
    if (!match) throw new Error(`unexpected POST ${path}`);
    if (
      this.failNextReceiptPost &&
      body.body.includes("<!-- qhb-ai-lifecycle:v2")
    ) {
      this.failNextReceiptPost = false;
      throw new Error("simulated receipt write interruption");
    }
    const number = Number(match[1]);
    const comment = {
      id: this.nextCommentId,
      body: body.body,
      created_at: NOW,
      user: { login: "github-actions[bot]" },
    };
    this.nextCommentId += 1;
    this.comments.get(number).push(comment);
    this.mutations.push({ method: "POST", path, body: this.clone(body) });
    return this.clone(comment);
  }

  async remove(path) {
    this.mutations.push({ method: "DELETE", path });
    return null;
  }

  async mutateAndVerify({ mutation, read, verify }) {
    const method = mutation.method.toLowerCase();
    const result = await this.client[method](
      mutation.path,
      mutation.body,
      mutation.idempotencyKey
        ? { idempotencyKey: mutation.idempotencyKey }
        : undefined,
    );
    const value = await read();
    if (!(await verify(value))) throw new Error("fake postcondition failed");
    return {
      verified: true,
      value,
      mutationResult: result,
      reconciled: false,
      retried: false,
    };
  }
}

const context = (fake, event, overrides = {}) => ({
  github: fake.client,
  event,
  repository: REPOSITORY,
  mode: "enforce",
  now: NOW,
  eventId: event.comment?.id ?? 900,
  randomUUID: () => UUID,
  ...overrides,
});

const claim = async (fake, id = 901) =>
  handleIssueComment(
    context(fake, fake.command(id, "alice", "/ai-claim\nagent: codex")),
  );

test("dependency hydration uses a bounded worker pool", async () => {
  let active = 0;
  let maximum = 0;
  const github = {
    get: async (path) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      active -= 1;
      return { number: Number(path.split("/").at(-1)) };
    },
  };
  const values = await fetchDependencies(
    github,
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(values.length, 20);
  assert.equal(maximum, 4);
});

test("a later run drains earlier commands in immutable comment order", async () => {
  const fake = new FakeGitHub();
  fake.command(901, "alice", "/ai-claim\nagent: codex");
  fake.command(902, "bob", "/ai-claim\nagent: codex");
  const drained = await reconcileLifecycleCommands({
    github: fake.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
    issueNumber: 46,
  });
  assert.equal(drained.processed, 2);
  assert.deepEqual(
    fake.workflowReceipts().map(({ eventId, result }) => ({ eventId, result })),
    [
      { eventId: 901, result: "success" },
      { eventId: 902, result: "failure" },
    ],
  );
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
});

test("a bounded command drain processes the oldest batch instead of wedging", async () => {
  const fake = new FakeGitHub();
  fake.command(901, "alice", "/ai-claim\nagent: codex");
  fake.command(
    902,
    "alice",
    "/ai-heartbeat\nsummary: implementation continues",
    46,
    "2026-09-04T13:00:00.000Z",
  );
  const first = await reconcileLifecycleCommands({
    github: fake.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
    issueNumber: 46,
    maxCommands: 1,
  });
  assert.equal(first.processed, 1);
  assert.deepEqual(
    fake.workflowReceipts().map(({ eventId }) => eventId),
    [901],
  );
  const second = await reconcileLifecycleCommands({
    github: fake.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
    issueNumber: 46,
    maxCommands: 1,
  });
  assert.equal(second.processed, 1);
  assert.deepEqual(
    fake.workflowReceipts().map(({ eventId }) => eventId),
    [901, 902],
  );
});

test("repository drain excludes pull-request comments before backlog accounting", async () => {
  const fake = new FakeGitHub();
  fake.issues.set(51, {
    id: 51,
    number: 51,
    state: "open",
    body: "pull request",
    labels: [],
    assignees: [],
    pull_request: {
      url: `https://api.github.com/repos/${REPOSITORY}/pulls/51`,
    },
  });
  fake.comments.set(51, []);
  fake.command(900, "bob", "/ai-claim\nagent: codex", 51);
  fake.command(901, "alice", "/ai-claim\nagent: codex");
  const result = await reconcileLifecycleCommands({
    github: fake.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
    maxCommands: 1,
  });
  assert.equal(result.processed, 1);
  assert.deepEqual(
    fake.workflowReceipts().map(({ eventId }) => eventId),
    [901],
  );
});

test("system event IDs are deterministic, namespaced, and distinct", () => {
  const first = stableSystemEventId("issues", 46, "updated-1", "edited");
  assert.equal(first, stableSystemEventId("issues", 46, "updated-1", "edited"));
  assert.notEqual(
    first,
    stableSystemEventId("issues", 46, "updated-2", "edited"),
  );
  assert.ok(Number.isSafeInteger(first));
  assert.ok(first > 8_000_000_000_000_000);
});

test("scheduled live-state reconciliation recovers a dropped PR event", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  fake.pull();
  const result = await reconcileRepositoryState({
    github: fake.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
  });
  assert.equal(result.processed, 2);
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:review"));
  assert.equal(fake.workflowReceipts().at(-1).action, "pr-open");
});

test("repository reconciliation isolates pre-lifecycle closed history", async () => {
  const closedAt = "2026-09-03T12:00:00.000Z";
  const exemptions = new Map([
    [
      46,
      {
        closedAt,
        lifecycleStatus: null,
        reason: "Closed before lifecycle enrollment",
      },
    ],
  ]);
  const historical = new FakeGitHub();
  const historicalIssue = historical.issues.get(46);
  historicalIssue.state = "closed";
  historicalIssue.state_reason = "completed";
  historicalIssue.closed_at = closedAt;
  historicalIssue.labels = [{ name: "type:docs" }];
  historicalIssue.assignees = [{ login: "legacy-owner" }];

  const result = await reconcileRepositoryState({
    github: historical.client,
    repository: REPOSITORY,
    defaultBranch: "main",
    mode: "enforce",
    now: NOW,
    historicalIssueExemptions: exemptions,
  });
  assert.deepEqual(result, {
    status: "enforce",
    processed: 0,
    historicalSkipped: [46],
    results: [],
  });
  assert.deepEqual(historical.mutations, []);
  await assert.rejects(
    () =>
      reconcileRepositoryState({
        github: historical.client,
        repository: REPOSITORY,
        defaultBranch: "main",
        mode: "enforce",
        now: NOW,
        maxObjects: 0,
        historicalIssueExemptions: exemptions,
      }),
    /reconciliation exceeds the 0-object cap/i,
  );

  const labeledHistorical = new FakeGitHub();
  const labeledHistoricalIssue = labeledHistorical.issues.get(46);
  labeledHistoricalIssue.state = "closed";
  labeledHistoricalIssue.state_reason = "completed";
  labeledHistoricalIssue.closed_at = closedAt;
  labeledHistoricalIssue.labels = [
    { name: "type:docs" },
    { name: "status:done" },
  ];
  assert.deepEqual(
    await reconcileRepositoryState({
      github: labeledHistorical.client,
      repository: REPOSITORY,
      defaultBranch: "main",
      mode: "enforce",
      now: NOW,
      historicalIssueExemptions: new Map([
        [
          46,
          {
            closedAt,
            lifecycleStatus: "done",
            reason: "Completed before lifecycle activation",
          },
        ],
      ]),
    }),
    {
      status: "enforce",
      processed: 0,
      historicalSkipped: [46],
      results: [],
    },
  );

  for (const { configure, exemptions: scenarioExemptions, message } of [
    {
      configure: (issue) => {
        issue.labels = [{ name: "type:docs" }, { name: "status:ready" }];
      },
      message: /Only claimed review work can reconcile to done/i,
    },
    {
      configure: (issue) => {
        issue.labels = [{ name: "type:docs" }, { name: "type:bug" }];
      },
      message: /exactly one managed type label/i,
    },
    {
      configure: (issue) => {
        issue.labels = [{ name: "area:operations" }];
      },
      message: /exactly one managed type label/i,
    },
    {
      configure: (issue) => {
        issue.labels = [{ name: "type:docs" }, { name: "status:done" }];
        issue.assignees = [];
      },
      message: /final terminal receipt/i,
    },
    {
      configure: (issue) => {
        issue.closed_at = "2026-09-03T12:00:01.000Z";
      },
      message: /exactly one managed lifecycle label/i,
    },
    {
      configure: (issue) => {
        issue.state_reason = "not_planned";
      },
      message: /exactly one managed lifecycle label/i,
    },
    {
      configure: () => {},
      exemptions: new Map(),
      message: /exactly one managed lifecycle label/i,
    },
  ]) {
    const malformedManaged = new FakeGitHub();
    const malformedIssue = malformedManaged.issues.get(46);
    malformedIssue.state = "closed";
    malformedIssue.state_reason = "completed";
    malformedIssue.closed_at = closedAt;
    malformedIssue.labels = [{ name: "type:docs" }];
    configure(malformedIssue);
    await assert.rejects(
      () =>
        reconcileRepositoryState({
          github: malformedManaged.client,
          repository: REPOSITORY,
          defaultBranch: "main",
          mode: "enforce",
          now: NOW,
          historicalIssueExemptions: scenarioExemptions ?? exemptions,
        }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((failure) => message.test(failure.message)),
    );
  }

  const receiptBearing = new FakeGitHub();
  await claim(receiptBearing);
  const receiptBearingIssue = receiptBearing.issues.get(46);
  receiptBearingIssue.state = "closed";
  receiptBearingIssue.state_reason = "completed";
  receiptBearingIssue.closed_at = closedAt;
  receiptBearingIssue.labels = [{ name: "type:docs" }];
  await assert.rejects(
    () =>
      reconcileRepositoryState({
        github: receiptBearing.client,
        repository: REPOSITORY,
        defaultBranch: "main",
        mode: "enforce",
        now: NOW,
        historicalIssueExemptions: exemptions,
      }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) =>
        /exactly one managed lifecycle label/i.test(failure.message),
      ),
  );

  const missingHistorical = new FakeGitHub();
  missingHistorical.issues.delete(46);
  await assert.rejects(
    () =>
      reconcileRepositoryState({
        github: missingHistorical.client,
        repository: REPOSITORY,
        defaultBranch: "main",
        mode: "enforce",
        now: NOW,
        historicalIssueExemptions: exemptions,
      }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) =>
        /exemption Issue #46 is missing/i.test(failure.message),
      ),
  );
});

test("historical exemption registry is bounded and activation-bound", () => {
  const activationCommit = "a".repeat(40);
  const valid = {
    schema_version: 1,
    activation_commit: activationCommit,
    entries: [
      {
        issue: 46,
        closed_at: "2026-09-03T12:00:00.000Z",
        lifecycle_status: null,
        reason: "Closed before lifecycle enrollment",
      },
    ],
  };
  assert.deepEqual(
    validateHistoricalExemptions(valid, { activationCommit }),
    new Map([
      [
        46,
        {
          closedAt: "2026-09-03T12:00:00.000Z",
          lifecycleStatus: null,
          reason: "Closed before lifecycle enrollment",
        },
      ],
    ]),
  );
  for (const { mutate, message } of [
    {
      mutate: (registry) => {
        registry.activation_commit = "b".repeat(40);
      },
      message: /match.*activation commit/i,
    },
    {
      mutate: (registry) => {
        registry.entries.push(structuredClone(registry.entries[0]));
      },
      message: /Issues must be unique/i,
    },
    {
      mutate: (registry) => {
        registry.entries[0].closed_at = "not-a-timestamp";
      },
      message: /timestamp/i,
    },
    {
      mutate: (registry) => {
        registry.entries[0].unexpected = true;
      },
      message: /unknown or missing fields/i,
    },
    {
      mutate: (registry) => {
        registry.entries[0].issue = "46";
      },
      message: /positive safe integer/i,
    },
    {
      mutate: (registry) => {
        registry.entries[0].lifecycle_status = "ready";
      },
      message: /lifecycle status must be null or done/i,
    },
  ]) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.throws(
      () => validateHistoricalExemptions(malformed, { activationCommit }),
      message,
    );
  }
});

test("reconciliation phases continue after an earlier phase fails", async () => {
  const calls = [];
  await assert.rejects(
    runReconciliationPhases([
      {
        name: "repositoryState",
        run: async () => {
          calls.push("repositoryState");
          throw new Error("malformed Issue");
        },
      },
      {
        name: "commandDrain",
        run: async () => {
          calls.push("commandDrain");
          return { processed: 1 };
        },
      },
      {
        name: "lifecycle",
        run: async () => {
          calls.push("lifecycle");
          return { released: [46] };
        },
      },
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, /^repositoryState:/u);
      return true;
    },
  );
  assert.deepEqual(calls, ["repositoryState", "commandDrain", "lifecycle"]);
});

test("two serialized claim events produce one accountable owner", async () => {
  const fake = new FakeGitHub();
  const first = await claim(fake, 901);
  const second = await handleIssueComment(
    context(fake, fake.command(902, "bob", "/ai-claim\nagent: codex")),
  );

  assert.equal(first.status, "applied");
  assert.equal(second.status, "rejected");
  assert.equal(second.code, "ALREADY_CLAIMED");
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
  assert.deepEqual(
    fake.issue().labels.filter(({ name }) => name.startsWith("status:")),
    [{ name: "status:in-progress" }],
  );
  const receipts = fake.workflowReceipts();
  assert.equal(receipts.filter(({ result }) => result === "success").length, 1);
  assert.equal(receipts.filter(({ result }) => result === "failure").length, 1);
});

test("claim leases use the verified comment timestamp, not runner time", async () => {
  const fake = new FakeGitHub();
  const result = await handleIssueComment(
    context(fake, fake.command(901, "alice", "/ai-claim\nagent: codex"), {
      now: "2099-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(result.plan.leaseExpiresAt, "2026-09-05T12:00:00.000Z");
});

test("untyped Issue commands receive a durable rejection marker", async () => {
  const fake = new FakeGitHub();
  fake.issues.get(46).labels = [];
  const result = await handleIssueComment(
    context(fake, fake.command(901, "alice", "/ai-claim\nagent: codex")),
  );
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "NOT_ELIGIBLE");
  assert.match(
    fake.issueComments().at(-1).body,
    /qhb-ai-command-rejection:v1[\s\S]*event-id=901[\s\S]*code=NOT_ELIGIBLE/u,
  );
});

test("report mode computes a claim without any GitHub mutation", async () => {
  const fake = new FakeGitHub();
  const event = fake.command(901, "alice", "/ai-claim\nagent: codex");
  const result = await handleIssueComment(
    context(fake, event, { mode: "report" }),
  );
  assert.equal(result.status, "report");
  assert.equal(result.plan.to, "in-progress");
  assert.deepEqual(fake.mutations, []);
  assert.deepEqual(fake.issue().assignees, []);
});

test("unknown lifecycle commands receive bounded public guidance", async () => {
  const fake = new FakeGitHub();
  const result = await handleIssueComment(
    context(fake, fake.command(901, "alice", "/ai-dance\nsecret: ignored")),
  );
  assert.deepEqual(result, { status: "rejected", code: "INVALID_COMMAND" });
  const botComments = fake
    .issueComments()
    .filter(({ user }) => user.login === "github-actions[bot]");
  assert.equal(botComments.length, 1);
  assert.match(botComments[0].body, /INVALID_COMMAND/);
  assert.doesNotMatch(botComments[0].body, /secret: ignored/);
});

test("recovers the original claim generation after mutation-before-receipt interruption", async () => {
  const fake = new FakeGitHub();
  const event = fake.command(901, "alice", "/ai-claim\nagent: codex");
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () => handleIssueComment(context(fake, event)),
    /receipt write interruption/i,
  );
  assert.ok(
    fake.issue().labels.some(({ name }) => name === "status:in-progress"),
  );
  assert.equal(fake.workflowReceipts().length, 0);

  const recovered = await handleIssueComment(
    context(fake, event, {
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  );
  assert.equal(recovered.recovered, true);
  assert.equal(fake.workflowReceipts()[0].claimId, UUID);
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
});

test("recovery tolerates identical duplicate intent comments", async () => {
  const fake = new FakeGitHub();
  const event = fake.command(901, "alice", "/ai-claim\nagent: codex");
  fake.failNextReceiptPost = true;
  await assert.rejects(() => handleIssueComment(context(fake, event)));
  const intent = fake
    .issueComments()
    .find(({ body }) => body.includes("<!-- qhb-ai-intent:v2"));
  fake.comments.get(46).push({
    ...intent,
    id: fake.nextCommentId,
  });
  fake.nextCommentId += 1;
  const recovered = await handleIssueComment(context(fake, event));
  assert.equal(recovered.recovered, true);
  assert.equal(fake.workflowReceipts()[0].claimId, UUID);
});

test("owner blocks, resumes, and releases while maintainer recovery is allowed", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  await handleIssueComment(
    context(
      fake,
      fake.command(
        902,
        "alice",
        "/ai-block\nreason: staging unavailable\nresume-when: staging recovers",
      ),
    ),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:blocked"));
  await handleIssueComment(
    context(
      fake,
      fake.command(903, "alice", "/ai-resume", 46, "2026-09-04T13:00:00.000Z"),
      {
        now: "2026-09-04T13:00:00.000Z",
      },
    ),
  );
  assert.ok(
    fake.issue().labels.some(({ name }) => name === "status:in-progress"),
  );
  await handleIssueComment(
    context(
      fake,
      fake.command(
        904,
        "maintainer",
        "/ai-release\nreason: maintainer recovery",
      ),
    ),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.deepEqual(fake.issue().assignees, []);
});

test("same-second renewals advance the lease before durable receipt writes", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const sameSecond = "2026-09-04T13:00:00.000Z";
  const run = (id, body) =>
    handleIssueComment(
      context(fake, fake.command(id, "alice", body, 46, sameSecond), {
        now: sameSecond,
      }),
    );

  await run(902, "/ai-heartbeat\nsummary: first same-second renewal");
  assert.equal(
    currentClaimFromReceipts(fake.workflowReceipts()).leaseExpiresAt,
    "2026-09-05T13:00:00.000Z",
  );
  await run(903, "/ai-heartbeat\nsummary: second same-second renewal");
  assert.equal(
    currentClaimFromReceipts(fake.workflowReceipts()).leaseExpiresAt,
    "2026-09-05T13:00:01.000Z",
  );
  await run(
    904,
    "/ai-block\nreason: same-second dependency\nresume-when: dependency clears",
  );
  assert.equal(
    currentClaimFromReceipts(fake.workflowReceipts()).leaseExpiresAt,
    "2026-09-05T13:00:01.000Z",
  );
  await run(905, "/ai-resume");
  assert.equal(
    currentClaimFromReceipts(fake.workflowReceipts()).leaseExpiresAt,
    "2026-09-05T13:00:02.000Z",
  );
});

test("release is rejected while an open closing pull request exists", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  fake.pull();
  const result = await handleIssueComment(
    context(
      fake,
      fake.command(
        902,
        "alice",
        "/ai-release\nreason: abandoning implementation",
      ),
    ),
  );
  assert.equal(result.code, "CLOSING_PR_EXISTS");
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
});

test("scheduled reconciliation releases an exactly expired claim", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const result = await reconcileExpiredClaims(
    context(fake, {}, { now: "2026-09-05T12:00:00.000Z", eventId: 990 }),
  );
  assert.deepEqual(result, { status: "applied", released: [46] });
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.equal(fake.workflowReceipts().at(-1).action, "expire");
});

test("expired-claim reconciliation continues after a malformed Issue", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const valid = fake.issues.get(46);
  fake.issues = new Map([
    [
      45,
      {
        id: 45,
        number: 45,
        state: "open",
        state_reason: null,
        body: issueBody(),
        labels: [{ name: "type:docs" }, { name: "status:in-progress" }],
        assignees: [{ login: "bob" }],
      },
    ],
    [46, valid],
  ]);
  fake.comments.set(45, []);
  await assert.rejects(
    reconcileExpiredClaims(
      context(fake, {}, { now: "2026-09-05T12:00:00.000Z", eventId: 990 }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      return true;
    },
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.equal(fake.workflowReceipts().at(-1).action, "expire");
});

test("expired work returns to waiting when a declared dependency reopens", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  fake.issues.get(46).body = issueBody("Blocked by #12");
  fake.issues.set(12, {
    id: 12,
    number: 12,
    state: "open",
    state_reason: null,
    body: issueBody(),
    labels: [{ name: "status:ready" }],
    assignees: [],
  });
  const result = await reconcileExpiredClaims(
    context(fake, {}, { now: "2026-09-05T12:00:00.000Z", eventId: 990 }),
  );
  assert.deepEqual(result.released, [46]);
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:waiting"));

  const replay = await reconcileExpiredClaims(
    context(fake, {}, { now: "2026-09-05T13:00:00.000Z", eventId: 990 }),
  );
  assert.deepEqual(replay.released, []);
  assert.equal(
    fake.workflowReceipts().filter(({ action }) => action === "expire").length,
    1,
  );
});

test("release and fresh claim implement an explicit handoff generation", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  await handleIssueComment(
    context(
      fake,
      fake.command(902, "alice", "/ai-release\nreason: handoff requested"),
    ),
  );
  const nextClaimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await handleIssueComment(
    context(fake, fake.command(903, "bob", "/ai-claim\nagent: codex"), {
      randomUUID: () => nextClaimId,
    }),
  );
  assert.deepEqual(fake.issue().assignees, [{ login: "bob" }]);
  const claims = fake
    .workflowReceipts()
    .filter(({ action, result }) => action === "claim" && result === "success");
  assert.deepEqual(
    claims.map(({ claimId }) => claimId),
    [UUID, nextClaimId],
  );
});

test("scheduled reconciliation leaves blocked and review Issues untouched", async () => {
  for (const lifecycle of ["blocked", "review"]) {
    const fake = new FakeGitHub();
    await claim(fake);
    const current = fake.issues.get(46);
    current.labels = [{ name: `status:${lifecycle}` }];
    const result = await reconcileExpiredClaims(
      context(fake, {}, { now: "2026-09-06T12:00:00.000Z", eventId: 990 }),
    );
    assert.deepEqual(result.released, []);
    assert.ok(
      current.labels.some(({ name }) => name === `status:${lifecycle}`),
    );
  }
});

test("pull request open and closed-unmerged move review back to active work", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:review"));
  assert.equal(fake.workflowReceipts().at(-1).leaseExpiresAt, null);

  const closed = fake.pulls.get(51);
  closed.state = "closed";
  await handlePullRequest(
    context(fake, fake.pullEvent(closed), {
      eventId: 911,
      now: "2026-09-04T14:00:00.000Z",
    }),
  );
  assert.ok(
    fake.issue().labels.some(({ name }) => name === "status:in-progress"),
  );
  assert.equal(fake.workflowReceipts().at(-1).action, "pr-close");
});

test("review admission rejects an implementation claim at its expiry boundary", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull({ createdAt: "2026-09-05T12:00:00.000Z" });
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(pull), {
          eventId: 910,
          now: "2026-09-05T12:00:00.000Z",
        }),
      ),
    /lease.*expired|expired.*lease/i,
  );
});

test("review admission rejects a qualifying edit after lease expiry", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull({
    createdAt: "2026-09-04T13:00:00.000Z",
    updatedAt: "2026-09-05T13:00:00.000Z",
  });
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(pull, "edited"), {
          eventId: 910,
          now: "2026-09-05T13:00:00.000Z",
        }),
      ),
    /lease.*expired|expired.*lease/i,
  );
});

test("review admission rejects reopening after the renewed lease expires", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull({ createdAt: "2026-09-04T13:00:00.000Z" });
  await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), { eventId: 910 }),
  );
  const closed = fake.pulls.get(51);
  closed.state = "closed";
  closed.updated_at = "2026-09-04T14:00:00.000Z";
  await handlePullRequest(
    context(fake, fake.pullEvent(closed, "closed"), {
      eventId: 911,
      now: "2026-09-04T14:00:00.000Z",
    }),
  );
  closed.state = "open";
  closed.updated_at = "2026-09-05T14:00:00.000Z";
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(closed, "reopened"), {
          eventId: 912,
          now: "2026-09-05T14:00:00.000Z",
        }),
      ),
    /lease.*expired|expired.*lease/i,
  );
});

test("a delayed qualifying opened event retains its immutable admission time", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull({
    createdAt: "2026-09-04T13:00:00.000Z",
    updatedAt: "2026-09-04T13:00:00.000Z",
  });
  const result = await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), {
      eventId: 910,
      now: "2026-09-06T12:00:00.000Z",
    }),
  );
  assert.equal(result.status, "applied");
  assert.equal(fake.workflowReceipts().at(-1).action, "pr-open");
});

test("manual review state without a review-admission receipt fails closed", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  fake.issues.get(46).labels = [
    { name: "type:docs" },
    { name: "status:review" },
  ];
  const pull = fake.pull();
  await assert.rejects(
    () =>
      handlePullRequest(context(fake, fake.pullEvent(pull), { eventId: 910 })),
    /review admission/i,
  );

  const repair = await handleIssueChange(
    context(fake, fake.issueEvent(), { eventId: 911 }),
  );
  assert.deepEqual(repair, {
    status: "repair-required",
    code: "STATE_MISMATCH",
  });
});

test("recovers the exact pull request binding after a review receipt interruption", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pullRequest = fake.pull();
  const event = fake.pullEvent(pullRequest);
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () => handlePullRequest(context(fake, event, { eventId: 910 })),
    /receipt write interruption/i,
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:review"));

  const recovered = await handlePullRequest(
    context(fake, event, { eventId: 910 }),
  );
  assert.equal(recovered.recovered, true);
  const reviewReceipt = fake
    .workflowReceipts()
    .find(({ eventId }) => eventId === 910);
  assert.equal(reviewReceipt.action, "pr-open");
  assert.equal(reviewReceipt.pullRequestNumber, 51);
});

test("scheduled reconciliation recovers interrupted pull request system receipts", async () => {
  for (const action of ["pr-open", "pr-close", "merge"]) {
    const fake = new FakeGitHub();
    await claim(fake);
    const pull = fake.pull();
    if (action !== "pr-open") {
      await handlePullRequest(
        context(fake, fake.pullEvent(pull, "opened"), { eventId: 910 }),
      );
    }
    const livePull = fake.pulls.get(51);
    if (action === "pr-close") {
      livePull.state = "closed";
      livePull.updated_at = "2026-09-04T14:00:00.000Z";
    } else if (action === "merge") {
      livePull.state = "closed";
      livePull.merged = true;
      livePull.merged_at = "2026-09-04T14:00:00.000Z";
      livePull.updated_at = "2026-09-04T14:00:00.000Z";
      livePull.merge_commit_sha = "abc1234";
      const issue = fake.issues.get(46);
      issue.state = "closed";
      issue.state_reason = "completed";
      issue.closed_at = "2026-09-04T14:00:00.000Z";
    }
    fake.failNextReceiptPost = true;
    await assert.rejects(
      () =>
        handlePullRequest(
          context(fake, fake.pullEvent(livePull, action), {
            eventId: 920,
            now: "2026-09-04T14:00:00.000Z",
          }),
        ),
      /receipt write interruption/i,
    );

    await reconcileRepositoryState(
      context(
        fake,
        {},
        {
          defaultBranch: "main",
          now: "2026-09-04T15:00:00.000Z",
        },
      ),
    );
    assert.equal(
      fake.workflowReceipts().filter((receipt) => receipt.action === action)
        .length,
      1,
      `${action} receipt should recover on the scheduled entry point`,
    );
  }
});

test("cross-run recovery fails closed when two pending intents match", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(pull, "opened"), { eventId: 920 }),
      ),
    /receipt write interruption/i,
  );
  const original = fake
    .issueComments()
    .find(
      ({ body }) =>
        body.includes("<!-- qhb-ai-intent:v2") &&
        body.includes("action=pr-open"),
    );
  fake.comments.get(46).push({
    ...original,
    id: fake.nextCommentId,
    body: original.body.replace("event-id=920", "event-id=921"),
  });
  fake.nextCommentId += 1;
  await assert.rejects(
    () =>
      reconcileRepositoryState(context(fake, {}, { defaultBranch: "main" })),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) =>
        /more than one pending lifecycle intent/i.test(failure.message),
      ),
  );
  assert.equal(fake.workflowReceipts().length, 1);
});

test("scheduled reconciliation recovers interrupted Issue system receipts", async () => {
  for (const action of ["initialize", "refresh", "reopen"]) {
    const fake = new FakeGitHub();
    const issue = fake.issues.get(46);
    if (action === "initialize") {
      issue.labels = [{ name: "type:docs" }];
    } else if (action === "refresh") {
      issue.labels = [{ name: "type:docs" }, { name: "status:waiting" }];
    } else {
      issue.labels = [{ name: "type:docs" }, { name: "status:done" }];
    }
    fake.failNextReceiptPost = true;
    await assert.rejects(
      () =>
        handleIssueChange(context(fake, fake.issueEvent(), { eventId: 930 })),
      /receipt write interruption/i,
    );

    await reconcileRepositoryState(
      context(fake, {}, { defaultBranch: "main" }),
    );
    assert.equal(
      fake.workflowReceipts().filter((receipt) => receipt.action === action)
        .length,
      1,
      `${action} receipt should recover on the scheduled entry point`,
    );
  }
});

test("scheduled reconciliation recovers interrupted close and expiry receipts", async () => {
  const closedFake = new FakeGitHub();
  await claim(closedFake);
  const pull = closedFake.pull();
  await handlePullRequest(
    context(closedFake, closedFake.pullEvent(pull, "opened"), {
      eventId: 910,
    }),
  );
  const merged = closedFake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = "2026-09-04T14:00:00.000Z";
  merged.updated_at = "2026-09-04T14:00:00.000Z";
  merged.merge_commit_sha = "abc1234";
  const closedIssue = closedFake.issues.get(46);
  closedIssue.state = "closed";
  closedIssue.state_reason = "completed";
  closedIssue.closed_at = "2026-09-04T14:00:00.000Z";
  closedFake.failNextReceiptPost = true;
  await assert.rejects(
    () =>
      handleIssueChange(
        context(closedFake, closedFake.issueEvent(), { eventId: 940 }),
      ),
    /receipt write interruption/i,
  );
  await reconcileRepositoryState(
    context(closedFake, {}, { defaultBranch: "main" }),
  );
  assert.equal(closedFake.workflowReceipts().at(-1).action, "close");

  const expiredFake = new FakeGitHub();
  await claim(expiredFake);
  expiredFake.failNextReceiptPost = true;
  await assert.rejects(
    () =>
      reconcileExpiredClaims(
        context(
          expiredFake,
          {},
          {
            eventId: 950,
            now: "2026-09-05T12:00:00.000Z",
          },
        ),
      ),
    /expired claim|receipt write interruption/i,
  );
  await reconcileRepositoryState(
    context(
      expiredFake,
      {},
      {
        defaultBranch: "main",
        now: "2026-09-05T13:00:00.000Z",
      },
    ),
  );
  assert.equal(expiredFake.workflowReceipts().at(-1).action, "expire");
});

test("a new claimant cannot be mutated by an unfinished prior claim intent", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () =>
      reconcileExpiredClaims(
        context(
          fake,
          {},
          {
            eventId: 950,
            now: "2026-09-05T12:00:00.000Z",
          },
        ),
      ),
    /expired claim|receipt write interruption/i,
  );
  const bobEvent = fake.command(902, "bob", "/ai-claim\nagent: codex");
  const bobContext = context(fake, bobEvent, {
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const recovered = await handleIssueComment(bobContext);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.plan.command, "expire");

  const claimed = await handleIssueComment(bobContext);
  assert.equal(claimed.plan.command, "claim");
  assert.equal(claimed.plan.receipt.actor, "bob");
  await reconcileRepositoryState(context(fake, {}, { defaultBranch: "main" }));
  assert.ok(
    fake.issue().labels.some(({ name }) => name === "status:in-progress"),
  );
  assert.deepEqual(fake.issue().assignees, [{ login: "bob" }]);
  assert.equal(fake.workflowReceipts().at(-1).actor, "bob");
});

test("a pending user intent completes before a later system transition", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const heartbeatEvent = fake.command(
    902,
    "alice",
    "/ai-heartbeat\nsummary: implementation continues",
  );
  heartbeatEvent.comment.created_at = "2026-09-04T13:00:00.000Z";
  fake.comments.get(46).find(({ id }) => id === 902).created_at =
    heartbeatEvent.comment.created_at;
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () => handleIssueComment(context(fake, heartbeatEvent)),
    /receipt write interruption/i,
  );

  const pull = fake.pull({ createdAt: "2026-09-04T13:30:00.000Z" });
  const recovered = await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), {
      eventId: 910,
      now: "2026-09-04T13:30:00.000Z",
    }),
  );
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.plan.command, "heartbeat");
  assert.equal(fake.workflowReceipts().at(-1).eventId, 902);

  const admitted = await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), {
      eventId: 910,
      now: "2026-09-04T13:30:00.000Z",
    }),
  );
  assert.equal(admitted.plan.command, "pr-open");
});

test("a later receipt supersedes an older unfinished intent without replay", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const oldHeartbeat = fake.command(
    902,
    "alice",
    "/ai-heartbeat\nsummary: implementation continues",
  );
  oldHeartbeat.comment.created_at = "2026-09-04T13:00:00.000Z";
  fake.comments.get(46).find(({ id }) => id === 902).created_at =
    oldHeartbeat.comment.created_at;
  fake.failNextReceiptPost = true;
  await assert.rejects(
    () => handleIssueComment(context(fake, oldHeartbeat)),
    /receipt write interruption/i,
  );
  const oldIntent = fake.comments
    .get(46)
    .find(
      ({ body }) =>
        body.includes("<!-- qhb-ai-intent:v2") && body.includes("event-id=902"),
    );
  assert.ok(oldIntent, JSON.stringify(fake.issueComments()));
  fake.comments.set(
    46,
    fake.comments.get(46).filter(({ id }) => id !== oldIntent.id),
  );

  const pull = fake.pull({ createdAt: "2026-09-04T13:30:00.000Z" });
  await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), { eventId: 910 }),
  );
  const closed = fake.pulls.get(51);
  closed.state = "closed";
  closed.updated_at = "2026-09-04T14:00:00.000Z";
  await handlePullRequest(
    context(fake, fake.pullEvent(closed, "closed"), {
      eventId: 911,
      now: "2026-09-04T14:00:00.000Z",
    }),
  );
  const beforeLease = currentClaimFromReceipts(
    fake.workflowReceipts(),
  ).leaseExpiresAt;
  fake.comments.get(46).push(oldIntent);

  const newHeartbeat = fake.command(
    903,
    "alice",
    "/ai-heartbeat\nsummary: final verification",
  );
  newHeartbeat.comment.created_at = "2026-09-04T15:00:00.000Z";
  fake.comments.get(46).find(({ id }) => id === 903).created_at =
    newHeartbeat.comment.created_at;
  const superseded = await handleIssueComment(context(fake, newHeartbeat));
  assert.deepEqual(
    { status: superseded.status, code: superseded.code },
    { status: "superseded", code: "STATE_MISMATCH" },
  );
  assert.equal(
    currentClaimFromReceipts(fake.workflowReceipts()).leaseExpiresAt,
    beforeLease,
  );
  const oldReceipt = fake
    .workflowReceipts()
    .find(({ eventId }) => eventId === 902);
  assert.equal(oldReceipt.result, "failure");

  const applied = await handleIssueComment(context(fake, newHeartbeat));
  assert.equal(applied.plan.receipt.eventId, 903);
  assert.equal(applied.plan.leaseExpiresAt, "2026-09-05T15:00:00.000Z");
});

test("a review lock cannot transfer to a second pull request", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const firstPull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(firstPull), { eventId: 910 }),
  );
  fake.pulls.get(51).state = "closed";
  const secondPull = fake.pull({
    number: 52,
    createdAt: "2026-09-06T12:00:00.000Z",
  });
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(secondPull), { eventId: 911 }),
      ),
    /bound.*pull request|pull request.*bound/i,
  );
});

test("terminal pull events reject every alternate open closing pull request", async () => {
  for (const merged of [false, true]) {
    const fake = new FakeGitHub();
    await claim(fake);
    const pull = fake.pull();
    await handlePullRequest(
      context(fake, fake.pullEvent(pull), { eventId: 910 }),
    );
    fake.pull({ number: 52 });
    const terminal = fake.pulls.get(51);
    terminal.state = "closed";
    terminal.merged = merged;
    terminal.merged_at = merged ? "2026-09-06T12:00:00.000Z" : null;
    terminal.merge_commit_sha = merged ? "abc1234" : null;
    if (merged) {
      const governedIssue = fake.issues.get(46);
      governedIssue.state = "closed";
      governedIssue.state_reason = "completed";
      governedIssue.closed_at = "2026-09-06T12:00:00.000Z";
    }
    await assert.rejects(
      () =>
        handlePullRequest(
          context(fake, fake.pullEvent(terminal), { eventId: 911 }),
        ),
      /open closing pull request/i,
    );
  }
});

test("merged pull request verifies completed closure and reaches done", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;

  await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 912 }),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:done"));
  assert.deepEqual(fake.issue().assignees, []);
  assert.equal(fake.workflowReceipts().at(-1).action, "merge");
});

test("completed idempotency requires terminal receipt and merge evidence", async () => {
  const fake = new FakeGitHub();
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  governedIssue.labels = [{ name: "type:docs" }, { name: "status:done" }];
  const pull = fake.pull({ state: "closed", merged: true });
  pull.merged_at = NOW;
  pull.merge_commit_sha = "abc1234";
  fake.pulls.set(51, pull);

  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 })),
    /final terminal receipt/i,
  );
  await assert.rejects(
    () =>
      handlePullRequest(context(fake, fake.pullEvent(pull), { eventId: 921 })),
    /final terminal receipt/i,
  );
});

test("completed idempotency rejects stale claim binding and unreachable merge", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull, "opened"), { eventId: 910 }),
  );
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 912 }),
  );

  fake.comparisonStatus = "diverged";
  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 })),
    /not reachable/i,
  );
  fake.comparisonStatus = "ahead";
  merged.body = merged.body.replace(
    /issuecomment-[1-9]\d*/u,
    "issuecomment-999",
  );
  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 921 })),
    /exactly one merged pull request/i,
  );
});

test("a final merge event reconstructs a dropped pull-request-open transition", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const merged = fake.pull();
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  fake.pulls.set(51, merged);
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;

  await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 912 }),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:done"));
  assert.deepEqual(
    fake
      .workflowReceipts()
      .filter(({ action }) => ["pr-open", "merge"].includes(action))
      .map(({ action }) => action),
    ["pr-open", "merge"],
  );
});

test("rejects a pull request bound to an obsolete claim receipt", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  pull.body = pull.body.replace(/issuecomment-[1-9]\d*/u, "issuecomment-999");
  fake.pulls.set(51, pull);
  await assert.rejects(
    () =>
      handlePullRequest(context(fake, fake.pullEvent(pull), { eventId: 910 })),
    /current claim generation/i,
  );
});

test("rejects a merge commit that is not reachable from main", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  fake.comparisonStatus = "diverged";
  await assert.rejects(
    () =>
      handlePullRequest(
        context(fake, fake.pullEvent(merged), { eventId: 912 }),
      ),
    /not reachable/i,
  );
});

test("merged pull event is idempotent when Issue close reconciliation won", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 }));

  const result = await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 921 }),
  );
  assert.deepEqual(result, { status: "unchanged" });
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:done"));
});

test("reopened completed Issue returns to ready with a fresh generation required", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 }));
  governedIssue.state = "open";
  governedIssue.state_reason = null;
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 921 }));
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.deepEqual(fake.issue().assignees, []);
  assert.equal(fake.workflowReceipts().at(-1).action, "reopen");
});

test("new and edited Issues initialize waiting then refresh to ready", async () => {
  const fake = new FakeGitHub();
  const governedIssue = fake.issues.get(46);
  governedIssue.labels = [{ name: "type:docs" }];
  governedIssue.body = "## Outcome\nNeeds the remaining readiness fields.";

  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 930 }));
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:waiting"));
  assert.equal(fake.workflowReceipts().at(-1).action, "initialize");

  governedIssue.body = issueBody();
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 931 }));
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.equal(fake.workflowReceipts().at(-1).action, "refresh");
});

test("manual completed closure cannot bypass a merged pull request", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(pull), { eventId: 910 }),
  );
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 })),
    /closing pull request is still open/i,
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:review"));
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
});

test("an old merged pull request cannot bless a fresh claim closure", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const oldPull = fake.pull();
  await handlePullRequest(
    context(fake, fake.pullEvent(oldPull), { eventId: 910 }),
  );
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc1234";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = NOW;
  await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 912 }),
  );
  governedIssue.state = "open";
  governedIssue.state_reason = null;
  governedIssue.closed_at = null;
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 }));

  await handleIssueComment(
    context(fake, fake.command(930, "bob", "/ai-claim\nagent: codex"), {
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  );
  governedIssue.labels = [{ name: "type:docs" }, { name: "status:review" }];
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  governedIssue.closed_at = "2026-09-04T13:00:00.000Z";
  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 921 })),
    /bound to the current claim/i,
  );
});

test("rejects ambiguous primary closure and repository event mismatches", async () => {
  const fake = new FakeGitHub();
  await claim(fake);
  const pull = fake.pull();
  pull.body += "\n- Primary Issue: #47\nCloses #47";
  fake.pulls.set(51, pull);
  await assert.rejects(
    () =>
      handlePullRequest(context(fake, fake.pullEvent(pull), { eventId: 910 })),
    /exactly one primary issue/i,
  );

  const event = fake.command(902, "alice", "/ai-heartbeat\nsummary: safe");
  event.repository.full_name = "evil/repository";
  await assert.rejects(
    () => handleIssueComment(context(fake, event)),
    /repository.*match/i,
  );
});

test("runLifecycleController dispatches supported event names", async () => {
  const fake = new FakeGitHub();
  const event = fake.command(901, "alice", "/ai-claim\nagent: codex");
  const result = await runLifecycleController({
    ...context(fake, event),
    eventName: "issue_comment",
  });
  assert.equal(result.status, "applied");
  await assert.rejects(
    () =>
      runLifecycleController({
        ...context(fake, {}),
        eventName: "push",
      }),
    /unsupported.*event/i,
  );
});

test("main drains commands but never treats a pull-request comment target as an Issue", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "qhb-pr-comment-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const eventPath = join(temporaryDirectory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: REPOSITORY, default_branch: "main" },
      issue: {
        number: 51,
        pull_request: {
          url: `https://api.github.com/repos/${REPOSITORY}/pulls/51`,
        },
      },
      comment: {
        id: 901,
        body: "/ai-claim\nagent: codex",
        issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/51`,
        user: { login: "alice" },
      },
    }),
  );
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    requests.push({
      method: options.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
    });
    if (
      requestUrl.pathname.includes(
        "/compare/b06aceb805f03dc809b37b80cb45a240bb5be66d...main",
      )
    ) {
      return new Response(JSON.stringify({ status: "ahead" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (requestUrl.pathname.endsWith("/issues/comments")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${requestUrl.pathname}`);
  };
  const result = await main({
    eventPath,
    eventName: "issue_comment",
    repository: REPOSITORY,
    token: "test-token",
    mode: "enforce",
    now: NOW,
    fetchImpl,
  });
  assert.deepEqual(result, {
    commandDrain: { status: "enforce", processed: 0, results: [] },
    lifecycle: { status: "ignored" },
  });
  const activationComparisonPath =
    "/repos/octo/example/compare/b06aceb805f03dc809b37b80cb45a240bb5be66d...main";
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.path, activationComparisonPath);
  assert.ok(
    requests.findIndex(({ path }) => path.includes("/issues/comments")) >
      requests.findIndex(({ path }) => path === activationComparisonPath),
  );
  assert.equal(
    requests.some(({ path }) => path.endsWith("/issues/51")),
    false,
  );
  assert.deepEqual(
    new Set(requests.map(({ method }) => method)),
    new Set(["GET"]),
  );
});

test("main fails closed before lifecycle processing when activation is unreachable", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "qhb-activation-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const eventPath = join(temporaryDirectory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: REPOSITORY, default_branch: "main" },
      issue: {
        number: 51,
        pull_request: {
          url: `https://api.github.com/repos/${REPOSITORY}/pulls/51`,
        },
      },
      comment: {
        id: 901,
        body: "/ai-claim\nagent: codex",
        issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/51`,
        user: { login: "alice" },
      },
    }),
  );
  const activationComparisonPath =
    "/repos/octo/example/compare/b06aceb805f03dc809b37b80cb45a240bb5be66d...main";

  for (const scenario of [
    {
      name: "diverged comparison",
      response: () =>
        new Response(JSON.stringify({ status: "diverged" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      error: /not reachable/i,
    },
    {
      name: "missing activation commit comparison",
      response: () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      error: /HTTP 404/i,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const requests = [];
      const fetchImpl = async (url, options = {}) => {
        const requestUrl = new URL(url);
        requests.push({
          method: options.method,
          path: `${requestUrl.pathname}${requestUrl.search}`,
        });
        assert.equal(requestUrl.pathname, activationComparisonPath);
        return scenario.response();
      };
      await assert.rejects(
        () =>
          main({
            eventPath,
            eventName: "issue_comment",
            repository: REPOSITORY,
            token: "test-token",
            mode: "enforce",
            now: NOW,
            fetchImpl,
          }),
        scenario.error,
      );
      assert.deepEqual(requests, [
        { method: "GET", path: activationComparisonPath },
      ]);
    });
  }
});
