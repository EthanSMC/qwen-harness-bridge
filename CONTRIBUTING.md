# Contributing

This is a public, issue-driven repository. The approved Spec and linked implementation plan are authoritative for scope.

## Start work

Every contributor may use an AI agent, but the named human Issue assignee remains accountable. GitHub Issue state, one lifecycle label, one assignee where required, workflow receipts, the linked pull request, and current-head checks are authoritative. Private agent threads and local execution records are not shared state.

1. Select an open `status:ready` Issue with exactly one managed `type:*`, no assignee, no open declared dependency, and no open closing pull request.
2. Read [AGENTS.md](AGENTS.md), [the AI collaboration guide](docs/github/ai-collaboration.md), the Issue's linked plan task, and every interface it consumes.
3. Post `/ai-claim` with a safe agent class and wait for the repository workflow's success receipt. A command comment alone does not grant ownership.
4. From current `origin/main`, create `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `security/<issue>-<slug>`, or `docs/<issue>-<slug>` in an isolated worktree.
5. Follow the task's red-green-refactor sequence and exact verification commands. Renew the 24-hour implementation lease with a bounded `/ai-heartbeat` until the pull request enters review.
6. Commit the smallest coherent green change using Conventional Commits.
7. Open one primary pull request with `Closes #<issue>`, the claim receipt, matching accountable owner, safe agent class, Spec/plan link, test evidence, risk, migration/protocol/privacy impact, and rollback notes.
8. Complete an independent review/fix loop and current-head CI. After merge, verify Issue closure, terminal reconciliation, and safe branch/worktree cleanup.

Use `/ai-block`, `/ai-resume`, and `/ai-release` exactly as documented. A handoff is a release followed by a fresh claim from the recipient; do not transfer responsibility through an unverified manual reassignment.

## Required engineering rules

- TypeScript uses strict mode and Zod at every untrusted runtime boundary.
- PostgreSQL is authoritative for cross-device product state. Connector SQLite is authoritative for local receipt/outbox and Harness mappings.
- Never add a public Harness or arbitrary-shell endpoint.
- Use configured repository IDs and canonical paths; never accept paths from glasses input.
- Preserve terminal-state immutability, one-time approval, idempotency, and optimistic revision checks.
- Keep logs, UI, speech, metrics, test fixtures, and issue evidence free of credentials, raw prompts, source bodies, absolute local paths, and full terminal logs.
- Keep public GitHub evidence free of private AI thread/share links and model reasoning. Record only the agent class and workflow-generated claim identifier.
- Stable behavior must pass with `QHB_RTC_ENABLED=false`. RTC changes include an explicit stable-regression test.
- Protocol or architecture changes require an ADR and an update to the approved Spec before implementation.

## Pull request gate

A pull request is ready only when:

- Its author, primary Issue assignee, accountable-owner field, and verified claim actor match.
- Its branch contains the primary Issue number and the body contains exactly one `Closes #<issue>`.
- The primary Issue is in `status:review` with a live, unreleased claim generation and a durable `pr-open` review-admission receipt created before its implementation lease expired.
- The linked issue's checkboxes and definition of done are satisfied.
- Relevant unit, contract, integration, security, build, and document checks pass.
- A Changeset is present for user-visible package behavior, unless the change is docs/tests only.
- Protocol compatibility, database migration, security/privacy effect, and rollback path are explicit.
- Acceptance evidence is updated when the issue closes a release gate.

Review is a two-path gate:

- When a distinct eligible direct GitHub collaborator is available, the pull request requires a formal GitHub Approve from that collaborator.
- When no distinct eligible direct GitHub collaborator exists, the merge gate is a PASS from a fresh independent subagent reviewer plus success of all required GitHub checks, regardless of repository visibility. This solo fallback does not apply once a distinct eligible collaborator is available.

For either path, the reviewer must be different from the implementer, review the complete diff and commit range, and record the reviewer type and identity, findings, fix rounds, final verdict, and verification evidence. The author must not self-approve or fabricate review evidence.

The management sync queries direct collaborators before applying main-branch protection. It excludes the repository owner and selects formal mode only when another distinct collaborator has `admin`, `maintain`, or `push` role/permission; formal mode requires one approval, stale-review dismissal, and approval after the last push. With no such collaborator, it selects the documented solo mode regardless of repository visibility and applies no formal pull-request review requirement. Re-run the collaborator and PR review-state checks immediately before changing or relying on the selected mode, and treat any collaborator membership, role, or permission change as a re-verification trigger.

The pull-request body validator only verifies the selected evidence mode and the current PR checks URL. Before merging, the controller must independently query the GitHub checks API and confirm all required checks succeeded; the body evidence URL is not itself a CI result. The initial PR creation run may fail because the PR number is not known when the body is authored; edit the body immediately with the current PR checks URL and require the final `governance` gate to be green.

After merge, the controller verifies the intended Issue closed as completed, the merge is reachable from `main`, terminal `status:done` reconciliation succeeded, the assignee was removed, and required acceptance evidence is current. A milestone is releasable only after every Issue and Release gate has equivalent terminal evidence.

Do not mix stable-path and RTC behavior in one pull request unless the change is a shared interface and stable tests pass with RTC disabled.
