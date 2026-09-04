# AI-Assisted Issue Collaboration

This repository lets every eligible contributor use the AI tool of their choice while keeping one named human accountable for each active Issue. GitHub—not a local agent thread—is the shared source of truth.

The normative design is [AI-Assisted Issue Collaboration Design](../superpowers/specs/2026-09-04-ai-issue-collaboration-design.md). This guide explains the contributor workflow.

## Lifecycle

| State | Meaning | Assignee |
|---|---|---|
| `status:waiting` | Requirements or declared dependencies are not ready | none |
| `status:ready` | Ready for one eligible contributor to claim | none |
| `status:in-progress` | Exclusively claimed and under implementation | exactly one |
| `status:review` | Pull request is in CI, review, or fix rounds | exactly one |
| `status:blocked` | Claimed work awaits a named external condition | exactly one |
| `status:done` | Completed closed Issue | none |

An Issue may carry only one managed `status:*` label. Manual label or assignee edits that violate this table stop the workflow until a maintainer repairs the state.
Every governed Issue also carries exactly one managed work type: `type:feature`, `type:bug`, `type:test`, `type:docs`, or `type:security`. Untyped Issues are ignored; multiple managed types fail closed.

## Readiness

An Issue can be claimed only when it:

- is open and has `status:ready`;
- has no assignee;
- declares `Blocked by none` or lists only dependencies closed as completed;
- contains an outcome, verification commands/results, risk and rollback, and definition of done;
- has no open pull request that already closes it; and
- is claimed by a direct collaborator with write, maintain, or admin permission.

Outside contributors may propose changes, but a maintainer must first assign and classify the work before it enters this governed lifecycle.

The dependency declaration is limited to 512 UTF-8 bytes and 20 unique Issue numbers. Dependency reads use a four-request worker pool, so a public Issue cannot create an unbounded authenticated request burst.

## Claim

Post this as an Issue comment:

```text
/ai-claim
agent: codex
```

`agent` is a safe lowercase class such as `codex`, `claude-code`, `copilot`, `gemini-cli`, `other`, or `none`. Do not include a thread URL, prompt, local path, or log.

Repository automation serializes commands per Issue, verifies live GitHub state and permissions, assigns the human commenter, changes the label to `status:in-progress`, and writes a versioned claim receipt. Each run drains every unprocessed `/ai-*` comment in immutable comment-ID order; the hourly run performs a repository-wide recovery drain. A superseded pending workflow run therefore cannot silently discard a command. Work starts only after the success receipt appears. A competing claim receives `ALREADY_CLAIMED` and must not start.

Claims expire after 24 hours without an explicit heartbeat. Lease deadlines are calculated from the verified GitHub comment timestamp; scheduled expiry and migration checks use the GitHub API `Date` header, not runner-local time.

## Work and heartbeat

Start from current `origin/main` in an isolated worktree. Use exactly one supported branch:

```text
feat/<issue>-<slug>
fix/<issue>-<slug>
security/<issue>-<slug>
docs/<issue>-<slug>
```

Keep public progress bounded and useful:

```text
/ai-heartbeat
summary: claim parser and state tests pass; controller integration remains
```

The summary is a single line of at most 240 UTF-8 bytes. It renews the lease for 24 hours in either `status:in-progress` or `status:review` without changing the lifecycle state. Branch pushes do not renew the lease implicitly. Review work is not automatically released when a lease expires, but the expired lease blocks merge until the owner renews it.

## Block, resume, release, and handoff

Use a blocker only when work cannot continue until a specific external condition changes:

```text
/ai-block
reason: staging credential is unavailable
resume-when: repository owner provisions the documented test credential
```

After verifying recovery, the owner posts:

```text
/ai-resume
```

To abandon work, close any primary pull request and post:

```text
/ai-release
reason: implementation is being abandoned; no pull request is open
```

Release removes the assignee and returns the Issue to `status:ready` when readiness passes or `status:waiting` otherwise. Handoff is deliberately two-step: the current owner releases with a bounded summary and public branch/PR reference, then the recipient creates a fresh claim. Direct reassignment is not an accepted handoff.

## Implementation and review

One claim produces one implementation branch and one primary pull request. Split oversized work into approved child Issues before implementation diverges.

Behavior changes follow red-green-refactor. Commits are small, coherent, verified, and use Conventional Commits. The pull request must identify:

- exactly one `Closes #N` primary Issue;
- the public claim receipt URL;
- the matching accountable human and PR author;
- a safe implementer agent class;
- exact base/head range and observed verification;
- security, privacy, protocol, migration, compatibility, and rollback effects; and
- the existing formal or solo independent-review evidence.

Opening a qualifying pull request moves the Issue to `status:review`. The reviewer must differ from the implementer and review the complete final range. Findings return to a fix loop. Every push invalidates stale review evidence; a fresh PASS and successful current-head checks are required.

## Merge and close

Protected `main` is the only merge target. Before merge, the controller independently verifies the current checks, review state, Issue owner, claim receipt, branch, and lifecycle state.

Rollout uses two independent repository variables. `AI_LIFECYCLE_MUTATION_MODE` controls Issue/receipt writes; `AI_LIFECYCLE_VALIDATION_MODE` controls the read-only PR merge gate. Both default to `report`.

Mutation enforcement is allowed only during the versioned registry's bounded `mutation_acceptance` window or after formal activation. Validation stays in `report` during live acceptance. Formal activation requires a full activation commit reachable from `main`, `mutation_acceptance: null`, and no migration entries; only then may validation change to `enforce`. Rollback sets either variable back to `report` without deleting receipts.

After merge, verify all of these outcomes:

1. the primary pull request is merged into `main`;
2. `Closes #N` closed exactly the intended Issue as completed;
3. the PR names the current claim receipt, its merge occurs after that claim, the Issue closes after the merge, no closing PR remains open, and the merge commit is an ancestor of current `main`;
4. the Issue has `status:done` and no assignee;
5. required acceptance evidence is current; and
6. the implementation branch and disposable worktree are removed only after recovery from `main` is proven.

Reopening a completed Issue removes `status:done`, leaves it unassigned, and recalculates `status:ready` or `status:waiting`. A new claim is required.

## Release closure

A milestone Release requires every milestone Issue closed with valid terminal evidence, no open milestone pull request, current acceptance results, successful security/compatibility/migration/rollback gates, synchronized changelog and versions, an available rollback-compatible artifact, and a tag/Release created from the verified protected-branch commit.

## Safe public evidence

Allowed evidence includes GitHub users, Issue/PR/commit/check URLs, safe agent classes, workflow-generated claim identifiers, bounded progress, observed command results, findings, and rollback summaries.

Never publish credentials, environment values, private agent/session links, prompts, chain-of-thought, raw/full logs, source bodies, private paths, or absolute local paths. If useful proof cannot be made public safely, record only a redacted result and ask a maintainer to verify the private evidence out of band.

## Stable failures

The workflow fails closed with one safe next action. Common codes are:

- `NOT_ELIGIBLE`: ask a maintainer to assign/classify the work.
- `NOT_READY`: complete requirements or wait for dependencies.
- `ALREADY_CLAIMED`: choose another ready Issue.
- `DEPENDENCY_OPEN`: finish the named dependency.
- `CLOSING_PR_EXISTS`: continue or close the existing pull request.
- `NOT_OWNER`: ask the current owner or a maintainer.
- `LEASE_EXPIRED`: claim again if the Issue returned to ready.
- `STATE_MISMATCH`: stop and ask a maintainer to repair labels/assignees.
- `GITHUB_STATE_UNAVAILABLE`: retry after GitHub state can be verified.
