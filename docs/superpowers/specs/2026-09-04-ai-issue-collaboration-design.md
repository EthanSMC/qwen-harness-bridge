# AI-Assisted Issue Collaboration Design

**Status:** Approved direction; written specification under review  
**Date:** 2026-09-04  
**Tracking issue:** [#46](https://github.com/EthanSMC/qwen-harness-bridge/issues/46)  
**Scope:** Repository contribution workflow and GitHub governance

## 1. Executive summary

Qwen Harness Bridge will support a GitHub-native collaboration model in which every eligible contributor can use an AI agent to claim an Issue and carry it through implementation, independent review, pull request, CI, merge, Issue closure, cleanup, milestone acceptance, and Release publication.

A named human remains accountable for every claim. AI agents act as traceable executors or reviewers, never as anonymous owners. GitHub Issue state, one managed lifecycle label, one human assignee, immutable workflow receipts, the linked pull request, and required checks form the shared source of truth. Private agent conversations, prompts, logs, credentials, source bodies, and local paths never become public evidence.

The design extends the existing formal-collaborator and solo-maintainer review gates. It does not introduce a separate task database, hosted agent scheduler, or vendor-specific dependency.

## 2. Problem

The repository already requires issue-first development and records detailed AI review evidence in pull requests. It does not yet define how an AI-assisted contributor:

1. determines that an Issue is ready;
2. wins an exclusive claim without racing another agent;
3. exposes useful progress without leaking private execution data;
4. releases, blocks, or hands off unfinished work;
5. proves that implementation and review were independent;
6. connects the claim to the pull request and closing merge; or
7. proves a milestone is ready for a Release.

Without a shared protocol, two agents may duplicate work, abandoned claims may remain invisible, internal execution ledgers may be unavailable to collaborators, and a closed Issue may not prove that the complete engineering gate was followed.

## 3. Goals and non-goals

### 3.1 Goals

- Let every eligible contributor use the AI tool of their choice.
- Keep one named human accountable for each active Issue.
- Make claim ownership exclusive and race-safe through a repository-controlled workflow.
- Make the complete lifecycle observable from public, bounded GitHub evidence.
- Preserve one Issue, one implementation branch, one isolated worktree, and one pull request as the normal unit of change.
- Separate implementation from final review and preserve the existing formal/solo review-mode rules.
- Provide deterministic recovery for stale, blocked, abandoned, and handed-off work.
- Fail closed when lifecycle evidence is missing, contradictory, malformed, stale, or unverifiable.
- Keep the workflow provider-neutral and usable by Codex, other AI agents, or a human working without an agent.
- Make milestone completion and Release publication auditable.

### 3.2 Non-goals

- Running or hosting AI agents inside GitHub Actions.
- Publishing private agent threads, chain-of-thought, prompts, raw logs, source bodies, or local filesystem paths.
- Replacing GitHub Issues, pull requests, checks, milestones, or Releases with a second task system.
- Automatically resolving product or architecture ambiguity.
- Allowing an AI agent to approve its own implementation.
- Guaranteeing uninterrupted execution on a contributor's machine.
- Supporting arbitrary public commenters as trusted claimants. Write-capable repository collaborators are eligible; outside contributors require maintainer assignment before beginning governed work.

## 4. Principles and authority

### 4.1 Human accountability, AI execution

The Issue assignee is the accountable human. The claim receipt records the AI product or agent class used for the work, but the AI agent is not the assignee and does not replace the human's repository permissions or responsibility.

The accountable human owns scope, public progress, safe handling of credentials and private data, the correctness of submitted evidence, and recovery when their agent stops.

### 4.2 GitHub is authoritative

Authority is ordered as follows:

1. GitHub Issue open/closed state is authoritative for terminal completion.
2. The repository-managed lifecycle label is authoritative for the active phase.
3. The single Issue assignee is authoritative for human ownership.
4. Workflow-generated receipt comments are authoritative for claim generation, lease, release, and transition history.
5. The pull request and current-head GitHub checks are authoritative for review and merge readiness.
6. Local branches, worktrees, agent threads, and private ledgers are implementation aids and cannot override GitHub state.

When these sources disagree, automation and agents stop and request maintainer repair. They never infer the most convenient state.

### 4.3 Minimal public provenance

Public evidence records only:

- accountable GitHub user;
- AI product or agent class, such as `codex` or `none`;
- workflow-generated claim identifier;
- Issue, branch, pull request, and commit identifiers already intended for publication;
- bounded progress, verification, findings, and recovery summaries; and
- timestamps generated or verified by GitHub.

Private thread URIs, share links not explicitly approved for publication, model reasoning, prompts, full terminal output, secrets, private repository paths, absolute local paths, and source bodies are prohibited.

## 5. Lifecycle model

For this design, a governed Issue is an open Issue selected for repository work and carrying one managed `type:*` label (`type:feature`, `type:bug`, `type:test`, `type:docs`, or `type:security`). Pull requests, questions, private vulnerability reports, and untriaged discussions are not governed Issues.

Every open implementation Issue has exactly one of these managed labels:

| Label | Meaning | Assignee rule |
|---|---|---|
| `status:ready` | Eligible to be claimed when all readiness rules pass | none |
| `status:in-progress` | Exclusively claimed and under implementation | exactly one |
| `status:review` | A pull request exists and is in CI/review/fix rounds | exactly one |
| `status:blocked` | The owner cannot proceed without a named condition changing | exactly one |
| `status:done` | Derived terminal label for a completed, closed Issue | none |

The allowed transitions are:

```text
draft/unclassified -> ready
ready -> in-progress
in-progress -> review | blocked | ready
blocked -> in-progress | ready
review -> in-progress | blocked | done
done -> ready               # only when GitHub reopens the Issue
```

Invariants:

- At most one managed `status:*` label is present.
- `status:ready` and `status:done` have no assignee.
- `status:in-progress`, `status:review`, and owner-retained `status:blocked` have exactly one assignee.
- A closed Issue has `status:done`; an open Issue never has `status:done`.
- Only the repository lifecycle workflow creates authoritative transition receipts.
- Manual label or assignee edits that violate an invariant block new claims and pull-request merge readiness until repaired.

## 6. Readiness and dependencies

An Issue is claimable only when all of the following are true:

- it is open and is not a pull request;
- it has `status:ready` and no other managed lifecycle label;
- it has no assignee;
- its outcome, verification commands, risk/rollback expectations, and definition of done are present;
- every declared `Blocked by #N` dependency is closed as completed;
- no open pull request already declares `Closes #N`; and
- the claimant is a direct collaborator with `write`, `maintain`, or `admin` permission.

An Issue that lacks sufficient requirements stays unclassified or receives `status:blocked`; an AI agent must not invent missing product scope merely to make it claimable.

Dependencies use one canonical, machine-readable line per Issue:

```text
Blocked by #12, #19
```

`Blocked by none` is explicit when an implementation Issue has no dependencies.

## 7. Exclusive claim protocol

### 7.1 Command

An eligible contributor or their AI posts a bounded command comment:

```text
/ai-claim
agent: codex
```

`agent` is a lowercase provider-neutral identifier matching `[a-z0-9][a-z0-9._-]{0,31}`. `none` represents a human-only implementation. No thread URL or local path is accepted.

### 7.2 Serialized decision

The `issue_comment` workflow handles claim commands with per-Issue concurrency and `cancel-in-progress: false`. It checks the live Issue, all readiness rules, current assignees, labels, open closing pull requests, and the comment author's current repository permission. The workflow never checks out contributor-controlled code and uses only the default branch implementation.

If eligible, the workflow performs and verifies this transition:

1. replace `status:ready` with `status:in-progress`;
2. assign exactly the command author;
3. create a claim receipt with a random identifier, agent identifier, GitHub actor, Issue number, claim time, and lease deadline;
4. re-read the Issue and receipt; and
5. report success only if the postconditions hold.

If the postconditions do not hold, it creates a bounded failure receipt and fails closed. A claimant starts work only after the success receipt exists. Comment creation order alone is not a claim; only the workflow receipt is authoritative.

### 7.3 Claim lease and heartbeat

An active claim has a 24-hour renewable lease. Meaningful public activity on the linked branch or pull request does not silently renew it because branch activity may not explain the state of the Issue. The owner or their AI renews explicitly:

```text
/ai-heartbeat
summary: protocol schema implemented; integration tests remain
```

The summary is required, is limited to 240 UTF-8 bytes, and must contain no private execution material. The workflow verifies ownership and extends the lease from GitHub server time.

A scheduled hourly reconciliation releases an expired `status:in-progress` claim by removing the assignee, restoring `status:ready`, and writing a stale-release receipt. It does not automatically release `status:review` or `status:blocked`; those states require an explicit resolution because a pull request or external dependency may still exist.

## 8. Local execution contract

After a successful claim, the implementing AI must:

1. update from current `origin/main`;
2. create `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `security/<issue>-<slug>`, or `docs/<issue>-<slug>`;
3. use an isolated Git worktree unless the environment itself already provides an isolated worktree;
4. inspect repository instructions, the Issue, linked specification/plan, dependencies, and consumed interfaces;
5. record a small execution plan in the agent task, while keeping private reasoning out of GitHub;
6. use test-first development for behavior changes;
7. preserve unrelated user changes and avoid shared-file parallel writes;
8. commit only coherent, verified changes with Conventional Commits; and
9. keep the Issue lease current until a pull request moves it to review.

Each claim produces exactly one implementation branch and one pull request. Splitting the work requires maintainer approval and separate child Issues before implementation diverges.

## 9. Blocking, release, and handoff

### 9.1 Block

The owner records a genuine blocker with:

```text
/ai-block
reason: staging credential is unavailable
resume-when: repository owner provisions the documented test credential
```

Both fields are required and bounded to 240 UTF-8 bytes. The workflow changes the label to `status:blocked`, retains the owner, and creates a receipt. Difficulty, failing tests, or desired clarification that can be resolved from repository evidence are not blockers.

### 9.2 Resume

The owner uses `/ai-resume` after verifying the recovery condition. The workflow returns the Issue to `status:in-progress`, renews the lease, and records a receipt.

### 9.3 Release

The owner or a maintainer uses:

```text
/ai-release
reason: implementation is being abandoned; no pull request is open
```

Release is allowed only when no open pull request declares it will close the Issue, or after that pull request is closed. It removes the assignee, restores `status:ready`, invalidates the current lease, and records the reason.

### 9.4 Handoff

Handoff is deliberately two-phase. The current owner releases the Issue with a bounded summary and a public branch or pull-request reference when one exists. The receiving contributor then issues a fresh `/ai-claim`. Direct reassignment is not authoritative because it would transfer responsibility without recipient acceptance.

## 10. Pull request and review loop

A pull request for governed work must:

- use a supported branch name containing the Issue number;
- contain `Closes #N` for exactly one primary Issue;
- be authored by the current accountable Issue owner;
- include the workflow-generated claim identifier and the public claim receipt URL;
- identify the implementer agent class without including a private session link;
- include the exact base and head commits, observed verification results, risk, compatibility, migration, privacy/security effect, and rollback path; and
- complete the existing review-mode evidence.

When a qualifying pull request opens, the lifecycle workflow moves the Issue from `status:in-progress` to `status:review`. Draft pull requests are allowed, but they do not weaken evidence requirements.

The implementer and final reviewer must be distinct. Review follows the existing two-path gate:

1. a distinct eligible collaborator provides a formal GitHub approval when available; or
2. a fresh independent review agent returns PASS on the exact current commit range when no eligible collaborator exists.

A review finding returns work to the implementation/fix loop without creating a new claim. Every fix invalidates stale approval, and the final reviewer examines the complete final range. Merge readiness requires all required current-head checks to succeed, all review conversations to be resolved, the Issue/claim/PR invariants to hold, and the final review verdict to be valid for the current head.

## 11. Merge, closure, and cleanup

The controller merges only through the protected `main` branch after independently querying required checks and review state. It then verifies:

1. the pull request is merged into `main`;
2. the primary Issue closed as completed through `Closes #N`;
3. the closing commit is reachable from current `origin/main`;
4. the lifecycle workflow removed the assignee and replaced the active label with `status:done`;
5. acceptance evidence required by the Issue is present; and
6. the implementation branch and disposable worktree are removed after their commits are recoverable from `main`.

Failure of any postcondition is a lifecycle failure, not a successful close. Automation records the mismatch and requires repair; it does not silently mark the work complete.

If a completed Issue is reopened, the workflow removes `status:done`, applies `status:ready`, and leaves it unassigned. A new claim generation is required.

## 12. Milestone and Release closure

A version is releasable only when:

- every Issue in the milestone is closed as completed and has terminal lifecycle evidence;
- no open pull request targets milestone work;
- the version acceptance document contains the required commands, commit SHA, timestamp, and observed results;
- the complete required CI, security, compatibility, migration, and rollback gates pass on the release commit;
- `CHANGELOG.md`, package versions, protocol compatibility declarations, and migrations are synchronized;
- the previous rollback-compatible artifact is accessible; and
- the Git tag and GitHub Release are created from the verified protected-branch commit.

After publication, the controller verifies the tag target, Release state, artifact checksums, and milestone closure. Experimental RTC release work remains isolated from stable-path qualification as defined by the product plans.

## 13. Repository components

Implementation adds or updates these bounded components:

- `AGENTS.md`: canonical instructions for any AI or human executor entering the repository.
- `CONTRIBUTING.md`: contributor-facing lifecycle, commands, responsibility, review, and recovery rules.
- `README.md`: concise workflow overview and links to the authoritative documents.
- `.github/ISSUE_TEMPLATE/implementation.yml` and `bug.yml`: outcome, dependencies, verification, readiness, and AI-safe evidence fields.
- `.github/pull_request_template.md`: claim receipt, accountable owner, agent class, lifecycle, review, and closure evidence.
- `.github/labels.yml`: the five mutually exclusive lifecycle labels.
- `.github/workflows/ai-issue-lifecycle.yml`: serialized commands, scheduled expiry, pull-request transitions, close/reopen reconciliation, and receipts.
- `.github/workflows/governance.yml`: read-only lifecycle validation as a required pull-request gate.
- `scripts/github/issue-lifecycle.mjs`: strict command parsing, transition policy, GitHub adapter boundary, and reconciliation logic.
- `scripts/github/verify-ai-lifecycle.mjs`: fail-closed live Issue/claim/PR validation.
- focused Node tests and fixtures for both scripts.
- `scripts/github/sync-management.mjs`: managed-label synchronization and branch-protection check registration.
- `docs/github/ai-collaboration.md`: examples and troubleshooting without duplicating normative rules.
- `docs/github/repository-status.md`: live activation and acceptance evidence.

The lifecycle policy lives in testable JavaScript modules. Workflow YAML supplies events, least-privilege tokens, and concurrency but does not duplicate state-machine decisions.

## 14. Security and abuse resistance

- Claim commands are parsed as data and are never passed to a shell.
- Fields have strict names, character sets, and UTF-8 byte limits; unknown or duplicate fields are rejected.
- Actor permission, Issue state, labels, assignees, closing pull requests, reviews, and checks are fetched live from GitHub.
- The write-capable Issue workflow always runs trusted code from the protected default branch and never checks out a pull request head or fork.
- Tokens use least privilege: `issues: write`, `pull-requests: read`, and `contents: read` only where required.
- Pull-request code runs only with read permissions and cannot mutate claims.
- Workflow receipts include stable machine markers but no reusable credential or private agent identifier.
- Duplicate deliveries are idempotent by event/comment ID and claim generation.
- Pagination is complete and bounded; malformed or truncated external state fails closed.
- Manual state edits, deleted receipts, ambiguous closing keywords, multiple assignees, multiple lifecycle labels, or stale evidence block merge.
- Maintainer repair actions create explicit audit receipts.

## 15. Error handling

Every rejected command receives one bounded public explanation and one safe next action. Stable error classes include:

- `NOT_ELIGIBLE`
- `NOT_READY`
- `ALREADY_CLAIMED`
- `DEPENDENCY_OPEN`
- `CLOSING_PR_EXISTS`
- `NOT_OWNER`
- `INVALID_COMMAND`
- `INVALID_TRANSITION`
- `LEASE_EXPIRED`
- `STATE_MISMATCH`
- `GITHUB_STATE_UNAVAILABLE`

GitHub API timeouts, permission ambiguity, pagination exhaustion, and post-write verification failures do not become success. Retryable deliveries are idempotent; uncertain writes are reconciled from live state before another mutation.

## 16. Verification strategy

### 16.1 Unit and property tests

- Strict parsing for every valid command and malformed/oversized/duplicate/unknown field.
- Every allowed and forbidden state transition.
- Assignee, label, Issue-state, dependency, claim-generation, and lease invariants.
- Idempotent replay and deterministic handling of concurrent claim events.
- Permission eligibility and owner/maintainer authorization.
- PR closing-keyword parsing without false positives from prose or code blocks.
- Review invalidation after a new head commit.
- Redaction and rejection of prohibited public evidence.

### 16.2 Adapter and workflow tests

- Fake GitHub API fixtures for pagination, timeout, malformed records, partial writes, retries, and post-write mismatch.
- Static checks for event triggers, per-Issue concurrency, default-branch trust, and least-privilege workflow permissions.
- Governance fixtures for valid formal review, valid solo review, missing claim, wrong assignee, stale lease, multiple labels, open dependency, mismatched commit range, and failed current-head checks.

### 16.3 Live acceptance

A disposable public test Issue demonstrates:

1. readiness and first successful claim;
2. rejection of a competing claim;
3. heartbeat renewal;
4. block and resume;
5. release and fresh claim generation;
6. pull-request transition to review;
7. independent review and successful required checks;
8. merge-driven automatic closure;
9. terminal label/assignee reconciliation; and
10. reopen returning the Issue to unassigned ready state.

The test Issue and pull request contain only synthetic documentation changes and remain available as public evidence.

## 17. Acceptance criteria

The design is complete when all of the following are proven on the protected default branch:

1. `AGENTS.md` lets a new AI agent determine the whole lifecycle without private context.
2. Every managed implementation Issue has exactly one valid lifecycle state.
3. Only an eligible, unassigned, dependency-clear Issue can be claimed.
4. Two concurrent claim attempts yield exactly one authoritative success.
5. The successful claim has one accountable human and safe agent provenance.
6. Heartbeat, block, resume, release, stale expiry, and handoff paths are deterministic and audited.
7. A pull request cannot pass governance without a valid current claim and matching accountable author.
8. Final review is independent and valid for the current head.
9. Required CI is queried live and passes before merge.
10. Merge closes exactly the intended primary Issue and produces terminal reconciliation evidence.
11. Reopening produces a fresh, unassigned ready lifecycle.
12. Milestone and Release evidence proves every required Issue and gate is complete.
13. Tests cover success, race, replay, malformed input, permission failure, external-state failure, and manual-drift cases.
14. Public evidence contains none of the prohibited private material.
15. Existing product, security, formal-review, and solo-review invariants remain enforced.

## 18. Rollout

Rollout is fail-closed and staged:

1. land documentation, labels, pure policy modules, tests, and read-only validation;
2. synchronize managed labels and classify existing open Issues as `status:ready` or `status:blocked` from explicit dependency evidence;
3. enable command handling and scheduled reconciliation;
4. run the disposable live acceptance lifecycle;
5. make lifecycle validation a required `governance` dependency; and
6. record activation evidence in `docs/github/repository-status.md`.

Existing closed Issues remain historical and do not require synthetic claim receipts. Existing open pull requests receive a documented one-time migration receipt or must re-enter the lifecycle from `status:ready`; the validator never fabricates prior evidence.
