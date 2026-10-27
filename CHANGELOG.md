# Changelog

All notable changes use synchronized Semantic Versioning and are recorded here. Runtime releases will be generated from Changesets.

## Unreleased

### Added

- Human-accountable AI Issue claims with a repository-wide mutation queue, bounded ordered command recovery, ordered claim-generation-bound cross-run system-intent recovery, durable supersession of stale intents, strictly advancing claim-state and lease receipts even for same-second commands, pre-write receipt validation, schema-aware GitHub object identifiers, PR-comment isolation, exclusive GitHub-clocked 24-hour implementation leases, timely exact-PR-bound durable review admission, safe public provenance, explicit handoff/block/resume commands, independent current-head review, claim-bound merge/close/reopen reconciliation, and independently staged mutation/validation activation.
- Public pre-activation acceptance evidence for exclusive claim, contention rejection, heartbeat, block/resume, release and fresh generation, review admission, current-head checks, merge-driven closure, terminal reconciliation, and reopen-to-ready.
- Strict AI lifecycle activation with an immutable protected-main activation commit, empty migration registry, null acceptance window, both repository gates enforced, and a fresh post-activation claim and closing smoke PR.
- Repository-wide reconciliation that reports only activation-bound, version-controlled historical Issue snapshots after confirming exact close time, managed-label shape, and absence of workflow receipts, while every mismatch and governed Issue remains fail closed.
- Approved Qwen Harness Bridge product and system Spec.
- Five detailed test-driven implementation plans and master roadmap.
- Public-repository governance, issue templates, planning validation, and GitHub synchronization tooling.

## 0.2.0 — pending publication

This entry describes the prepared M1 connector-installation scope; it does not assert that a release tag, GitHub Release, or package publication exists. Package versions, the tag, and the GitHub Release remain release-process actions.

### Added

- Deterministic, self-contained packaged Harness Connector artifact built by `pnpm --filter @qhb/harness-plugin pack`: compiled code with self-contained source maps, the SQLite schema and its digest, the license when present, a credential-free sample Cordis wiring, and the vendored runtime closure (the private workspace package `@qhb/protocol`, `zod`, and `ws`). Host-provided `@deepseek-ai/*` peers stay external, and the artifact vendors no native module.
- Packaged smoke test (`pnpm --filter @qhb/harness-plugin pack:test`) that installs the artifact into a clean temporary root outside the repository with no monorepo `node_modules` in its ancestry, links only the host peers, imports the packaged entry in a separate process, validates the sample wiring against the packaged config schema, opens the journal, fails packaging when a credential value or credential-looking assignment would be included, and asserts that removing the vendored protocol makes the same import fail closed.
- Credential-free `cordis.example.yml` sample wiring that references Keychain service/account names and one canonical repository root, with no token and no user-specific absolute repository path.
- Cross-platform install, credential-rotation, and plugin-rollback rehearsal (`pnpm --filter @qhb/harness-plugin rehearse:install`) with a JSON report, plus the macOS-oriented runbooks under `docs/runbooks/`.
- `docs/product/v0.2.0-acceptance.md` acceptance record for M1 Spec items 2, 3, 5, 6, 7, and 10 at an exact environment and artifact digest.
- Vendored third-party license text travels with the packaged artifact: the license files of the vendored runtime packages are retained and listed in `qhbVendoredLicenses` even when a package's `files` field omits them. The repository ships no root LICENSE, so no root license entry is added.
- DSH bundle metadata (`dsh.bundle.patch`) and a shipped `cordis.patch.yml`, so `dsh plugin --profile <name> add <tarball>` activates the connector as a profile layer instead of a plain dependency.
- Cross-platform Connector bootstrap credential source ([ADR 0008](docs/adr/0008-cross-platform-connector-credential-source.md), Spec §7.4/§13.1): Darwin keeps the macOS Keychain default, other platforms select a controlled `file` or `environment` source, and a missing, ambiguous, oversized or symlinked source fails closed without echoing the credential value or its resolved location.
- Loopback Control-Plane fixture and a live rehearsal runner (`pnpm --filter @qhb/harness-plugin rehearse:live`) that installs the packaged artifact into a fresh DSH profile, boots the global Harness CLI, and drives task submission, approval and result collection over MCP with a redacted JSON report.

### Changed

- The durable journal uses the built-in `node:sqlite` instead of the vendored `better-sqlite3`, so the artifact carries no native module and one build runs on any host the Harness supports.

### Fixed

- The receive pump no longer deadlocks when a command handler awaits a Coordination `job.state` response that only the pump can deliver: a response answering a request published by the command handler the pump is awaiting is recorded and delivered ahead of the pump, while replays, replacements, gaps and every other frame keep the strictly ordered validation path.

## 0.1.0 — pending publication

This entry describes the qualified M0 scope; it does not assert that a release tag, GitHub Release, or package publication exists.

### Added

- Foundation Control Plane with PostgreSQL-backed jobs, events, state transitions, idempotency, leases, approvals, cancellation, terminal results, and result acknowledgement.
- Versioned MCP surface with seven tools plus shared Connector schemas and protocol validation.
- Fake Connector end-to-end behavior covering claim, progress, reconnect, duplicate delivery, approval, cancellation, and result acknowledgement.
- Reliability baseline for liveness/readiness separation, migration-safe startup, bounded metrics, database-loss behavior, recovery, and scoped privacy audits.
- GitHub Runtime evidence for the implementation head, including reproducible image/configuration digests, a 221-test foundation acceptance aggregate, and a bounded in-memory MCP call timing gate.

See [v0.1.0 acceptance evidence](docs/product/v0.1.0-acceptance.md) for the exact qualification record and release contingencies.

## 0.0.0-planning — 2026-09-01

- Established the design and delivery baseline before runtime implementation.
