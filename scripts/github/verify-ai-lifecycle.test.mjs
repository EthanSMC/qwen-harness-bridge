import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { receiptBody } from "./ai-issue-policy.mjs";
import {
  extractLifecycleFields,
  main,
  validatePullRequestLifecycleState,
} from "./verify-ai-lifecycle.mjs";

const REPOSITORY = "octo/example";
const NOW = "2026-09-04T13:00:00.000Z";
const CLAIM_ID = "550e8400-e29b-41d4-a716-446655440000";
const ACTIVATION = "a".repeat(40);
const pullRequestTemplate = resolve(
  import.meta.dirname,
  "../../.github/pull_request_template.md",
);

const issueBody = (dependency = "Blocked by none") =>
  [
    dependency,
    "",
    "## Outcome",
    "Deliver lifecycle governance.",
    "",
    "## Verification",
    "Run governance tests.",
    "",
    "## Risk and rollback",
    "Revert the governance commit.",
    "",
    "## Definition of done",
    "- [ ] Live evidence passes.",
  ].join("\n");

const pullBody = ({
  issue = 46,
  receipt = `https://github.com/${REPOSITORY}/issues/46#issuecomment-1234`,
  owner = "alice",
  agent = "codex",
  extra = "",
} = {}) =>
  [
    "## Tracking",
    `- Closes #${issue}`,
    `- Primary Issue: #${issue}`,
    `- Claim receipt: ${receipt}`,
    `- Accountable owner: @${owner}`,
    `- Implementer agent class: ${agent}`,
    "",
    "## Review evidence",
    "- Commit range reviewed (base..head; use the exact event base.sha..head.sha): base123..head123",
    extra,
  ].join("\n");

const claimReceipt = ({
  eventId = 901,
  actor = "alice",
  leaseExpiresAt = "2026-09-05T12:00:00.000Z",
} = {}) => ({
  version: 1,
  eventId,
  claimId: CLAIM_ID,
  action: "claim",
  result: "success",
  actor,
  agent: "codex",
  from: "ready",
  to: "in-progress",
  leaseExpiresAt,
  code: null,
});

const reviewReceipt = () => ({
  ...claimReceipt(),
  eventId: 902,
  action: "pr-open",
  from: "in-progress",
  to: "review",
});

const commentsFor = ({ user = "github-actions[bot]", receipts } = {}) =>
  (receipts ?? [claimReceipt(), reviewReceipt()]).map((receipt, index) => ({
    id: 1234 + index,
    body: receiptBody(receipt),
    created_at: "2026-09-04T12:00:00.000Z",
    user: { login: user },
  }));

const pullRequest = (body = pullBody()) => ({
  id: 51,
  number: 51,
  state: "open",
  body,
  user: { login: "alice" },
  base: {
    ref: "main",
    sha: "base123",
    repo: { full_name: REPOSITORY },
  },
  head: {
    ref: "docs/46-lifecycle",
    sha: "head123",
    repo: { full_name: REPOSITORY },
  },
});

const issue = (overrides = {}) => ({
  id: 46,
  number: 46,
  state: "open",
  state_reason: null,
  body: issueBody(),
  labels: [{ name: "type:docs" }, { name: "status:review" }],
  assignees: [{ login: "alice" }],
  ...overrides,
});

const strictMigrations = (overrides = {}) => ({
  schema_version: 2,
  activation_commit: ACTIVATION,
  mutation_acceptance: null,
  entries: [],
  ...overrides,
});

const validInput = (overrides = {}) => ({
  repository: REPOSITORY,
  defaultBranch: "main",
  pullRequest: pullRequest(),
  issue: issue(),
  comments: commentsFor(),
  dependencies: [],
  closingPullRequests: [pullRequest()],
  reviewedHeadSha: "head123",
  now: NOW,
  mode: "enforce",
  migrations: strictMigrations(),
  ...overrides,
});

test("parses one primary Issue and one concrete claim receipt", () => {
  assert.deepEqual(extractLifecycleFields(pullBody()), {
    issueNumber: 46,
    receiptUrl: `https://github.com/${REPOSITORY}/issues/46#issuecomment-1234`,
    owner: "alice",
    agent: "codex",
  });
});

test("rejects multiple closing Issues and private agent references", () => {
  assert.throws(
    () => extractLifecycleFields(`${pullBody()}\nCloses #47`),
    /exactly one closing Issue/i,
  );
  assert.throws(
    () =>
      extractLifecycleFields(pullBody({ agent: "codex://threads/private" })),
    /agent class|private codex/i,
  );
});

