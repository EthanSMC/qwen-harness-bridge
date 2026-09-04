# AI-Assisted Issue Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and activate a GitHub-native, human-accountable workflow that lets every eligible contributor use an AI agent to claim an Issue and complete the verified Issue-to-Release lifecycle.

**Architecture:** A pure Node.js policy module owns command parsing, readiness, state transitions, leases, and receipt validation. A separately tested GitHub adapter/controller applies that policy from trusted default-branch workflows, while a read-only pull-request validator joins live Issue, claim, PR, review, and checks evidence. Repository documents and templates expose the same contract to humans and agents; GitHub remains the only shared state store.

**Tech Stack:** Node.js 20 ESM, `node:test`, native `fetch`, GitHub REST API 2022-11-28, GitHub Actions YAML, GitHub Issues/labels/assignees/comments, protected-branch checks

**Spec:** `docs/superpowers/specs/2026-09-04-ai-issue-collaboration-design.md`

## Global Constraints

- A named human is the single accountable Issue assignee; AI agents are executors or reviewers, never anonymous owners.
- Eligible claimants are direct collaborators with `write`, `maintain`, or `admin` permission.
- GitHub Issue state, exactly one managed lifecycle label, one human assignee where required, workflow receipts, the linked pull request, and current-head checks are authoritative.
- Managed states are exactly `status:waiting`, `status:ready`, `status:in-progress`, `status:review`, `status:blocked`, and `status:done`.
- Active claim leases last 24 hours and renew only through an explicit bounded heartbeat.
- Each claim produces exactly one implementation branch and one primary closing pull request.
- The implementation agent and final reviewer are different identities; the existing formal-collaborator and solo-maintainer gates remain mandatory.
- Public evidence never contains private agent threads, prompts, model reasoning, full logs, credentials, source bodies, private repository paths, or absolute local paths.
- Write-capable workflows execute only code from protected `main` and never check out or execute pull-request head code.
- Commands, fields, API pages, and receipts are strictly bounded; malformed, ambiguous, partial, stale, or unavailable state fails closed.
- No new runtime dependency is added; policy and controller code use Node.js built-ins.
- Existing closed Issues are historical. Existing open work receives an explicit migration record before strict enforcement.

## File and responsibility map

- `AGENTS.md` — concise canonical contract loaded by repository-aware AI agents.
- `docs/github/ai-collaboration.md` — contributor commands, examples, recovery, and troubleshooting.
- `docs/github/ai-lifecycle-migrations.json` — bounded one-time evidence for work that predates activation.
- `scripts/github/ai-issue-policy.mjs` — pure command parser, state invariants, readiness, transitions, receipt schema, and safe-field validation.
- `scripts/github/ai-issue-policy.test.mjs` — exhaustive policy and parser tests.
- `scripts/github/github-api.mjs` — strict, paginated, retry-safe GitHub REST boundary.
- `scripts/github/github-api.test.mjs` — API error, pagination, and mutation verification tests.
- `scripts/github/ai-issue-controller.mjs` — trusted event controller for commands, leases, PR transitions, close/reopen, and reconciliation.
- `scripts/github/ai-issue-controller.test.mjs` — fake-GitHub end-to-end lifecycle and race tests.
- `scripts/github/verify-ai-lifecycle.mjs` — read-only live PR-to-Issue claim validator.
- `scripts/github/verify-ai-lifecycle.test.mjs` — valid, migrated, contradictory, and unavailable-state gate tests.
- `.github/workflows/ai-issue-lifecycle.yml` — write-capable default-branch controller and scheduled reconciliation.
- `.github/workflows/governance.yml` — static tests plus read-only strict lifecycle verification.
- Existing repository documents, templates, labels, management sync, and planning verifier — surface and enforce the same contract.

---

### Task 1: Publish the normative lifecycle contract

**Files:**
- Create: `AGENTS.md`
- Create: `docs/github/ai-collaboration.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `.github/ISSUE_TEMPLATE/implementation.yml`
- Modify: `.github/ISSUE_TEMPLATE/bug.yml`
- Modify: `.github/pull_request_template.md`
- Modify: `.github/labels.yml`
- Modify: `scripts/github/verify-planning.mjs`
- Test: `scripts/github/verify-planning.mjs`

**Interfaces:**
- Consumes: the approved design and existing formal/solo review contract.
- Produces: six exact lifecycle labels; exact Issue fields `Dependencies`, `Outcome`, `Verification`, and `Risk and rollback`; exact PR fields `Primary Issue`, `Claim receipt`, `Accountable owner`, and `Implementer agent class`; canonical `/ai-*` command documentation.

- [x] **Step 1: Make the planning verifier require the new contract before adding it**

Add the spec, plan, `AGENTS.md`, and `docs/github/ai-collaboration.md` to the verified file set. Add exact requirements:

```js
const aiGovernance = [
  "AGENTS.md",
  "docs/github/ai-collaboration.md",
  "docs/superpowers/specs/2026-09-04-ai-issue-collaboration-design.md",
  "docs/superpowers/plans/2026-09-04-ai-issue-collaboration.md",
];

