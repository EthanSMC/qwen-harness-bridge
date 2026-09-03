# GitHub Repository Status

Verified on 2026-09-01 against [EthanSMC/qwen-harness-bridge](https://github.com/EthanSMC/qwen-harness-bridge).

## Active management state

- Visibility: private.
- Default branch: `main`.
- Governance workflow: active.
- Managed labels: 19, alongside GitHub's default labels.
- Milestones: 6 (`M0` through `M5`).
- Plan implementation issues: 34.
- Distribution: M0 7, M1 7, M2 6, M3 6, M4 7, M5 1.
- Source commits: approved Spec, five-plan roadmap, and repository governance are pushed.

## Review gate status

- Solo-fallback eligibility evidence (verified 2026-09-01): repository `EthanSMC/qwen-harness-bridge`; collaborator endpoint `GET /repos/EthanSMC/qwen-harness-bridge/collaborators` returned only `EthanSMC`, with `role_name=admin` and `admin/maintain/push/pull/triage` permissions. No distinct eligible direct GitHub collaborator was present in that response.
- PR review-state evidence (verified 2026-09-01): PR `#36` reference is https://github.com/EthanSMC/qwen-harness-bridge/pull/36. The controller's PR review-state query for `EthanSMC/qwen-harness-bridge` had `author=EthanSMC`, `reviewRequests=[]`, `latestReviews=[]`, and `reviewDecision=""`.
- Controller mode rule: query direct collaborators, exclude the repository owner, and select formal mode only when another distinct collaborator has `admin`, `maintain`, or `push` role/permission. Otherwise select solo mode regardless of repository visibility and leave `required_pull_request_reviews` unset (`null`) while retaining the non-review branch protections.
- When a distinct eligible direct GitHub collaborator is available, a formal GitHub Approve is required. When none is available, a fresh independent subagent reviewer must return PASS and all required GitHub checks must succeed.
- The reviewer must differ from the implementer and inspect the complete diff and commit range. The pull request records reviewer type and identity, findings, fix rounds, final verdict, and CI/verification evidence. The author cannot self-approve or fabricate evidence; the fallback ends as soon as a distinct eligible direct collaborator is available.
- Re-run the collaborator and PR review-state checks immediately before changing or relying on the selected mode, including before relying on the solo fallback. Any collaborator membership, role, or permission change is a mandatory re-verification trigger; do not rely on the previous solo result after such a change.
- Repository visibility remains private for product and operational reasons; it is not a criterion for selecting formal or solo review mode. The PR body validator checks evidence structure and accepts a GitHub Actions run URL or PR checks URL. It does not establish that CI passed; the controller must query the GitHub checks API and confirm successful required checks immediately before merge, keeping this evidence check from depending on itself.
- The PR workflow runs static governance first and a final `governance` job only after `needs: static`; the final job performs the live PR/API state check. Pushes to `main` run static governance only and do not require PR body evidence.
- Issue-first work remains required: each change uses its issue-linked pull request and `Closes #<issue>` for GitHub Issue auto-close. Required CI checks, release-gate acceptance evidence, and the normal PR gate remain in force.

## Branch-protection limitation

GitHub returned HTTP 403 when enabling protection on this private repository: the current account plan requires GitHub Pro or a public repository. Making the repository public is not an acceptable workaround because the product and its operational planning are private by design.

Until the account or repository plan supports private branch protection:

- The Governance workflow checks the planning baseline on pull requests and main pushes.
- CODEOWNERS, issue-first development, pull-request evidence, Conventional Commits, and no-force-push/no-delete policy remain mandatory process controls.
- The review paths above are documented process controls only; branch protection is not enabled and must not be represented as enabled.
- The synchronization script keeps an open governance issue for the missing platform enforcement.
- After a plan upgrade or eligible organization transfer, rerun `node scripts/github/sync-management.mjs` and verify required `governance` status, linear history, conversation resolution, and force-push/deletion denial.

This limitation affects enforcement automation, not the product architecture or the five implementation plans.
