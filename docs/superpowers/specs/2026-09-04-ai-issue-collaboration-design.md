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
4. Workflow-generated v2 receipt comments are authoritative for claim generation, lease, exact pull-request binding, release, and transition history.
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
| `status:waiting` | Requirements or declared dependencies are not yet ready | none |
| `status:ready` | Eligible to be claimed when all readiness rules pass | none |
| `status:in-progress` | Exclusively claimed and under implementation | exactly one |
| `status:review` | A pull request exists and is in CI/review/fix rounds | exactly one |
| `status:blocked` | The owner cannot proceed without a named condition changing | exactly one |
| `status:done` | Derived terminal label for a completed, closed Issue | none |

The allowed transitions are:

```text
draft/unclassified -> waiting | ready
waiting -> ready
ready -> in-progress
in-progress -> review | blocked | ready
blocked -> in-progress | ready
review -> in-progress | blocked | done
done -> waiting | ready      # only when GitHub reopens the Issue
```

Invariants:

- Exactly one managed work `type:*` and exactly one managed `status:*` label are present after initialization.
- `status:waiting`, `status:ready`, and `status:done` have no assignee.
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

An Issue that lacks sufficient requirements or has open dependencies receives `status:waiting`; an AI agent must not invent missing product scope merely to make it claimable. `status:blocked` is reserved for claimed work whose accountable owner encountered a specific external blocking condition.

On Issue creation, the lifecycle workflow evaluates the same readiness rules and initializes the Issue to `status:ready` or `status:waiting` without an assignee. A later Issue-body edit refreshes only unclaimed `waiting`/`ready` work. It never silently rewrites an active claim; active dependency or scope changes require the accountable owner and reviewer to reconcile the public evidence.

Dependencies use one canonical, machine-readable line per Issue:

```text
Blocked by #12, #19
```

`Blocked by none` is explicit when an implementation Issue has no dependencies.
The declaration is bounded to 512 UTF-8 bytes and at most 20 unique, non-self Issue references. The controller hydrates dependencies through a four-request worker pool and ignores untyped Issues before hydration.

## 7. Exclusive claim protocol

### 7.1 Command

An eligible contributor or their AI posts a bounded command comment:

```text
/ai-claim
agent: codex
```

`agent` is a lowercase provider-neutral identifier matching `[a-z0-9][a-z0-9._-]{0,31}`. `none` represents a human-only implementation. No thread URL or local path is accepted.

### 7.2 Durable serialized decision

The lifecycle workflow uses one repository-wide concurrency group with `cancel-in-progress: false`, so Issue comments, Issue changes, pull-request events, and scheduled repair cannot mutate the same Issue concurrently. GitHub may replace an older pending run even when cancellation is disabled, so concurrency alone is not a queue. Every surviving event run and the hourly recovery run inspect at most the 1,000 most recent repository comments, exclude pull-request comments before backlog accounting, and process the oldest bounded batch of pending Issue commands. Processing re-reads the command's bounded Issue history, so a replay observes the durable workflow receipt or rejection marker. Pull-request and Issue reconciliation use deterministic system event IDs and converge from current live state, including reconstruction of a missed PR-open transition when the final merge is already verifiable.

The controller checks the live Issue, all readiness rules, current assignees, labels, open closing pull requests, and the comment author's current repository permission. The workflow never checks out contributor-controlled code and uses only the default branch implementation.

If eligible, the workflow performs and verifies this transition:

1. replace `status:ready` with `status:in-progress`;
2. assign exactly the command author;
3. create a claim receipt with a random identifier, agent identifier, GitHub actor, Issue number, GitHub-verified comment time, and lease deadline;
4. re-read the Issue and receipt; and
5. report success only if the postconditions hold.

If the postconditions do not hold, it creates a bounded failure receipt and fails closed. A claimant starts work only after the success receipt exists. Comment creation order alone is not a claim; only the workflow receipt is authoritative.

### 7.3 Claim lease and heartbeat

An active implementation claim has a 24-hour renewable lease. Meaningful public activity on the linked branch or pull request does not silently renew it because branch activity may not explain the state of the Issue. While the Issue is `status:in-progress`, the owner or their AI renews explicitly:

```text
/ai-heartbeat
summary: protocol schema implemented; integration tests remain
```

The summary is required, is limited to 240 UTF-8 bytes, and must contain no private execution material. The workflow verifies ownership and extends the lease to the later of the immutable command-comment timestamp plus 24 hours or the prior lease plus one second. This preserves strict receipt ordering when GitHub gives multiple commands the same second. Scheduled expiry and migration decisions use the GitHub response `Date` header, never the runner's local clock.

A scheduled hourly reconciliation releases an expired `status:in-progress` claim by removing the assignee, restoring `status:ready` when readiness still passes or `status:waiting` otherwise, and writing a stale-release receipt. A qualifying pull request must have been created after the claim and strictly before this implementation deadline. Its verified `pr-open` transition replaces the deadline with a durable review lock, so required checks do not become stale merely because wall-clock time advances and `/ai-heartbeat` is rejected in `status:review`. Closing the pull request unmerged returns to `status:in-progress` with a fresh 24-hour lease. `status:blocked` still requires explicit resolution because an external dependency exists.

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

Release is allowed only when no open pull request declares it will close the Issue, or after that pull request is closed. It removes the assignee, restores `status:ready` when readiness still passes or `status:waiting` otherwise, invalidates the current lease, and records the reason.

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