const lifecycleLabels = [
  "status:waiting",
  "status:ready",
  "status:in-progress",
  "status:review",
  "status:blocked",
  "status:done",
];

for (const label of lifecycleLabels) {
  requireGovernanceField(".github/labels.yml", new RegExp(`name: "${label}"`), label);
}
for (const command of ["/ai-claim", "/ai-heartbeat", "/ai-block", "/ai-resume", "/ai-release"]) {
  requireGovernanceField("AGENTS.md", new RegExp(command.replace("/", "\\/")), command);
}
```

- [x] **Step 2: Run the verifier and observe the missing-contract failure**

Run: `node scripts/github/verify-planning.mjs`
Expected: FAIL naming missing `AGENTS.md` or a required lifecycle artifact.

- [x] **Step 3: Add the canonical agent contract**

`AGENTS.md` must state, in imperative language:

```markdown
# Repository Agent Contract

GitHub is the shared source of truth. Do not begin work until the lifecycle bot has accepted `/ai-claim` and issued a claim receipt. The Issue assignee is the accountable human; never publish a private agent thread, prompt, raw log, credential, source body, or local absolute path.

Read `CONTRIBUTING.md`, `docs/github/ai-collaboration.md`, the claimed Issue, and every linked spec/plan before editing. Use one Issue, one supported branch, one isolated worktree, and one primary pull request. Keep the 24-hour lease alive with `/ai-heartbeat`. Use `/ai-block`, `/ai-resume`, or `/ai-release` exactly as documented.

Use test-first development for behavior changes. A different agent or eligible collaborator reviews the complete final commit range. A pull request must contain `Closes #N`, the claim receipt, exact verification evidence, risk, rollback, and current review evidence. Merge only after all required current-head checks pass, then verify Issue closure and cleanup.
```

- [x] **Step 4: Add contributor documentation and workflow overview**

Document the exact state table, readiness conditions, command syntax, success receipts, safe evidence, branch/worktree convention, review/fix loop, handoff, closure, and Release gate in `docs/github/ai-collaboration.md`. Update `README.md` to link it and summarize:

```markdown
Every eligible contributor may use an AI agent. The human Issue assignee remains accountable, and repository automation serializes claims, records bounded receipts, enforces independent review and current-head CI, and verifies closure. See [AI-assisted Issue collaboration](docs/github/ai-collaboration.md).
```

Replace the generic start-work steps in `CONTRIBUTING.md` with the normative claim-first lifecycle without weakening the existing review gate.

- [x] **Step 5: Add managed lifecycle labels**

Append these exact entries to `.github/labels.yml`:

```yaml
  - { name: "status:waiting", color: "d4c5f9", description: "Requirements or dependencies are not ready" }
  - { name: "status:ready", color: "0e8a16", description: "Ready for one eligible contributor to claim" }
  - { name: "status:in-progress", color: "1d76db", description: "Exclusively claimed and under implementation" }
  - { name: "status:review", color: "5319e7", description: "Pull request is in CI, review, or fix rounds" }
  - { name: "status:blocked", color: "b60205", description: "Claimed work awaits a named external condition" }
  - { name: "status:done", color: "6f7781", description: "Derived terminal state for a completed closed Issue" }
```

- [x] **Step 6: Extend Issue templates with readiness evidence**

Both governed templates must require a single-line dependency declaration (`Blocked by none` or `Blocked by #12, #19`), outcome, observed verification commands/results, and risk/rollback. Add this implementation-template input:

```yaml
  - type: input
    id: dependencies
    attributes:
      label: Dependencies
      description: Use exactly "Blocked by none" or "Blocked by #12, #19".
      placeholder: Blocked by none
    validations:
      required: true
```

- [x] **Step 7: Extend the PR template with claim evidence**

Immediately after `## Tracking`, add:

```markdown
- Primary Issue: #
- Claim receipt: https://github.com/<owner>/<repo>/issues/<number>#issuecomment-<id>
- Accountable owner: @
- Implementer agent class: codex / other / none
```

Explain that private task/thread URLs and local paths are prohibited. Keep all existing review-mode fields verbatim so the current review validator remains compatible.

- [x] **Step 8: Run the normative contract checks**

Run: `node scripts/github/verify-planning.mjs && git diff --check`
Expected: PASS with the new files and all six labels verified.

- [x] **Step 9: Commit the public contract**

```bash
git add AGENTS.md README.md CONTRIBUTING.md docs/github/ai-collaboration.md .github/ISSUE_TEMPLATE .github/pull_request_template.md .github/labels.yml scripts/github/verify-planning.mjs
git commit -m "docs(governance): define AI issue lifecycle"
```

---

### Task 2: Implement the pure lifecycle policy

**Files:**
- Create: `scripts/github/ai-issue-policy.mjs`
- Create: `scripts/github/ai-issue-policy.test.mjs`

**Interfaces:**
- Consumes: Issue/label/assignee/comment data already normalized from GitHub.
- Produces: `STATUS_LABELS`, `COMMAND_NAMES`, `parseLifecycleCommand(body)`, `parseDependencies(body)`, `assertIssueInvariant(issue)`, `evaluateReadiness(input)`, `parseReceipts(comments)`, `planLifecycleCommand(input)`, `receiptBody(input)`, and `safePublicText(value, maxBytes)`.

