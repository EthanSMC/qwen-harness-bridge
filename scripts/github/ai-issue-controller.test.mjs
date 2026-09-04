import assert from "node:assert/strict";
import test from "node:test";

import {
  handleIssueChange,
  handleIssueComment,
  handlePullRequest,
  reconcileExpiredClaims,
  runLifecycleController,
} from "./ai-issue-controller.mjs";
import { parseReceipts } from "./ai-issue-policy.mjs";

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

  command(id, actor, body, number = 46) {
    const comment = {
      id,
      body,
      created_at: NOW,
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
  } = {}) {
    const pull = {
      id: number,
      number,
      state,
      draft: false,
      merged,
      merged_at: merged ? NOW : null,
      merge_commit_sha: merged ? "abc123" : null,
      body: [
        "## Tracking",
        `- Primary Issue: #${issueNumber}`,
        "",
        `Closes #${issueNumber}`,
      ].join("\n"),
      user: { login: user },
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

  pullEvent(pull) {
    return {
      repository: { full_name: REPOSITORY, default_branch: "main" },
      pull_request: this.clone(pull),
    };
  }

  issueEvent(number = 46) {
    return {
      repository: { full_name: REPOSITORY, default_branch: "main" },
      issue: this.issue(number),
    };
  }

  async get(path) {
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
      body.body.includes("<!-- qhb-ai-lifecycle:v1")
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
    context(fake, fake.command(903, "alice", "/ai-resume"), {
      now: "2026-09-04T13:00:00.000Z",
    }),
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
  merged.merge_commit_sha = "abc123";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";

  await handlePullRequest(
    context(fake, fake.pullEvent(merged), { eventId: 912 }),
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:done"));
  assert.deepEqual(fake.issue().assignees, []);
  assert.equal(fake.workflowReceipts().at(-1).action, "merge");
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
  const merged = fake.pulls.get(51);
  merged.state = "closed";
  merged.merged = true;
  merged.merged_at = NOW;
  merged.merge_commit_sha = "abc123";
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
  merged.merge_commit_sha = "abc123";
  const governedIssue = fake.issues.get(46);
  governedIssue.state = "closed";
  governedIssue.state_reason = "completed";
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 }));
  governedIssue.state = "open";
  governedIssue.state_reason = null;
  await handleIssueChange(context(fake, fake.issueEvent(), { eventId: 921 }));
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:ready"));
  assert.deepEqual(fake.issue().assignees, []);
  assert.equal(fake.workflowReceipts().at(-1).action, "reopen");
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
  await assert.rejects(
    () => handleIssueChange(context(fake, fake.issueEvent(), { eventId: 920 })),
    /verified merged pull request/i,
  );
  assert.ok(fake.issue().labels.some(({ name }) => name === "status:review"));
  assert.deepEqual(fake.issue().assignees, [{ login: "alice" }]);
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
