# GitHub Repository Status

Verified on 2026-09-04 against [EthanSMC/qwen-harness-bridge](https://github.com/EthanSMC/qwen-harness-bridge). This page is an evidence snapshot, not authority over current GitHub state; every controller and merge gate re-reads GitHub.

## AI Issue lifecycle rollout

- Activation: pre-activation bootstrap. The lifecycle workflow is not yet on `main`, the `AI_LIFECYCLE_MUTATION_MODE` and `AI_LIFECYCLE_VALIDATION_MODE` repository variables are absent, and strict enforcement is not claimed.
- Candidate modes: mutation `report` and validation `report`, using workflow defaults until the staged live acceptance begins.
- Candidate workflows/checks: `AI Issue Lifecycle / lifecycle` handles commands and reconciliation; `Governance / governance` includes the read-only PR lifecycle validator.
- Managed lifecycle labels: six (`status:waiting`, `status:ready`, `status:in-progress`, `status:review`, `status:blocked`, and `status:done`), bringing the candidate managed-label total from 19 to 25.
- Activation commit: `null` until a full 40-character commit reachable from `main` contains the complete implementation. The committed mutation-acceptance window was approved by `EthanSMC` at 2026-09-04T06:56:56Z and expires at 2026-09-11T00:00:00Z; its interval is capped at seven days and it permits only mutation enforcement before activation while validation remains report-only.
- Open migration entries: PR [#45](https://github.com/EthanSMC/qwen-harness-bridge/pull/45) / Issue [#7](https://github.com/EthanSMC/qwen-harness-bridge/issues/7), and bootstrap PR [#47](https://github.com/EthanSMC/qwen-harness-bridge/pull/47) / Issue [#46](https://github.com/EthanSMC/qwen-harness-bridge/issues/46). Both are approved by `EthanSMC`, expire at 2026-09-11T00:00:00Z, accept only their exact pre-activation pairs, and avoid inventing historical claim receipts. Every entry must be removed before activation and validation enforcement.
- Last reconciliation evidence: a no-write dry-run at GitHub server time 2026-09-04T08:00:09Z, after rebasing onto `main` commit `5e43581dff08f1579b67985a8f208dd7851ce9e6`, resolved all 34 marker-linked plan Issues, all six milestones, the complete paginated collaborator set, all open PRs, and the branch-protection payload. It verified #1–#7 as historical done from unique merged PR evidence and `main` ancestry, proposed #8 and #28 as ready, and proposed the remaining open plan Issues as waiting. Historical evidence was fetched through bounded GraphQL pagination; active Issue bodies were preserved.
- Live acceptance links: none yet. The disposable claim/heartbeat/PR/merge/close/reopen acceptance cycle is required after the bootstrap merge and before strict activation.

## Bootstrap verification evidence

Observed locally on 2026-09-04 after rebasing the bootstrap candidate onto current `main`:

- `node --test scripts/github/*.test.mjs`: PASS, 167 tests, including bounded ordered backlog recovery, durable untyped-command rejection, non-starving event reconciliation, timely durable review admission, current-claim terminal binding, uncertain-response convergence, bounded rollout, GraphQL historical proof, and the legacy-migration CLI path.
- `node scripts/github/verify-planning.mjs`: PASS, 25 governance/planning files and 34 implementation tasks.
- `pnpm build && pnpm check`: PASS; both workspace packages built, Biome checked 83 files, both workspace TypeScript projects passed, and Vitest passed 21 files / 381 tests.
- `git diff --check origin/main..HEAD`: PASS for the exact rebased candidate range.
- Security inspection: the write-capable workflow uses `pull_request_target`, serializes every mutation in one repository-wide queue, scans at most 1,000 recent repository comments and drains the oldest pending Issue commands by immutable comment ID, filters pull-request comments before backlog accounting, checks out only `github.event.repository.default_branch`, disables persisted checkout credentials, grants `contents: read` plus `issues: write` and `pull-requests: read`, never grants `contents: write`, and reads untrusted comment data only inside Node.

These local results do not substitute for current-head GitHub checks or independent final review.

## Active management state

- Visibility: public.
- Default branch: `main`.
- Governance workflow: active.
- Live managed labels: 19, alongside GitHub's default labels; the six lifecycle labels remain pending bootstrap synchronization.
- Milestones: 6 (`M0` through `M5`).
- Plan implementation issues: 34.
- Distribution: M0 7, M1 7, M2 6, M3 6, M4 7, M5 1.
- Source commits: approved Spec, five-plan roadmap, and existing repository governance are pushed; the lifecycle bootstrap remains on `docs/46-ai-issue-lifecycle` until reviewed and merged.

## Review gate status

- Solo-fallback eligibility evidence (re-verified by the complete paginated management dry-run and direct API query at GitHub server time 2026-09-04T08:00:09Z): repository `EthanSMC/qwen-harness-bridge`; every page of `GET /repos/EthanSMC/qwen-harness-bridge/collaborators` returned only `EthanSMC`, with `role_name=admin` and `admin/maintain/push/pull/triage` permissions. No distinct eligible direct reviewer remained after excluding the repository owner.
- PR review-state evidence (verified 2026-09-01): PR `#36` reference is https://github.com/EthanSMC/qwen-harness-bridge/pull/36. The controller's PR review-state query for `EthanSMC/qwen-harness-bridge` had `author=EthanSMC`, `reviewRequests=[]`, `latestReviews=[]`, and `reviewDecision=""`.
- Controller mode rule: query every page of direct collaborators, strictly validate each collaborator's login, role, and permissions, exclude the repository owner, and select formal mode only when another distinct collaborator has `admin`, `maintain`, or `push` role/permission. Fail closed on malformed records or if pagination reaches its safety cap without a short page. Otherwise select solo mode regardless of repository visibility and leave `required_pull_request_reviews` unset (`null`) while retaining the non-review branch protections.
- When a distinct eligible direct GitHub collaborator is available, a formal GitHub Approve is required. The live gate queries every review page and requires the specified reviewer's true latest state to be `APPROVED` on the current head. When no eligible collaborator is available, a fresh independent subagent reviewer must return PASS and all required GitHub checks must succeed.
- The reviewer must differ from the implementer and inspect the complete diff and commit range. The pull request records reviewer type and identity, findings, fix rounds, final verdict, and CI/verification evidence. The author cannot self-approve or fabricate evidence; the fallback ends as soon as a distinct eligible direct collaborator is available.
- Re-run the collaborator and PR review-state checks immediately before changing or relying on the selected mode, including before relying on the solo fallback. Any collaborator membership, role, or permission change is a mandatory re-verification trigger; do not rely on the previous solo result after such a change.
- Repository visibility is public, but visibility is not a criterion for selecting formal or solo review mode. The PR body validator checks evidence structure and accepts a GitHub Actions run URL or PR checks URL. It does not establish that CI passed; the controller must query the GitHub checks API and confirm successful required checks immediately before merge, keeping this evidence check from depending on itself.
- The PR workflow runs static governance first and a final `governance` job only after `needs: static`; the final job performs the live PR/API state check. Pushes to `main` run static governance only and do not require PR body evidence.
- Issue-first work remains required: each change uses its issue-linked pull request and `Closes #<issue>` for GitHub Issue auto-close. Required CI checks, release-gate acceptance evidence, and the normal PR gate remain in force.

## Branch-protection state

- Branch protection: enabled on `main`, verified through the GitHub API on 2026-09-03.
- The required status check is `governance` with strict up-to-date branch enforcement.
- Protection requires linear history and resolved review conversations and applies to administrators.
- Force pushes and branch deletions are disabled.
- `required_pull_request_reviews` is unset while no distinct eligible direct collaborator exists; the live governance check still requires truthful solo-fallback evidence, an independent exact-range PASS, and current-head checks.
- Rerun `node scripts/github/sync-management.mjs` and re-verify the API after any collaborator, visibility, default-branch, or plan change.

The earlier private-plan limitation is resolved. Governance Issue #35 records the historical limitation and its closure evidence.