- [x] **Step 1: Write parser and safe-field tests**

Create tests with these concrete cases:

```js
test("parses a bounded claim command", () => {
  assert.deepEqual(parseLifecycleCommand("/ai-claim\nagent: codex"), {
    name: "claim",
    fields: { agent: "codex" },
  });
});

test("rejects private URLs, duplicate fields, unknown fields, and oversized UTF-8", () => {
  assert.throws(() => parseLifecycleCommand("/ai-claim\nagent: codex\nagent: other"), /duplicate/i);
  assert.throws(() => parseLifecycleCommand("/ai-heartbeat\nsummary: codex:\/\/threads\/private"), /private|prohibited/i);
  assert.throws(() => parseLifecycleCommand("/ai-block\nreason: x\nresume-when: y\nextra: z"), /unknown/i);
  assert.throws(() => safePublicText("界".repeat(81), 240), /240 UTF-8 bytes/i);
});
```

- [x] **Step 2: Run the parser tests to verify failure**

Run: `node --test scripts/github/ai-issue-policy.test.mjs`
Expected: FAIL because `ai-issue-policy.mjs` does not exist.

- [x] **Step 3: Implement exact command schemas**

Use these allowed fields:

```js
export const COMMAND_NAMES = Object.freeze([
  "claim",
  "heartbeat",
  "block",
  "resume",
  "release",
]);

const COMMAND_FIELDS = Object.freeze({
  claim: { required: ["agent"], allowed: ["agent"] },
  heartbeat: { required: ["summary"], allowed: ["summary"] },
  block: { required: ["reason", "resume-when"], allowed: ["reason", "resume-when"] },
  resume: { required: [], allowed: [] },
  release: { required: ["reason"], allowed: ["reason"] },
});
```

Only one leading `/ai-<name>` line is accepted. Agent identifiers match `/^[a-z0-9][a-z0-9._-]{0,31}$/`. Summary, reason, and resume condition allow one line and at most 240 UTF-8 bytes. Reject `codex://`, credential-like assignments, absolute Unix/Windows paths, NUL/control characters, and URLs outside `https://github.com/` when a public reference is allowed.

- [x] **Step 4: Write lifecycle invariant and readiness tests**

```js
test("requires one waiting or terminal label without an assignee", () => {
  assert.deepEqual(assertIssueInvariant(issue({ labels: ["status:waiting"], assignees: [] })).state, "waiting");
  assert.throws(() => assertIssueInvariant(issue({ labels: ["status:ready", "status:waiting"] })), /exactly one/i);
  assert.throws(() => assertIssueInvariant(issue({ labels: ["status:in-progress"], assignees: [] })), /exactly one assignee/i);
});

test("readiness fails on an open dependency or closing PR", () => {
  assert.deepEqual(evaluateReadiness({ issue: readyIssue, dependencies: [{ number: 12, state: "open" }], closingPullRequests: [] }).code, "DEPENDENCY_OPEN");
  assert.deepEqual(evaluateReadiness({ issue: readyIssue, dependencies: [], closingPullRequests: [{ number: 51, state: "open" }] }).code, "CLOSING_PR_EXISTS");
});
```

- [x] **Step 5: Implement states, dependencies, readiness, and transition planning**

Export the six labels and the transition graph exactly:

```js
export const STATUS_LABELS = Object.freeze([
  "status:waiting", "status:ready", "status:in-progress",
  "status:review", "status:blocked", "status:done",
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  waiting: ["ready"],
  ready: ["in-progress"],
  "in-progress": ["review", "blocked", "ready", "waiting"],
  blocked: ["in-progress", "ready", "waiting"],
  review: ["in-progress", "blocked", "done"],
  done: ["ready", "waiting"],
});
```

`planLifecycleCommand` returns a data-only plan:

```js
{
  command: "claim",
  from: "ready",
  to: "in-progress",
  assignee: "alice",
  removeAssignee: null,
  leaseExpiresAt: "2026-09-05T12:00:00.000Z",
  receipt: { version: 1, eventId: 901, claimId: "<uuid>", actor: "alice", agent: "codex" },
}
```

Accept `now` and `randomUUID` as injected dependencies. Never read wall-clock time or create randomness inside pure validation branches.

- [x] **Step 6: Write claim, lease, block, resume, release, and replay tests**

Cover first claim success, second claim rejection, non-owner heartbeat rejection, exact 24-hour renewal, expired lease, owner block/resume, owner/maintainer release, release to waiting when dependencies reopened, duplicate event idempotency, and invalid transition rejection. Assert stable error codes from the design.

- [x] **Step 7: Implement versioned machine receipts**

Generate a human-readable comment followed by this bounded marker:

```html
<!-- qhb-ai-lifecycle:v1
event-id=901
claim-id=550e8400-e29b-41d4-a716-446655440000
action=claim
result=success
actor=alice
agent=codex
from=ready
to=in-progress
lease-expires-at=2026-09-05T12:00:00.000Z
code=-
-->
```

