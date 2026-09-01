## Outcome

<!-- State the user-visible or engineering outcome. -->

## Tracking

- Closes # (required for GitHub Issue auto-close)
- Spec section:
- Implementation plan/task:

## Review evidence

<!-- Complete exactly one review mode. Do not check both boxes. The solo fallback is valid only for a private single-maintainer repository with no second eligible GitHub reviewer account. -->

### Review mode (check exactly one)

- [ ] Formal GitHub review — a distinct eligible GitHub reviewer gave an Approve.
- [ ] Solo-maintainer fallback — eligibility evidence shows no distinct eligible GitHub reviewer.

### Mode-specific evidence (complete only for the selected mode)

- Formal review URL (required for formal mode):
- Formal reviewer GitHub identity (required for formal mode):
- Solo eligibility evidence URL or repository-status reference (required for solo mode):
- Solo eligibility verification date (required for solo mode):

### Reviewer identity and independence (required)

- Implementer agent ID:
- Reviewer agent ID:
- Reviewer identity (agent/account):
- Reviewer is distinct from implementer: [ ] Yes
- Fresh review of this exact commit range: [ ] Yes
- Independent review (no author self-approval or fabricated evidence): [ ] Yes

### Scope, findings, and verdict (required)

- Commit range reviewed (base..head):
- Findings:
- Fix rounds:
- Final verdict: PASS / FAIL
- CI run URL(s) and required-check results:

## Verification

<!-- List exact commands and observed results. -->

## Risk and compatibility

- Security/privacy impact:
- Protocol compatibility:
- Database migration:
- Stable behavior with RTC disabled:

## Rollback

<!-- State the safe rollback path and any irreversible effects. -->

## Checklist

- [ ] Scope matches the approved Spec and linked issue.
- [ ] Tests were written or updated before implementation behavior.
- [ ] Relevant checks pass.
- [ ] Exactly one review mode is selected; the other mode is not used.
- [ ] Reviewer is different from the implementer and reviewed the complete diff and commit range.
- [ ] If an eligible different GitHub reviewer is available, that reviewer gave a formal GitHub Approve; the solo fallback was not used.
- [ ] If no second eligible GitHub reviewer account exists in this private single-maintainer repository, a fresh independent subagent reviewer returned PASS and all required GitHub checks succeeded.
- [ ] Review evidence records reviewer type/identity, commit range, verdict, findings, fix rounds, and CI evidence.
- [ ] The author did not self-approve or fabricate review evidence.
- [ ] No credentials, raw prompts/logs, source bodies, or absolute local paths are exposed.
- [ ] ADR/Spec updated for architecture or protocol changes.
- [ ] Changeset added for user-visible package behavior, or change is docs/tests only.
- [ ] Acceptance evidence updated if this closes a release gate.