test("rejects prohibited public evidence inside fenced and inline code", () => {
  assert.throws(
    () =>
      extractLifecycleFields(
        `${pullBody()}\n\n\`\`\`text\ncodex://threads/private\n\`\`\``,
      ),
    /private codex/i,
  );
  assert.throws(
    () => extractLifecycleFields(`${pullBody()}\n\n\`token=secret\``),
    /credential/i,
  );
  assert.throws(
    () => extractLifecycleFields(`${pullBody()}\n\n\`/Users/alice/repo\``),
    /absolute path|local/i,
  );
});

test("parses lifecycle fields from the completed real PR template", () => {
  const body = readFileSync(pullRequestTemplate, "utf8")
    .replace(
      "- Closes # (required for GitHub Issue auto-close)",
      "- Closes #46",
    )
    .replace("- Primary Issue: #", "- Primary Issue: #46")
    .replace(
      "- Claim receipt: https://github.com/<owner>/<repo>/issues/<number>#issuecomment-<id>",
      `- Claim receipt: https://github.com/${REPOSITORY}/issues/46#issuecomment-1234`,
    )
    .replace("- Accountable owner: @", "- Accountable owner: @alice")
    .replace(
      "- Implementer agent class: codex / other / none",
      "- Implementer agent class: codex",
    );
  assert.deepEqual(extractLifecycleFields(body), {
    issueNumber: 46,
    receiptUrl: `https://github.com/${REPOSITORY}/issues/46#issuecomment-1234`,
    owner: "alice",
    agent: "codex",
  });
});

test("accepts a current review-state Issue and active claim", () => {
  assert.deepEqual(validatePullRequestLifecycleState(validInput()), {
    valid: true,
    mode: "enforce",
    migrated: false,
    issueNumber: 46,
    pullRequestNumber: 51,
    claimId: CLAIM_ID,
    claimCommentId: 1234,
    owner: "alice",
    agent: "codex",
    headSha: "head123",
  });
});

test("rejects missing, deleted, or non-workflow claim receipts", () => {
  for (const comments of [[], commentsFor({ user: "alice" })]) {
    assert.throws(
      () => validatePullRequestLifecycleState(validInput({ comments })),
      /claim receipt/i,
    );
  }
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          pullRequest: pullRequest(
            pullBody({
              receipt: `https://github.com/${REPOSITORY}/issues/46#issuecomment-9999`,
            }),
          ),
        }),
      ),
    /claim receipt/i,
  );
});

test("rejects expired or subsequently released claim generations", () => {
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({ now: "2026-09-05T12:00:00.000Z" }),
      ),
    /expired/i,
  );

  const released = {
    ...claimReceipt(),
    eventId: 903,
    action: "release",
    actor: "alice",
    from: "review",
    to: "ready",
    leaseExpiresAt: null,
  };
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          comments: commentsFor({
            receipts: [claimReceipt(), reviewReceipt(), released],
          }),
        }),
      ),
    /active claim|released/i,
  );
});

test("rejects owner, assignee, and lifecycle state drift", () => {
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({ issue: issue({ assignees: [{ login: "bob" }] }) }),
      ),
    /owner|assignee/i,
  );
  for (const state of ["waiting", "ready", "in-progress", "blocked", "done"]) {
    const assignees = ["in-progress", "blocked"].includes(state)
      ? [{ login: "alice" }]
      : [];
    assert.throws(
      () =>
        validatePullRequestLifecycleState(
          validInput({
            issue: issue({
              state: state === "done" ? "closed" : "open",
              state_reason: state === "done" ? "completed" : null,
              labels: [{ name: `status:${state}` }, { name: "type:docs" }],
              assignees,
            }),
          }),
        ),
      /review/i,
    );
  }
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          issue: issue({
            labels: [
              { name: "status:review" },
              { name: "status:blocked" },
              { name: "type:docs" },
            ],
          }),
        }),
      ),
    /exactly one lifecycle|exactly one managed/i,
  );
});

test("rejects open dependencies and ambiguous closing pull requests", () => {
  const dependentIssue = issue({
    body: issueBody("Blocked by #12"),
  });
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          issue: dependentIssue,
          dependencies: [
            { id: 12, number: 12, state: "open", state_reason: null },
          ],
        }),
      ),
    /dependency/i,
  );
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          closingPullRequests: [
            pullRequest(),
            { ...pullRequest(), number: 52 },
          ],
        }),
      ),
    /exactly one.*closing pull request/i,
  );
});

test("rejects a PR head newer than the recorded final review", () => {
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({ reviewedHeadSha: "old-head" }),
      ),
    /reviewed head|current head/i,
  );
});

test("report mode returns violations without weakening enforce mode", () => {
  const invalid = validInput({ comments: [], mode: "report" });
  const result = validatePullRequestLifecycleState(invalid);
  assert.equal(result.valid, false);
  assert.equal(result.mode, "report");
  assert.match(result.violations.join("\n"), /claim receipt/i);
  assert.throws(
    () => validatePullRequestLifecycleState({ ...invalid, mode: "enforce" }),
    /claim receipt/i,
  );
});

