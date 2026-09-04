# Changelog

All notable changes use synchronized Semantic Versioning and are recorded here. Runtime releases will be generated from Changesets.

## Unreleased

### Added

- Human-accountable AI Issue claims with a repository-wide mutation queue, bounded ordered command recovery, exclusive GitHub-clocked 24-hour implementation leases, durable review admission, safe public provenance, explicit handoff/block/resume commands, independent current-head review, claim-bound merge/close/reopen reconciliation, and independently staged mutation/validation activation.
- Approved Qwen Harness Bridge product and system Spec.
- Five detailed test-driven implementation plans and master roadmap.
- Public-repository governance, issue templates, planning validation, and GitHub synchronization tooling.

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
