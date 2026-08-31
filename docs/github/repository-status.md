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

## Branch-protection limitation

GitHub returned HTTP 403 when enabling protection on this private repository: the current account plan requires GitHub Pro or a public repository. Making the repository public is not an acceptable workaround because the product and its operational planning are private by design.

Until the account or repository plan supports private branch protection:

- The Governance workflow checks the planning baseline on pull requests and main pushes.
- CODEOWNERS, issue-first development, pull-request evidence, Conventional Commits, and no-force-push/no-delete policy remain mandatory process controls.
- The synchronization script keeps an open governance issue for the missing platform enforcement.
- After a plan upgrade or eligible organization transfer, rerun `node scripts/github/sync-management.mjs` and verify required `governance` status, linear history, conversation resolution, and force-push/deletion denial.

This limitation affects enforcement automation, not the product architecture or the five implementation plans.