Reject unknown keys, duplicate keys, unsupported versions, invalid timestamps/UUIDs, and actor/claim mismatches. `parseReceipts` sorts by GitHub comment ID, rejects duplicate event IDs with different content, and selects only workflow-authored verified receipts supplied by the adapter.

- [x] **Step 8: Run policy tests and commit**

Run: `node --test scripts/github/ai-issue-policy.test.mjs && git diff --check`
Expected: PASS.

```bash
git add scripts/github/ai-issue-policy.mjs scripts/github/ai-issue-policy.test.mjs
git commit -m "feat(governance): add AI issue lifecycle policy"
```

---

### Task 3: Add the strict GitHub API boundary

**Files:**
- Create: `scripts/github/github-api.mjs`
- Create: `scripts/github/github-api.test.mjs`
- Modify: `scripts/github/verify-pr-review-evidence.mjs`
- Modify: `scripts/github/verify-pr-review-state.test.mjs`

**Interfaces:**
- Consumes: injected `fetch`, repository `owner/name`, token, REST paths, and expected postconditions.
- Produces: `createGitHubClient({ fetchImpl, repository, token, maxPages })` with `get`, `getAll`, `post`, `patch`, `delete`, and `mutateAndVerify` methods.

- [x] **Step 1: Write API boundary tests**

```js
test("paginates until a short page and fails at the cap", async () => {
  const client = createGitHubClient({ fetchImpl: pagedFetch([[{ id: 1 }], []]), repository: REPOSITORY, token: TOKEN, pageSize: 1, maxPages: 3 });
  assert.deepEqual(await client.getAll("/issues/46/comments", "comments"), [{ id: 1 }]);
  await assert.rejects(() => createGitHubClient({ fetchImpl: pagedFetch([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]), repository: REPOSITORY, token: TOKEN, pageSize: 1, maxPages: 3 }).getAll("/issues", "issues"), /safety cap/i);
});

test("reconciles an uncertain mutation before retrying", async () => {
  const result = await client.mutateAndVerify({
    mutation: { method: "PATCH", path: "/issues/46", body: { labels: ["status:in-progress"] } },
    read: () => client.get("/issues/46"),
    verify: (issue) => issue.labels.some(({ name }) => name === "status:in-progress"),
  });
  assert.equal(result.verified, true);
});
```

- [x] **Step 2: Run tests and observe the missing-module failure**

Run: `node --test scripts/github/github-api.test.mjs`
Expected: FAIL because the API client does not exist.

- [x] **Step 3: Implement strict REST requests and pagination**

Every request sets `Accept`, `Authorization`, and `X-GitHub-Api-Version`. Require object/array response shapes, positive numeric IDs, page sizes no larger than requested, and a short page before the configured cap. Include method/path/status in errors without echoing tokens or response bodies.

`mutateAndVerify` performs one mutation, then a live read. On network uncertainty it reads first; it retries only when the verified postcondition is false and the operation has a stable idempotency key or is naturally idempotent.

- [x] **Step 4: Replace duplicated read helpers in the review verifier**

Make `verify-pr-review-evidence.mjs` consume `createGitHubClient` for live reads while preserving its exported public functions and exact fail-closed behavior. Extend existing tests to prove collaborator, review, and check-run pagination still works and never performs a write.

- [x] **Step 5: Run all review/API tests and commit**

Run:

```bash
node --test scripts/github/github-api.test.mjs scripts/github/verify-pr-review-evidence.test.mjs scripts/github/verify-pr-review-state.test.mjs
```

Expected: PASS.

```bash
git add scripts/github/github-api.mjs scripts/github/github-api.test.mjs scripts/github/verify-pr-review-evidence.mjs scripts/github/verify-pr-review-state.test.mjs
git commit -m "refactor(governance): share strict GitHub API client"
```

---

### Task 4: Implement the trusted lifecycle controller

**Files:**
- Create: `scripts/github/ai-issue-controller.mjs`
- Create: `scripts/github/ai-issue-controller.test.mjs`

**Interfaces:**
- Consumes: GitHub webhook event JSON, `GITHUB_EVENT_NAME`, repository, actor, token, server time, `createGitHubClient`, and pure policy functions.
- Produces: `handleIssueComment`, `handlePullRequest`, `handleIssueChange`, `reconcileExpiredClaims`, `runLifecycleController`, and CLI exit status.

- [x] **Step 1: Write a stateful fake-GitHub acceptance harness**

The fake stores issues, comments, labels, collaborators, pull requests, and server time. Start with Issue #46:

```js
const initial = {
  issues: [{
    number: 46,
    state: "open",
    body: "Blocked by none\n\n## Outcome\nGovern AI collaboration\n\n## Verification\nnode --test\n\n## Risk and rollback\nRevert",
    labels: [{ name: "type:docs" }, { name: "status:ready" }],
    assignees: [],
  }],
  collaborators: [{ login: "alice", permission: "write" }, { login: "bob", permission: "write" }],
  comments: [],
  pullRequests: [],
  now: "2026-09-04T12:00:00.000Z",
};
```