test("report mode contains missing fields and malformed registry semantics", () => {
  const missingFields = validatePullRequestLifecycleState(
    validInput({
      mode: "report",
      pullRequest: pullRequest("## Tracking\n\nCloses #46"),
    }),
  );
  assert.equal(missingFields.valid, false);
  assert.match(missingFields.violations.join("\n"), /Primary Issue/i);

  const malformed = strictMigrations();
  delete malformed.mutation_acceptance;
  const malformedResult = validatePullRequestLifecycleState(
    validInput({ mode: "report", migrations: malformed }),
  );
  assert.equal(malformedResult.valid, false);
  assert.match(malformedResult.violations.join("\n"), /missing fields/i);
});

test("report mode still fails on unavailable external GitHub state", () => {
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({ mode: "report", issue: null }),
      ),
    /unavailable/i,
  );
});

test("allows only an exact unexpired migration before activation", () => {
  const migrations = {
    schema_version: 2,
    activation_commit: null,
    mutation_acceptance: {
      reason: "Bounded live acceptance",
      approved_by: "maintainer",
      expires_at: "2026-09-11T00:00:00.000Z",
    },
    entries: [
      {
        pull_request: 51,
        issue: 46,
        reason: "Pull request predates AI lifecycle activation",
        approved_by: "maintainer",
        expires_at: "2026-09-11T00:00:00.000Z",
      },
    ],
  };
  const migrated = validatePullRequestLifecycleState(
    validInput({ comments: [], mode: "report", migrations }),
  );
  assert.equal(migrated.valid, true);
  assert.equal(migrated.migrated, true);

  const migratedLegacyBody = validatePullRequestLifecycleState(
    validInput({
      comments: [],
      mode: "report",
      migrations,
      pullRequest: {
        ...validInput().pullRequest,
        body: "## Tracking\n\nCloses #46",
      },
    }),
  );
  assert.equal(migratedLegacyBody.valid, true);
  assert.equal(migratedLegacyBody.migrated, true);

  const wrongPair = structuredClone(migrations);
  wrongPair.entries[0].issue = 47;
  assert.equal(
    validatePullRequestLifecycleState(
      validInput({ comments: [], mode: "report", migrations: wrongPair }),
    ).valid,
    false,
  );
  const expired = structuredClone(migrations);
  expired.entries[0].expires_at = NOW;
  assert.equal(
    validatePullRequestLifecycleState(
      validInput({ comments: [], mode: "report", migrations: expired }),
    ).valid,
    false,
  );
});

test("CLI resolves an exact legacy migration before claim-field lookup", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "qhb-migration-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const legacyPullRequest = pullRequest("## Tracking\n\nCloses #46");
  const eventPath = join(temporaryDirectory, "event.json");
  const migrationsPath = join(temporaryDirectory, "migrations.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: REPOSITORY, default_branch: "main" },
      pull_request: legacyPullRequest,
    }),
  );
  await writeFile(
    migrationsPath,
    JSON.stringify({
      schema_version: 2,
      activation_commit: null,
      mutation_acceptance: {
        reason: "Bounded live acceptance",
        approved_by: "maintainer",
        expires_at: "2026-09-11T00:00:00Z",
      },
      entries: [
        {
          pull_request: 51,
          issue: 46,
          reason: "Pull request predates AI lifecycle activation",
          approved_by: "maintainer",
          expires_at: "2026-09-11T00:00:00Z",
        },
      ],
    }),
  );
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url).pathname);
    const value = url.endsWith("/pulls/51")
      ? legacyPullRequest
      : { ...issue(), labels: [], assignees: [] };
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await main({
    eventPath,
    token: "test-token",
    repository: REPOSITORY,
    staticResult: "success",
    mode: "report",
    migrationsPath,
    fetchImpl,
    now: NOW,
  });
  assert.equal(result.migrated, true);
  assert.deepEqual(requests, [
    "/repos/octo/example/pulls/51",
    "/repos/octo/example/issues/46",
  ]);
});

test("strict activation requires one main commit and no migrations", () => {
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          migrations: strictMigrations({ activation_commit: null }),
        }),
      ),
    /activation commit/i,
  );
  assert.throws(
    () =>
      validatePullRequestLifecycleState(
        validInput({
          migrations: strictMigrations({
            entries: [
              {
                pull_request: 51,
                issue: 46,
                reason: "Legacy work",
                approved_by: "maintainer",
                expires_at: "2026-09-11T00:00:00.000Z",
              },
            ],
          }),
        }),
      ),
    /forbids.*migration|migration.*forbidden/i,
  );
});
