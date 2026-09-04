# GitHub Repository Status

Verified on 2026-09-04 against [EthanSMC/qwen-harness-bridge](https://github.com/EthanSMC/qwen-harness-bridge). This page is an evidence snapshot, not authority over current GitHub state; every controller and merge gate re-reads GitHub.

## AI Issue lifecycle rollout

- Activation: strict. Bootstrap PR [#47](https://github.com/EthanSMC/qwen-harness-bridge/pull/47) merged the trusted workflow as `b06aceb805f03dc809b37b80cb45a240bb5be66d`; activation PR [#54](https://github.com/EthanSMC/qwen-harness-bridge/pull/54) recorded that reachable commit, removed every migration, and cleared the bounded mutation-acceptance window as protected-main commit `c3a2dd1896ea6a9e3b49d01d7aa4b98876ea87b9`.
- Observed modes after activation: mutation `enforce` and validation `enforce`, verified on 2026-09-04T11:12:44Z. Rollback sets either variable to `report` without deleting receipts.
- Live workflows/checks: `AI Issue Lifecycle / lifecycle` handles commands and reconciliation; `Governance / governance` includes the read-only PR lifecycle validator.
- Managed lifecycle labels: six (`status:waiting`, `status:ready`, `status:in-progress`, `status:review`, `status:blocked`, and `status:done`), for 25 managed labels total.
- Activation commit: `b06aceb805f03dc809b37b80cb45a240bb5be66d`, the protected-main bootstrap merge containing the complete trusted workflow. The live registry has `mutation_acceptance: null` and `entries: []`.
- Last successful event reconciliation: Issue [#52](https://github.com/EthanSMC/qwen-harness-bridge/issues/52) reached unassigned `status:done` through strict smoke PR #55 and its [verified merge receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539844953). The apply-mode management synchronization had already verified solo review mode, 25 labels, six milestones, 34 marker-linked plan Issues, and branch-protection postconditions.
- Live acceptance: Issue [#52](https://github.com/EthanSMC/qwen-harness-bridge/issues/52), PR [#53](https://github.com/EthanSMC/qwen-harness-bridge/pull/53), and [current-head checks](https://github.com/EthanSMC/qwen-harness-bridge/pull/53/checks) prove the pre-activation command, review, merge, close, terminal, and reopen paths. The reopened Issue entered a new strict-mode generation through its [fresh claim receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539621678); final smoke PR [#55](https://github.com/EthanSMC/qwen-harness-bridge/pull/55) is bound to it through the [strict admission receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539646966).

### Strict activation evidence

- Activation review and CI: PR [#54](https://github.com/EthanSMC/qwen-harness-bridge/pull/54) received an independent exact-range PASS and all [current-head checks](https://github.com/EthanSMC/qwen-harness-bridge/pull/54/checks) passed before merge at 2026-09-04T11:11:25Z.
- Activation terminal state: Issue #51 is closed as completed, has only `status:done`, has no assignee, and records the [workflow merge receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/51#issuecomment-5539609643).
- Strict configuration: both lifecycle variables are `enforce`; activation commit `b06aceb805f03dc809b37b80cb45a240bb5be66d` is reachable from `main`; the migration list is empty and the mutation-acceptance value is null.
- Post-activation smoke: Issue #52 used a fresh strict-mode claim distinct from its pre-activation generation. PR [#55](https://github.com/EthanSMC/qwen-harness-bridge/pull/55) passed strict lifecycle admission, independent exact-range review, and all [current-head checks](https://github.com/EthanSMC/qwen-harness-bridge/pull/55/checks), then produced merge-driven closure and the [terminal receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539844953).
- Repository-wide reconciliation audit: manual workflow-dispatch run [33868540482](https://github.com/EthanSMC/qwen-harness-bridge/actions/runs/33868540482) preserved the red observation that five closed pre-enrollment auxiliary Issues have a managed type but never entered the lifecycle. They remain immutable historical records without synthetic receipts or `status:done`; Issue [#56](https://github.com/EthanSMC/qwen-harness-bridge/issues/56) tracks the bounded repair. The exception is an activation-bound, version-controlled allowlist of Issue number plus original `closed_at`; reconciliation additionally requires the exact closed zero-status shape and no workflow lifecycle receipts. Every mismatch follows normal strict validation.

### Pre-activation live acceptance evidence

- Readiness and first exclusive claim: [initialize receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539202206), [claim receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539208900).
- Competing claim rejection and lease renewal: [`ALREADY_CLAIMED`](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539213862), [heartbeat](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539217975).
- Block, resume, release, and fresh generation: [block](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539223669), [resume](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539237669), [release](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539242184), [fresh claim](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539247128).
- Review, CI, merge, terminal reconciliation, and reopen: [PR admission](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539267569), [PR #53 checks](https://github.com/EthanSMC/qwen-harness-bridge/pull/53/checks), [merge receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539324881), and [reopen receipt](https://github.com/EthanSMC/qwen-harness-bridge/issues/52#issuecomment-5539337999). The merge occurred at 2026-09-04T10:45:22Z and GitHub closed the Issue as completed at 2026-09-04T10:45:23Z before terminal reconciliation.

## Bootstrap verification evidence

Observed locally on 2026-09-04 after rebasing the bootstrap candidate onto current `main`:

- `node --test scripts/github/*.test.mjs`: PASS, 195 tests, including bounded ordered backlog recovery, durable untyped-command rejection, unique ordered claim-generation-bound cross-run recovery for every transition, durable stale-intent supersession, strictly advancing same-second renewals, pre-write receipt validation, schema-aware numeric and Git object ID validation, monotonic claim-state and lease receipt reconstruction, activation ancestry success plus fail-closed `diverged`/404 coverage in both mutation and validation entry points, activation-bound historical snapshot isolation with negative coverage for unlisted, changed, receipt-bearing, and malformed managed Issues, PR-comment isolation through the real controller entry point, non-starving event reconciliation, timely PR-bound durable review admission for open/edit/reopen events, current-claim terminal binding, uncertain-response convergence, bounded rollout, GraphQL historical proof, and the legacy-migration CLI path.
- `node scripts/github/verify-planning.mjs`: PASS, 25 governance/planning files and 34 implementation tasks.
- `pnpm build && pnpm check`: PASS; both workspace packages built, Biome checked 83 files, both workspace TypeScript projects passed, and Vitest passed 21 files / 384 tests.
- `git diff --check origin/main..HEAD`: PASS for the exact rebased candidate range.
- Security inspection: the write-capable workflow uses `pull_request_target`, serializes every mutation in one repository-wide queue, scans at most 1,000 recent repository comments and drains the oldest pending Issue commands by immutable comment ID, resolves one semantically and current-claim-matching unfinished bot intent before any later transition, durably rejects replay when a successful receipt intervened, rejects non-sequential claim states and non-advancing lease renewals during receipt reconstruction, filters pull-request comments before backlog accounting and again at the Issue handler boundary, binds every v2 review/terminal receipt to one exact PR number, requires a live-matching GitHub qualification timestamp inside the active lease, checks out only `github.event.repository.default_branch`, disables persisted checkout credentials, grants `contents: read` plus `issues: write` and `pull-requests: read`, never grants `contents: write`, and reads untrusted comment data only inside Node.

These local results do not substitute for current-head GitHub checks or independent final review.

## Active management state

- Visibility: public.
- Default branch: `main`.
- Governance workflow: active.
- Live managed labels: 25; all six lifecycle labels are synchronized.
- Milestones: 6 (`M0` through `M5`).
- Plan implementation issues: 34.
- Distribution: M0 7, M1 7, M2 6, M3 6, M4 7, M5 1.
- Source commits: bootstrap workflow commit `b06aceb805f03dc809b37b80cb45a240bb5be66d`, live-acceptance fixture commit `657f619755cbffa784d12519f3f4d166b2118286`, strict activation commit `c3a2dd1896ea6a9e3b49d01d7aa4b98876ea87b9`, and strict smoke commit `eff4ca04f463c1e12d858a2c18ec8e5a3d9d0915` are reachable from protected `main`.

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