- [x] **Step 2: Write the exclusive-claim race test**

```js
test("two serialized claim events produce one owner and one success receipt", async () => {
  await handleIssueComment(contextFor({ eventId: 901, actor: "alice", body: "/ai-claim\nagent: codex" }));
  await handleIssueComment(contextFor({ eventId: 902, actor: "bob", body: "/ai-claim\nagent: codex" }));
  const issue = fake.issue(46);
  assert.deepEqual(issue.assignees.map(({ login }) => login), ["alice"]);
  assert.deepEqual(issue.labels.filter(isStatus).map(({ name }) => name), ["status:in-progress"]);
  assert.equal(fake.successReceipts(46).length, 1);
  assert.match(fake.commentForEvent(902).body, /ALREADY_CLAIMED/);
});
```

- [x] **Step 3: Run controller tests and observe failure**

Run: `node --test scripts/github/ai-issue-controller.test.mjs`
Expected: FAIL because the controller does not exist.

- [x] **Step 4: Implement claim context loading and verified mutation**

For Issue comments, verify the event repository, Issue number, comment ID/body/author, and live comment identity. Ignore comments on pull requests and non-command comments. Query live permission, Issue, all Issue comments, parsed dependencies, and open pull requests whose body has a primary closing reference.

Apply the pure plan in this order: create an intent record keyed by event ID, mutate label/assignee idempotently, create the success receipt, and re-read all state. If any final invariant fails, create one failure receipt with `STATE_MISMATCH` and return a failing status.

- [x] **Step 5: Implement heartbeat, block, resume, and release**

Require the current assignee for heartbeat/block/resume. Permit release by the owner or an admin/maintain collaborator. Refuse release while a closing pull request is open. Each action uses the current claim ID and produces one idempotent receipt.

- [x] **Step 6: Write lease and recovery tests**

Test exact expiry boundaries, scheduled release to ready, scheduled release to waiting after a dependency reopens, no automatic release for review/blocked, duplicate schedule delivery, block/resume, release with an open PR, maintainer repair, and GitHub timeout reconciliation.

- [x] **Step 7: Implement scheduled and Issue reconciliation**

`reconcileExpiredClaims` pages through open `status:in-progress` Issues and releases only those whose latest verified lease is `<= now`. `handleIssueChange` maps closed-completed to done/unassigned and reopened to ready or waiting. Manual drift creates a repair-required failure receipt without guessing ownership.

- [x] **Step 8: Write PR transition and closure tests**

Cover open/draft/synchronize moving the primary Issue to review, closed-unmerged returning review to in-progress, merged requiring the Issue to close as completed, branch Issue-number matching, PR-author/assignee matching, and ambiguous/multiple primary closing references.

- [x] **Step 9: Implement pull-request reconciliation**

Read the pull request live. A qualifying open PR moves `in-progress` to `review`. A closed unmerged PR returns to `in-progress` with a renewed lease. A merged PR verifies GitHub closure, main reachability through the merge response, and terminal reconciliation before applying `status:done` and removing the assignee.

- [x] **Step 10: Run controller tests and commit**

Run:

```bash
node --test scripts/github/ai-issue-policy.test.mjs scripts/github/github-api.test.mjs scripts/github/ai-issue-controller.test.mjs
```

Expected: PASS.

```bash
git add scripts/github/ai-issue-controller.mjs scripts/github/ai-issue-controller.test.mjs
git commit -m "feat(governance): add AI issue lifecycle controller"
```

---

### Task 5: Add trusted lifecycle workflows

**Files:**
- Create: `.github/workflows/ai-issue-lifecycle.yml`
- Modify: `.github/workflows/governance.yml`
- Modify: `scripts/github/verify-planning.mjs`
- Test: `scripts/github/ai-issue-controller.test.mjs`
- Test: `scripts/github/verify-planning.mjs`

**Interfaces:**
- Consumes: Issue comments, Issue close/reopen events, pull-request-target lifecycle events, and hourly schedule.
- Produces: serialized write-capable controller runs and a read-only governance test surface.

- [x] **Step 1: Add failing static workflow assertions**

Require the lifecycle workflow to contain:

```js
requireGovernanceField(".github/workflows/ai-issue-lifecycle.yml", /issue_comment:/, "issue comment trigger");
requireGovernanceField(".github/workflows/ai-issue-lifecycle.yml", /pull_request_target:/, "trusted pull request target trigger");
requireGovernanceField(".github/workflows/ai-issue-lifecycle.yml", /issues:\s*write/, "issues write permission");
requireGovernanceField(".github/workflows/ai-issue-lifecycle.yml", /cancel-in-progress:\s*false/, "serialized claim queue");
requireGovernanceField(".github/workflows/ai-issue-lifecycle.yml", /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/, "default branch checkout");
```

- [x] **Step 2: Run the planning verifier and observe the missing-workflow failure**

Run: `node scripts/github/verify-planning.mjs`
Expected: FAIL naming `.github/workflows/ai-issue-lifecycle.yml`.

- [x] **Step 3: Create the trusted workflow**