When a pull request enters its current qualifying form strictly within the implementation lease, the lifecycle workflow moves the Issue from `status:in-progress` to `status:review` and records a durable review-admission receipt with no expiry and the exact pull-request number. A matching original `opened` event uses immutable GitHub `created_at`; edited, reopened, or scheduled admission uses the live-matching GitHub `updated_at`. Every later transition first recovers one semantically matching workflow-authored pending intent bound to the current claim generation. Ambiguity fails closed; if a successful receipt already intervened, a failure receipt durably supersedes the stale intent without replaying its mutation. Receipt reconstruction independently rejects a claim-bound state that does not follow its predecessor, any block that changes its lease, and any heartbeat or resume that does not advance the active lease. That claim generation remains bound to the same primary pull request across close/reopen recovery; a different PR requires release and a fresh claim. Draft pull requests are allowed, but they do not weaken evidence requirements.

The implementer and final reviewer must be distinct. Review follows the existing two-path gate:

1. a distinct eligible collaborator provides a formal GitHub approval when available; or
2. a fresh independent review agent returns PASS on the exact current commit range when no eligible collaborator exists.

A review finding returns work to the implementation/fix loop without creating a new claim. Every fix invalidates stale approval, and the final reviewer examines the complete final range. Merge readiness requires all required current-head checks to succeed, all review conversations to be resolved, the Issue/claim/PR invariants to hold, and the final review verdict to be valid for the current head.

## 11. Merge, closure, and cleanup

The required read-only merge gate permits merge only through the protected `main` branch after independently querying required checks and review state. The lifecycle controller then verifies:

1. the pull request names the current claim receipt and is authored by that claim's owner;
2. the pull request is merged into `main` after the current claim began;
3. the primary Issue closed as completed after that merge, no closing pull request remains open, and the merge commit is an ancestor of current `main`;
4. the lifecycle workflow removed the assignee and replaced the active label with `status:done`;
5. acceptance evidence required by the Issue is present; and
6. the implementation branch and disposable worktree are removed after their commits are recoverable from `main`.

Failure of any postcondition is a lifecycle failure, not a successful close. Automation records the mismatch and requires repair; it does not silently mark the work complete.

If a completed Issue is reopened, the workflow removes `status:done`, reapplies `status:ready` or `status:waiting` from live readiness, and leaves it unassigned. A new claim generation is required.

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
- `.github/labels.yml`: the six mutually exclusive lifecycle labels.
- `.github/workflows/ai-issue-lifecycle.yml`: repository-wide mutation serialization, bounded command draining, scheduled expiry, pull-request transitions, close/reopen reconciliation, and receipts.
- `.github/workflows/governance.yml`: read-only lifecycle validation as a required pull-request gate.
- `scripts/github/ai-issue-policy.mjs` and `ai-issue-controller.mjs`: strict command parsing, transition policy, trusted GitHub adapter boundary, and reconciliation logic.
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
- Non-idempotent POST requests are never replayed after an uncertain response; the controller performs bounded live reads and accepts identical duplicate intent markers while rejecting conflicting ones.
- Complete state reads use bounded pagination and fail closed if truncated; repository command recovery deliberately inspects a documented 1,000-comment window and replays each selected command against its complete bounded Issue history.
- Every REST request has a hard deadline.
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

GitHub API timeouts, permission ambiguity, pagination exhaustion, and post-write verification failures do not become success. Naturally idempotent mutations may be retried only after bounded postcondition reads. A POST is never automatically repeated; later event delivery reconciles its stable intent from live state.

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
- Static checks for event triggers, repository-wide concurrency, default-branch trust, and least-privilege workflow permissions.
- Governance fixtures for valid formal review, valid solo review, missing claim, wrong assignee, missing review admission, multiple labels, open dependency, mismatched commit range, and failed current-head checks.

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

1. land documentation, labels, pure policy modules, tests, and read-only validation with both rollout variables defaulting to `report`;
2. synchronize managed labels and classify existing open Issues as `status:ready` or `status:waiting` from explicit dependency evidence;
3. enable `AI_LIFECYCLE_MUTATION_MODE=enforce` only inside the registry's bounded `mutation_acceptance` window while `AI_LIFECYCLE_VALIDATION_MODE=report`;
4. run the disposable live acceptance lifecycle;
5. merge a registry change that removes every migration, clears `mutation_acceptance`, and records a full protected-`main` activation commit;
6. set both mutation and validation modes to `enforce`; and
7. record activation evidence in `docs/github/repository-status.md`.

Existing closed Issues do not require synthetic claim receipts. Repository-wide reconciliation reports and skips only an exact entry in the activation-bound historical-exemption registry whose Issue number, `closed_at`, and expected legacy lifecycle status still match, whose current shape is closed as completed with exactly one managed type, and whose complete comment history contains no workflow lifecycle receipt. The registry records `status:done` for seven completed implementation Issues synchronized before activation and null status for five auxiliary records. Any missing entry, changed close timestamp, close reason or status, prior receipt, or malformed type/state is processed normally and fails closed. Outside this exact compatibility registry, synchronization accepts `status:done` only after finding a final terminal receipt, exactly one claim-bound merged closing pull request, valid close-after-merge chronology, and a merge commit reachable from `main`. A prior closed-unmerged PR remains valid history only when the same claim generation contains its exact `pr-open` and `pr-close` receipts followed by a release or expiry. Existing open pull requests receive a documented one-time migration receipt or must re-enter the lifecycle from `status:ready`; migrations are honored only while activation is null and are never accepted afterward, even in report mode.
