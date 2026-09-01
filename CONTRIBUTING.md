# Contributing

This is a private, issue-driven repository. The approved Spec and linked implementation plan are authoritative for scope.

## Start work

1. Select an unblocked issue from the current milestone.
2. Read the issue's linked plan task and every interface it consumes.
3. Create `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `security/<issue>-<slug>`, or `docs/<issue>-<slug>` from current `main`.
4. Follow the task's red-green-refactor sequence and exact verification commands.
5. Commit the smallest coherent green change using Conventional Commits.
6. Open a pull request with the Spec/plan link, test evidence, risk, migration/protocol impact, and rollback notes.

## Required engineering rules

- TypeScript uses strict mode and Zod at every untrusted runtime boundary.
- PostgreSQL is authoritative for cross-device product state. Connector SQLite is authoritative for local receipt/outbox and Harness mappings.
- Never add a public Harness or arbitrary-shell endpoint.
- Use configured repository IDs and canonical paths; never accept paths from glasses input.
- Preserve terminal-state immutability, one-time approval, idempotency, and optimistic revision checks.
- Keep logs, UI, speech, metrics, test fixtures, and issue evidence free of credentials, raw prompts, source bodies, absolute local paths, and full terminal logs.
- Stable behavior must pass with `QHB_RTC_ENABLED=false`. RTC changes include an explicit stable-regression test.
- Protocol or architecture changes require an ADR and an update to the approved Spec before implementation.

## Pull request gate

A pull request is ready only when:

- The linked issue's checkboxes and definition of done are satisfied.
- Relevant unit, contract, integration, security, build, and document checks pass.
- A Changeset is present for user-visible package behavior, unless the change is docs/tests only.
- Protocol compatibility, database migration, security/privacy effect, and rollback path are explicit.
- Acceptance evidence is updated when the issue closes a release gate.

Review is a two-path gate:

- When a different eligible GitHub reviewer is available, the pull request requires a formal GitHub Approve from that reviewer.
- In a private single-maintainer repository with no second eligible GitHub account, the merge gate is a PASS from a fresh independent subagent reviewer plus success of all required GitHub checks. This solo fallback does not apply once a second eligible reviewer is available.

For either path, the reviewer must be different from the implementer, review the complete diff and commit range, and record the reviewer type and identity, findings, fix rounds, final verdict, and verification evidence. The author must not self-approve or fabricate review evidence.

Do not mix stable-path and RTC behavior in one pull request unless the change is a shared interface and stable tests pass with RTC disabled.
