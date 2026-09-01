## Outcome

<!-- State the user-visible or engineering outcome. -->

## Tracking

- Closes # (required for GitHub Issue auto-close)
- Spec section:
- Implementation plan/task:

## Review evidence

<!-- Complete one review path. The solo fallback is valid only for a private single-maintainer repository with no second eligible GitHub reviewer account. -->

- Reviewer type: [ ] Eligible GitHub reviewer  [ ] Fresh independent subagent reviewer (solo-maintainer fallback)
- Reviewer identity:
- Implementer:
- Commit range reviewed:
- Final verdict: PASS / FAIL
- Findings:
- Fix rounds:
- CI evidence (required GitHub checks and results/links):
- Solo fallback basis (if used):

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
- [ ] Reviewer is different from the implementer and reviewed the complete diff and commit range.
- [ ] If an eligible different GitHub reviewer is available, that reviewer gave a formal GitHub Approve; the solo fallback was not used.
- [ ] If no second eligible GitHub reviewer account exists in this private single-maintainer repository, a fresh independent subagent reviewer returned PASS and all required GitHub checks succeeded.
- [ ] Review evidence records reviewer type/identity, commit range, verdict, findings, fix rounds, and CI evidence.
- [ ] The author did not self-approve or fabricate review evidence.
- [ ] No credentials, raw prompts/logs, source bodies, or absolute local paths are exposed.
- [ ] ADR/Spec updated for architecture or protocol changes.
- [ ] Changeset added for user-visible package behavior, or change is docs/tests only.
- [ ] Acceptance evidence updated if this closes a release gate.