Use this event and permission shape:

```yaml
name: AI Issue Lifecycle
on:
  issue_comment:
    types: [created]
  issues:
    types: [closed, reopened, labeled, unlabeled, assigned, unassigned]
  pull_request_target:
    types: [opened, reopened, synchronize, converted_to_draft, ready_for_review, closed]
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  pull-requests: read

concurrency:
  # Repository scope serializes Issue, PR, and scheduled events that use different IDs.
  group: ai-issue-lifecycle-${{ github.repository }}
  cancel-in-progress: false
```

Checkout `github.event.repository.default_branch` explicitly, set `persist-credentials: false`, and run only `node scripts/github/ai-issue-controller.mjs`. Do not interpolate comment bodies into shell or environment variables; the controller reads the immutable event file.

- [x] **Step 4: Add a report-only rollout switch**

Set `AI_LIFECYCLE_MODE` from repository variable `AI_LIFECYCLE_MODE`, defaulting to `report`. In `report`, command handling may create a rejection/report comment but cannot change assignees or labels. In `enforce`, all verified mutations are enabled. Unit tests must prove report mode emits no mutation requests.

- [x] **Step 5: Add lifecycle tests to static governance**

Extend the `static` job command:

```yaml
- name: Test repository governance
  run: >-
    node --test
    scripts/github/ai-issue-policy.test.mjs
    scripts/github/github-api.test.mjs
    scripts/github/ai-issue-controller.test.mjs
    scripts/github/verify-pr-review-evidence.test.mjs
    scripts/github/verify-pr-review-state.test.mjs
    scripts/github/sync-management.test.mjs
```

- [x] **Step 6: Run workflow and controller checks, then commit**

Run:

```bash
node scripts/github/verify-planning.mjs
node --test scripts/github/ai-issue-policy.test.mjs scripts/github/github-api.test.mjs scripts/github/ai-issue-controller.test.mjs
git diff --check
```

Expected: PASS.

```bash
git add .github/workflows/ai-issue-lifecycle.yml .github/workflows/governance.yml scripts/github/verify-planning.mjs
git commit -m "ci(governance): run trusted AI issue lifecycle"
```

---

### Task 6: Enforce live PR-to-claim consistency

**Files:**
- Create: `scripts/github/verify-ai-lifecycle.mjs`
- Create: `scripts/github/verify-ai-lifecycle.test.mjs`
- Create: `docs/github/ai-lifecycle-migrations.json`
- Modify: `.github/workflows/governance.yml`
- Modify: `.github/pull_request_template.md`
- Modify: `scripts/github/verify-planning.mjs`

**Interfaces:**
- Consumes: pull-request event, live PR, primary Issue, verified workflow comments, current labels/assignee, migration registry, and current enforcement mode.
- Produces: `extractLifecycleFields(body)`, `validatePullRequestLifecycleState(input)`, and a zero/nonzero CLI gate.

- [x] **Step 1: Write PR-body field tests against the real template**

```js
test("parses one primary Issue and one concrete claim receipt", () => {
  assert.deepEqual(extractLifecycleFields(completedTemplate()), {
    issueNumber: 46,
    receiptUrl: "https://github.com/EthanSMC/qwen-harness-bridge/issues/46#issuecomment-1234",
    owner: "EthanSMC",
    agent: "codex",
  });
});

test("rejects multiple closing Issues and private agent references", () => {
  assert.throws(() => extractLifecycleFields(bodyWith("Closes #46\nCloses #47")), /exactly one/i);
  assert.throws(() => extractLifecycleFields(bodyWith("- Implementer agent class: codex://threads/private")), /agent class/i);
});
```

- [x] **Step 2: Run the verifier tests and observe failure**

Run: `node --test scripts/github/verify-ai-lifecycle.test.mjs`
Expected: FAIL because the verifier does not exist.

- [x] **Step 3: Implement body and branch validation**

Parse exactly one `Closes #N` line outside fenced code, exactly one value for every claim field, and branch names matching `^(feat|fix|security|docs)/<N>-[a-z0-9-]+$`. Require normalized PR author, Issue assignee, accountable owner, and claim-receipt actor to match.

- [x] **Step 4: Write live-state gate tests**

Cover a valid review-state Issue; missing/deleted receipt; receipt by the wrong workflow actor; stale/expired claim; wrong assignee; waiting/ready/blocked/done label; multiple status labels; open dependency; PR head after last review; ambiguous closing PR; GitHub timeout; pagination exhaustion; and report/enforce modes.

- [x] **Step 5: Implement fail-closed live validation**

Use the shared API client to fetch the current PR, Issue, comments, dependencies, closing PRs, and repository Actions bot identity. In enforce mode require `status:review`, one assignee matching the PR author, a current successful claim receipt URL from the PR body, and no contradictory release/stale receipt after it. Return structured evidence to the caller without mutating GitHub.

- [x] **Step 6: Add an explicit migration registry**

Use this schema with bounded entries:

```json
{
  "schema_version": 1,
  "activation_commit": null,
  "entries": [
    {
      "pull_request": 45,
      "issue": 7,
      "reason": "Pull request predates AI lifecycle activation",
      "approved_by": "EthanSMC",
      "expires_at": "2026-09-11T00:00:00Z"
    }
  ]
}
```

The validator accepts a migration only in report/pre-activation mode, only for the exact PR/Issue pair, and only before expiry. Strict activation requires `activation_commit` to be a full 40-character commit on `main` and forbids every remaining migration entry.

- [x] **Step 7: Integrate the read-only validator into governance**

Add `issues: read` to governance permissions. Run the lifecycle validator after existing review validation with the same immutable event file, token, repository, run ID, and static result. Keep the job read-only.

- [x] **Step 8: Run the complete governance suite and commit**

Run:

```bash
node --test scripts/github/*.test.mjs
node scripts/github/verify-planning.mjs
git diff --check
```

Expected: PASS.

```bash
git add scripts/github/verify-ai-lifecycle.mjs scripts/github/verify-ai-lifecycle.test.mjs docs/github/ai-lifecycle-migrations.json .github/workflows/governance.yml .github/pull_request_template.md scripts/github/verify-planning.mjs
git commit -m "ci(governance): verify PR claim lifecycle"
```

---

### Task 7: Synchronize labels, dependencies, and existing Issue state

**Files:**
- Modify: `scripts/github/sync-management.mjs`
- Modify: `scripts/github/sync-management.test.mjs`
- Modify: `docs/github/repository-status.md`

**Interfaces:**
- Consumes: all plan task sections, existing marker-linked Issues, current Issue states, and six managed labels.
- Produces: explicit `Blocked by` lines, deterministic task dependency edges, exactly one lifecycle label per governed Issue, and dry-run migration output.

- [x] **Step 1: Write dependency-graph tests**

Test the exact policy:

```js
test("orders tasks within each plan and gates the next stable plan", () => {
  const graph = buildPlanIssueGraph(planDefinitions, existingIssues);
  assert.deepEqual(graph.get(2).blockedBy, [1]);
  assert.deepEqual(graph.get(8).blockedBy, [7]);
  assert.deepEqual(graph.get(15).blockedBy, [14]);
  assert.deepEqual(graph.get(21).blockedBy, [20]);
  assert.deepEqual(graph.get(29).blockedBy, [28]);
});
```

Within a plan, Task N depends on Task N-1. The first task of M1, M2, and M3 depends on the previous stable milestone's final task. The first RTC implementation task after the RTC contract depends on the contract task, while stable M5 qualification depends on the final M3 task and never on experimental RTC.

- [x] **Step 2: Run sync tests and observe failure**

Run: `node --test scripts/github/sync-management.test.mjs`
Expected: FAIL because the graph and lifecycle payload do not exist.

- [x] **Step 3: Build all Issue identities before rendering bodies**

Refactor synchronization into two passes: resolve/create every marker-linked Issue and map `(plan file, task number)` to Issue number; then render bodies with exact dependency numbers. Preserve existing body sections and append exactly one dependency line.

- [x] **Step 4: Derive lifecycle classification without overwriting active work**

For open Issues with no active claim or PR, set `status:ready` only when all dependencies are closed as completed and required fields exist; otherwise set `status:waiting`. Preserve valid `in-progress`, `review`, and `blocked` states. Set closed-completed Issues to `status:done` and remove assignees only after verifying the closing PR or recorded historical state.

- [x] **Step 5: Add dry-run and postcondition verification**

`node scripts/github/sync-management.mjs --dry-run` prints a bounded JSON ledger of intended Issue/label changes and performs no writes. The normal command re-reads all affected Issues and fails if any Issue has multiple status labels, an invalid assignee count, or a rendered dependency mismatch.

- [x] **Step 6: Extend repository status documentation**

Record the lifecycle mode, activation status, labels, workflow/check names, migration entries, last reconciliation timestamp, and live acceptance links. State clearly that this section is evidence, not authority over live GitHub state.

- [x] **Step 7: Run sync and planning tests, then commit**

Run:

```bash
node --test scripts/github/sync-management.test.mjs scripts/github/ai-issue-policy.test.mjs
node scripts/github/verify-planning.mjs
git diff --check
```

Expected: PASS.

```bash
git add scripts/github/sync-management.mjs scripts/github/sync-management.test.mjs docs/github/repository-status.md
git commit -m "feat(governance): synchronize AI issue lifecycle"
```

---

### Task 8: Verify the implementation in report mode and deliver the bootstrap PR

**Files:**
- Modify: `docs/github/repository-status.md`
- Modify: `CHANGELOG.md`
- Test: all files changed by Tasks 1–7

**Interfaces:**
- Consumes: complete implementation branch and GitHub report-mode runs.
- Produces: PR for Issue #46, current review/CI evidence, and a safe activation handoff.

- [x] **Step 1: Run the full local verification matrix**

Run:

```bash
node --test scripts/github/*.test.mjs
node scripts/github/verify-planning.mjs
pnpm check
git diff --check origin/main...HEAD
```

Expected: every command passes; no ignored or untracked artifact is included.

- [x] **Step 2: Run security-focused static inspection**

Confirm the lifecycle workflow checks out only the default branch, never uses `pull_request` head code with `issues: write`, never passes comment text to a shell, and grants no `contents: write`. Search:

```bash
rg -n "pull_request_target|issues: write|contents: write|persist-credentials|github.event.comment.body|checkout" .github/workflows scripts/github
```

Expected: the trusted workflow matches the design, `contents: write` is absent, and comment bodies are read only from parsed event JSON in Node.

- [x] **Step 3: Add changelog and report-mode evidence**

Under `Unreleased`, describe human-accountable AI claims, leases, safe provenance, independent review, closure reconciliation, and report-mode rollout. Record the exact local commands and results in `docs/github/repository-status.md` without local paths or raw logs.

- [x] **Step 4: Commit verification evidence**

```bash
git add CHANGELOG.md docs/github/repository-status.md
git commit -m "docs(governance): record AI lifecycle verification"
```

- [ ] **Step 5: Push and create the bootstrap pull request**

Push `docs/46-ai-issue-lifecycle`. Create one PR with `Closes #46`, exact base/head commit range, current checks URL, test results, risk/rollback, existing review-mode evidence, and an explicit pre-activation migration statement. Do not claim strict lifecycle enforcement is active yet.

- [ ] **Step 6: Obtain independent final review and current-head CI**

Use a reviewer distinct from every implementation agent. Review the complete `origin/main..HEAD` range, fix every finding, rerun the full matrix, then obtain a fresh final PASS. Update the PR body with the exact final commit range and current checks URL. Query GitHub checks independently before merge.

- [ ] **Step 7: Merge and verify bootstrap closure**

Merge only when protected-branch requirements pass. Verify PR merged, Issue #46 closed as completed, merge commit reachable from `origin/main`, report-mode workflow installed, and migration registry/status evidence present.

---

### Task 9: Exercise and activate the live lifecycle

**Files:**
- Modify: `docs/github/ai-lifecycle-migrations.json`
- Modify: `docs/github/repository-status.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: report-mode implementation merged from Task 8.
- Produces: a child activation Issue, disposable live acceptance Issue/PR, strict `AI_LIFECYCLE_MODE=enforce`, activation commit, and end-to-end public evidence.

- [ ] **Step 1: Create and classify the activation Issue**

Create a child Issue titled `[Governance] Activate and prove AI Issue lifecycle`, with `Blocked by #46`, the ten live acceptance cases from Spec section 16.3, exact rollback (`AI_LIFECYCLE_MODE=report`), and no private data. After #46 closes, run synchronization and verify it becomes `status:ready`.

- [ ] **Step 2: Enable command mutations for the acceptance repository**

Set repository variable `AI_LIFECYCLE_MODE=enforce`. Immediately verify the workflow still uses protected `main`; if the first enforce run fails unexpectedly, set the variable back to `report` before any manual state edit.

- [ ] **Step 3: Execute the live command lifecycle**

On a disposable documentation-only Issue, exercise in order: first claim success, competing claim rejection, heartbeat, block, resume, release, fresh claim, and qualifying pull request transition to review. Capture only public GitHub URLs and bounded receipts.

- [ ] **Step 4: Complete independent review, CI, merge, close, and reopen**

Make a harmless documentation change in the disposable PR. Obtain the applicable independent review gate and current-head checks, merge it, verify automatic Issue closure and `status:done`, reopen it, verify unassigned waiting/ready reconciliation, then close it as completed with an explicit acceptance note.

- [ ] **Step 5: Remove bootstrap migrations and set activation commit**

Set `activation_commit` to the exact 40-character protected-main commit containing the active workflow and set `entries` to `[]`. Update repository status with acceptance Issue/PR/workflow URLs and timestamps. Run the strict validator fixtures and live read-only gate.

- [ ] **Step 6: Commit and open the activation PR through the new workflow**

The activation Issue itself must be claimed through `/ai-claim`, use a new `docs/<issue>-activate-ai-lifecycle` branch/worktree, and create a PR whose lifecycle evidence passes strict mode. This proves that the system can govern its own activation change.

- [ ] **Step 7: Verify final closure and repository-wide invariants**

After merge, query every governed Issue and assert exactly one lifecycle label, valid assignee cardinality, dependency/readiness consistency, and no expired active claim. Verify the activation Issue closed, the required `governance` check is green, branch protection remains enabled, and the report-mode rollback remains documented.

- [ ] **Step 8: Record final completion**

Update Issue #46 or the activation Issue with the public acceptance evidence. The objective is complete only after strict mode is live, all tests pass, migration entries are empty, and the repository-wide invariant audit succeeds.

## Plan completion evidence

- Design requirements map to Tasks 1–9 without a deferred subsystem.
- Tasks 1–7 build the contract, policy, API boundary, controller, workflows, live validator, and migration tooling.
- Task 8 proves the complete implementation in safe report mode and merges the bootstrap change.
- Task 9 proves claim concurrency, recovery, review, CI, merge, close/reopen, and strict activation on live GitHub state.
- Rollback remains one repository-variable change to report mode; no lifecycle evidence is deleted.
