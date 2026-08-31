# Reliability, Security, and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the stable asynchronous system against restart, reconnect, replay, race, secret leakage, and operational failure; ship `v0.4.0` and qualify the stable path for private-beta `v1.0.0` independently of RTC.

**Architecture:** PostgreSQL remains authoritative for product state, while Connector SQLite remains authoritative for local receipt/outbox and Harness mapping. A reconciliation protocol compares cursors and nonterminal attempts after every reconnect. Deterministic clocks and fault-injection tests cover timing and races. Bounded metrics, structured redacted logs, backups, runbooks, protected CI, Changesets, signed artifacts, and rehearsed rollback make the system operable by one owner without weakening local policy.

**Tech Stack:** TypeScript strict mode, Vitest fake timers, Testcontainers, Toxiproxy, Fastify injection, PostgreSQL/Drizzle, SQLite, OpenTelemetry-compatible JSON logs and Prometheus metrics, Docker/OCI, GitHub Actions, Changesets, Gitleaks, Trivy, CodeQL, Dependabot, and shell-free Node maintenance scripts.

**Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

## Global Constraints

- Stable mode is the release path. No RTC component, token, port, test, or failure may affect readiness for this plan.
- Delivery is at least once; orchestration prevents duplicate attempts with persisted compare-and-swap. Documentation never claims exactly-once external side effects.
- Terminal job states and first valid approval decisions are immutable.
- Connector health is computed independently from job status: fresh before 20 seconds, stale from 20 to under 30 seconds, offline at 30 seconds.
- Queued expiry is 24 hours, run timeout 60 minutes, default approval expiry 5 minutes, idempotency retention 24 hours, cloud redacted retention 30 days, original request deletion 24 hours after terminal, and local full-log retention 7 days.
- Metrics labels are bounded and exclude identifiers, repository names, prompts, summaries, and paths.
- Backups are encrypted, access-controlled, and tested by restore. A backup policy without a successful restore drill does not pass.
- Every security decision fails closed. Availability work cannot bypass authentication, repository policy, approval fingerprinting, or protocol expiry.
- Every task ends with a focused commit and a green relevant test slice.

---

## Planned File Map

```text
apps/control-plane/src/reconciliation/             cursor and attempt reconciliation
apps/control-plane/src/maintenance/                expiry, retention, cleanup workers
apps/control-plane/src/observability/              logs, metrics, traces, alerts
packages/harness-plugin/src/runtime/reconcile.ts   local recovery logic
packages/harness-plugin/src/maintenance/           local retention and integrity
tests/chaos/                                       disconnect/restart/fault cases
tests/security/                                    auth, replay, traversal, leakage
tests/performance/                                 MCP latency and bounded load
scripts/backup/                                    encrypted backup/restore verification
scripts/release/                                   version, artifacts, rollback checks
docs/architecture/threat-model.md                  trust-boundary analysis
docs/adr/                                          protocol and operational decisions
docs/runbooks/                                     incidents, restore, deploy, rollback
.github/workflows/                                 required CI and release workflows
.changeset/config.json                             synchronized SemVer policy
docs/product/v0.4.0-acceptance.md                   hardening evidence
docs/product/v1.0.0-acceptance.md                   private-beta evidence
```

## Task 1: Reconnect Reconciliation and Duplicate-Execution Defense

**Files:**
- Create: `packages/protocol/src/reconciliation.ts`
- Create: `apps/control-plane/src/reconciliation/reconciliation-service.ts`
- Create: `packages/harness-plugin/src/runtime/reconcile.ts`
- Create: `tests/chaos/reconnect-replay.test.ts`
- Create: `tests/chaos/split-brain-attempt.test.ts`
- Modify: `packages/protocol/src/connector.ts`

**Interfaces:**

```ts
export type ReconcileRequest = {
  connector_id: string;
  last_server_sequence: number;
  last_client_sequence: number;
  active_attempts: ReadonlyArray<{
    job_id: string;
    attempt: number;
    session_id_digest: string;
    local_state: "claimed" | "running" | "waiting_approval" | "cancelling";
  }>;
};

export type ReconcileDirective =
  | { kind: "continue"; job_id: string; attempt: number }
  | { kind: "cancel"; job_id: string; attempt: number; reason: string }
  | { kind: "replay_from"; direction: "client" | "server"; sequence: number };
```

- [ ] **Step 1: Write failing partition/reconnect tests**

Inject disconnect before offer ACK, after `job.claim`, during approval, after terminal event before ACK, and during cancel. Restart Control Plane, Connector, and both in each position. Assert one `(job_id, attempt)`, ordered read model, one terminal state, no repeated approval grant, and no new Agent when the mapping already exists.

Run: `pnpm vitest run tests/chaos/reconnect-replay.test.ts tests/chaos/split-brain-attempt.test.ts`
Expected: FAIL because explicit reconciliation is absent.

- [ ] **Step 2: Add reconciliation schemas as protocol-1.0 additive messages**

Add `connector.reconcile` and `connector.reconciled`; old peers that do not advertise `reconciliation_v1` continue with cursor replay only. Reject duplicate active mappings, negative cursors, more than 20 attempts, and session identifiers that are not one-way digests.

- [ ] **Step 3: Implement server-side authoritative directives**

In one transaction, compare connector ownership, cloud attempt, lease, terminal state, and cancel state. Continue only the exact active attempt. Cancel unknown/superseded/terminal local attempts. Return replay cursor from committed message tables, not socket memory.

- [ ] **Step 4: Implement local reconciliation before accepting new offers**

After welcome, pause command dispatch, send local active mappings/cursors, execute directives, replay pending events, and only then mark Connector ready. A local mapping the server cannot authorize is cancelled and retained for audit, not deleted.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/chaos/reconnect-replay.test.ts tests/chaos/split-brain-attempt.test.ts`
Expected: PASS across the full failure-position matrix.

```bash
git add packages/protocol apps/control-plane/src/reconciliation packages/harness-plugin/src/runtime/reconcile.ts tests/chaos
git commit -m "feat(reliability): reconcile attempts and replay after reconnect"
```

## Task 2: Deterministic Deadlines, Leases, Retention, and Race Resolution

**Files:**
- Create: `apps/control-plane/src/clock.ts`
- Create: `apps/control-plane/src/maintenance/deadline-worker.ts`
- Create: `apps/control-plane/src/maintenance/retention-worker.ts`
- Create: `packages/harness-plugin/src/maintenance/local-retention.ts`
- Create: `tests/integration/deadlines.test.ts`
- Create: `tests/integration/cancellation-races.test.ts`
- Create: `tests/integration/retention.test.ts`

**Interfaces:**

```ts
export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface DeadlineWorker {
  runBatch(now: Date, limit: number): Promise<{
    expiredJobs: number;
    expiredApprovals: number;
    releasedOffers: number;
  }>;
}
```

- [ ] **Step 1: Write failing boundary and race tests**

Use an injected clock at exactly 20/30 seconds heartbeat boundaries, 30-second offer lease, 24-hour queue expiry, 60-minute run deadline, 1/5/30-minute approval settings, cancel versus success/failure, approval versus expiry, cleanup versus result read, and worker concurrency with `SKIP LOCKED`.

Run: `pnpm vitest run tests/integration/deadlines.test.ts tests/integration/cancellation-races.test.ts tests/integration/retention.test.ts`
Expected: FAIL because workers and clock injection are absent.

- [ ] **Step 2: Replace direct time reads in domain code**

Inject `Clock` into coordinator, approval service, Connector health, token issuance, and workers. Database transactions receive one captured `now`; tests never depend on wall-clock sleeps.

- [ ] **Step 3: Implement idempotent batch workers**

Use bounded batches and row locks. Expire only nonterminal eligible rows, append one immutable event, increment one revision, and make a repeated run return zero changes. Release expired offer leases without changing the product attempt.

- [ ] **Step 4: Implement data lifecycle**

Delete encrypted original request 24 hours after terminal, expire idempotency records at 24 hours, delete redacted cloud job/event records after 30 days according to foreign-key order, and remove local full logs after 7 days. Preserve minimal tombstones containing opaque ID digest, terminal status, and deletion timestamp to reject replay without retaining content.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/integration/deadlines.test.ts tests/integration/cancellation-races.test.ts tests/integration/retention.test.ts`
Expected: PASS at every exact boundary and concurrent worker case.

```bash
git add apps/control-plane/src/clock.ts apps/control-plane/src/maintenance packages/harness-plugin/src/maintenance tests/integration
git commit -m "feat(reliability): enforce deterministic deadlines and retention"
```

## Task 3: Threat Model and Automated Security Gates

**Files:**
- Create: `docs/architecture/threat-model.md`
- Create: `docs/adr/0001-outbound-only-mac-connector.md`
- Create: `docs/adr/0002-at-least-once-delivery.md`
- Create: `docs/adr/0003-local-policy-authority.md`
- Create: `tests/security/authentication.test.ts`
- Create: `tests/security/protocol-replay.test.ts`
- Create: `tests/security/repository-boundary.test.ts`
- Create: `tests/security/approval-integrity.test.ts`
- Create: `tests/security/data-exfiltration.test.ts`
- Create: `.gitleaks.toml`

- [ ] **Step 1: Write the threat model with explicit abuse cases**

Cover spoofed Qwen caller, stolen Connector credential, malicious cloud command, replayed envelope, modified approval, compromised repository symlink, prompt injection, Harness plugin compromise, log leakage, database theft, dependency compromise, denial of service, RTC isolation, and owner error. For each asset/threat record prevention, detection, response, residual risk, and test owner.

- [ ] **Step 2: Write failing security tests from the threat table**

Exercise invalid/revoked/expired/cross-domain tokens; signature/token audience mismatch; old/future timestamp; duplicate message ID with modified payload; nonce and sequence replay; alias substitution; traversal/symlink race; wrong fingerprint/revision; secret-like task/result/log content; and rate limits for submit, status, and approval.

Run: `pnpm vitest run tests/security`
Expected: FAIL for each unimplemented mitigation named by the test.

- [ ] **Step 3: Implement credential isolation and rotation**

Use independent audiences and secrets for Qwen MCP and Connector exchange. Store only credential hashes/IDs in PostgreSQL. Rotation overlaps old/new Connector credentials for at most five minutes, revocation ends new exchanges immediately, and active short-lived sessions expire within 15 minutes.

- [ ] **Step 4: Implement replay and rate-limit defenses**

Bind message ID to payload digest, connector, sequence, and expiry. A duplicate with another digest closes the connection and emits `PROTOCOL_REPLAY_MISMATCH`. Apply single-owner token buckets with separate mutation/read quotas; return bounded retry metadata.

- [ ] **Step 5: Run code and artifact scanners**

Run: `gitleaks detect --source . --no-git`
Expected: no verified secret findings.

Run: `pnpm audit --prod && trivy fs --exit-code 1 --severity HIGH,CRITICAL .`
Expected: no unaccepted high/critical production finding. Any accepted false positive is documented with evidence, owner, and expiration date.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run tests/security && pnpm check`
Expected: PASS.

```bash
git add docs/architecture/threat-model.md docs/adr tests/security .gitleaks.toml
git commit -m "security: harden trust boundaries and replay defenses"
```

## Task 4: Bounded Observability and Actionable Alerts

**Files:**
- Create: `apps/control-plane/src/observability/logger.ts`
- Create: `apps/control-plane/src/observability/metrics.ts`
- Create: `apps/control-plane/src/observability/correlation.ts`
- Create: `apps/control-plane/src/observability/alerts.ts`
- Create: `packages/harness-plugin/src/observability/local-logger.ts`
- Create: `tests/contract/observability.test.ts`
- Create: `docs/runbooks/diagnose-stuck-job.md`
- Create: `docs/runbooks/connector-offline.md`

**Required metric families:**

```text
qhb_mcp_requests_total{tool,outcome}
qhb_mcp_duration_seconds{tool}
qhb_jobs{status}
qhb_job_transitions_total{from,to}
qhb_connector_health{state}
qhb_connector_reconnects_total{reason}
qhb_protocol_messages_total{direction,type,outcome}
qhb_approvals_total{outcome,risk_class}
qhb_maintenance_actions_total{worker,outcome}
```

- [ ] **Step 1: Write a failing observability contract**

Assert every inbound request has or receives a correlation ID, logs contain stable event/error codes, metrics contain only allow-listed labels, error objects omit stack and content, and token/path/prompt fixtures never appear in captured log or metric output.

Run: `pnpm vitest run tests/contract/observability.test.ts`
Expected: FAIL because the shared observability layer is absent.

- [ ] **Step 2: Implement structured redacted logging**

Emit timestamp, level, service, version, correlation ID, opaque job/connector ID, message type, sequence, transition, duration, and stable error code. Redact before serialization. Connector local full logs use file permissions `0600`, bounded rotation, and seven-day retention.

- [ ] **Step 3: Implement metrics without cardinality leaks**

Use enums for all labels and reject unknown labels at compile/runtime boundaries. Job IDs, owner IDs, repository IDs, HTTP paths containing IDs, and error messages are never labels.

- [ ] **Step 4: Define initial alerts and one-owner response**

Alert on Connector offline over two minutes, no claims for queued online work over one minute, MCP p95 over two seconds for five minutes, protocol replay mismatch, failed maintenance batch, backup failure, and repeated approval-integrity errors. Every alert links one runbook and includes a silence/resolve condition.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/contract/observability.test.ts`
Expected: PASS and snapshot contains no dynamic-cardinality labels.

```bash
git add apps/control-plane/src/observability packages/harness-plugin/src/observability tests/contract/observability.test.ts docs/runbooks
git commit -m "feat(ops): add bounded telemetry and incident runbooks"
```

## Task 5: Encrypted Backup, Restore, and Disaster Recovery

**Files:**
- Create: `scripts/backup/create-backup.mjs`
- Create: `scripts/backup/restore-backup.mjs`
- Create: `scripts/backup/verify-restore.mjs`
- Create: `tests/integration/backup-restore.test.ts`
- Create: `docs/runbooks/backup-restore.md`
- Create: `docs/runbooks/lost-mac-recovery.md`
- Create: `docs/product/restore-drill-record.md`

- [ ] **Step 1: Write a failing backup/restore integration test**

Seed queued, running, waiting-approval, and terminal jobs with events/cursors; create backup; destroy the disposable database; restore into a new instance; run migrations; verify counts, revisions, immutable events, encrypted-request ciphertext, and Connector replay cursors. Do not include production credentials or local full logs.

Run: `pnpm vitest run tests/integration/backup-restore.test.ts`
Expected: FAIL because scripts are absent.

- [ ] **Step 2: Implement encrypted PostgreSQL backup creation**

Invoke `pg_dump` with an argument array, stream directly into authenticated encryption using a separately supplied backup key, write a manifest with schema version/SHA-256/timestamp, fsync, then atomically rename. Never place database passwords or encryption keys in arguments, filenames, logs, or manifest.

- [ ] **Step 3: Implement guarded restore**

Require an empty target database unless `--replace-disposable-test-database` is explicitly passed. Verify manifest, digest, authentication tag, supported schema version, and available disk before restore. Run read-only integrity checks before enabling workers or Connectors.

- [ ] **Step 4: Define local Mac recovery**

Document loss of SQLite/Harness persistence as loss of local execution continuity: revoke Connector credential, mark active attempts failed with `CONNECTOR_STATE_LOST`, enroll a new Connector, and never infer success. Copying local state is allowed only while Harness and plugin are stopped and the encrypted device backup is intact.

- [ ] **Step 5: Perform and record a restore drill**

Restore the latest staging backup into an isolated database, connect a fake Connector, query all restored states, complete one restored queued job, and record recovery point/time, commands, artifact digest, and pass/fail in `docs/product/restore-drill-record.md`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run tests/integration/backup-restore.test.ts`
Expected: PASS including corrupted manifest/ciphertext rejection.

```bash
git add scripts/backup tests/integration/backup-restore.test.ts docs/runbooks/backup-restore.md docs/runbooks/lost-mac-recovery.md docs/product/restore-drill-record.md
git commit -m "feat(ops): add verified encrypted backup and restore"
```

## Task 6: Required CI, Versioning, Artifacts, and Rollback Automation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/security.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`
- Create: `.changeset/config.json`
- Create: `.changeset/README.md`
- Create: `scripts/release/check-version-sync.mjs`
- Create: `scripts/release/build-artifacts.mjs`
- Create: `scripts/release/verify-artifacts.mjs`
- Create: `docs/runbooks/deploy-control-plane.md`
- Create: `docs/runbooks/rollback-release.md`

- [ ] **Step 1: Add failing local release checks**

Assert root, protocol, control-plane, Harness plugin, Skill, generated package manifests, and changelog target one synchronized SemVer. Assert artifact manifest lists Control Plane image digest, plugin tarball digest, Skill archive digest, protocol compatibility, migration range, and source commit.

Run: `node scripts/release/check-version-sync.mjs && node scripts/release/verify-artifacts.mjs dist/release-manifest.json`
Expected: FAIL until scripts and artifacts exist.

- [ ] **Step 2: Implement required CI jobs**

`ci.yml` runs format, lint, typecheck, unit, contract, PostgreSQL integration, security tests, package builds, and documentation-link checks on Node 20 and current LTS where relevant. Use concurrency cancellation for superseded branches, least-privilege permissions, pinned action SHAs, and no secrets on pull-request jobs.

- [ ] **Step 3: Implement security automation**

Run dependency audit, Gitleaks, CodeQL, and Trivy on schedule and pull request. Upload machine-readable results with 14-day retention. A high/critical production finding blocks release unless a nonexpired documented exception exists.

- [ ] **Step 4: Implement Changesets and release artifacts**

Every package change requires a Changeset except docs/tests-only changes. Release workflow verifies `main`, clean tag, synchronized version, migrations, protocol compatibility, and acceptance evidence; then builds immutable artifacts and creates a draft GitHub Release. Publishing the draft remains an explicit owner action.

- [ ] **Step 5: Implement rollback checks**

Before deploy, verify the previous OCI image and package artifacts remain accessible. Database migrations use expand/contract and identify the minimum backward-compatible schema. Rollback script refuses if the target image cannot read the current schema or if Connector protocol overlap is absent.

- [ ] **Step 6: Verify and commit**

Run: `pnpm check && pnpm test && node scripts/release/check-version-sync.mjs`
Expected: PASS.

```bash
git add .github .changeset scripts/release docs/runbooks/deploy-control-plane.md docs/runbooks/rollback-release.md
git commit -m "ci: enforce protected release and rollback gates"
```

## Task 7: v0.4.0 Chaos Gate and Stable Private-Beta Qualification

**Files:**
- Create: `tests/performance/mcp-latency.test.ts`
- Create: `tests/e2e/stable-private-beta.test.ts`
- Create: `docs/product/v0.4.0-acceptance.md`
- Create: `docs/product/v1.0.0-acceptance.md`
- Create: `docs/product/known-limitations.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the bounded single-owner load test**

Seed 1,000 retained jobs and 10,000 events, then run 200 mixed status/result calls plus 20 sequential submissions. Measure server latency without network. Require `submit_task` p95 below 2 seconds, read p95 below 500 ms, no response above contractual bounds, and no unbounded query count.

Run: `pnpm vitest run tests/performance/mcp-latency.test.ts`
Expected: FAIL until query indexes/bounds meet the thresholds.

- [ ] **Step 2: Run the full chaos matrix for v0.4.0**

Use Toxiproxy to inject 0–30-second latency, connection reset, one-way partition, duplicate frames, and reorder at application reconnect boundaries. Restart each process at every persisted state. Required outcomes: no duplicate attempt, no invalid approval, one terminal state, reconnect recovery, accurate freshness, and query availability.

- [ ] **Step 3: Rehearse deploy and rollback**

Deploy the candidate image and packages to staging, migrate, run smoke tests, roll back to the previous compatible release, query existing jobs, then redeploy the candidate. Record image/package digests, schema versions, protocol negotiation, elapsed time, and operator observations.

- [ ] **Step 4: Record and tag v0.4.0**

Run: `pnpm check && pnpm test`
Expected: all stable-mode suites pass with RTC disabled and absent.

`docs/product/v0.4.0-acceptance.md` links reconciliation, security, restore, performance, and rollback evidence to the commit SHA.

- [ ] **Step 5: Run a seven-day owner dogfood window for v1.0.0**

Complete at least 30 real tasks across create/list/detail/approval/cancel/result flows, include one Mac restart and one Control Plane deploy, and record incidents. Exit criteria: zero authorization escapes, zero duplicate executions, zero lost terminal states, no unresolved severity-1/2 issue, and successful latest backup restore.

- [ ] **Step 6: Qualify stable private beta independently of RTC**

Run: `QHB_RTC_ENABLED=false pnpm vitest run tests/e2e/stable-private-beta.test.ts`
Expected: PASS all ten Spec acceptance items except the optional RTC behavior; item 9 passes by proving stable mode has no RTC dependency.

Record known limitations: private single owner, active-query progress model, no offline glasses push, one Mac Connector, repository aliases only, and experimental RTC excluded from stable support.

- [ ] **Step 7: Commit release evidence**

```bash
git add tests/performance tests/e2e/stable-private-beta.test.ts docs/product CHANGELOG.md
git commit -m "chore(release): qualify stable private beta"
```

## Plan Completion Evidence

This plan is complete only when:

- Reconnect/restart/duplicate/partition matrices preserve one product attempt and one terminal state.
- All deadline and retention boundaries are deterministic and idempotent.
- Threat-model mitigations have passing automated tests and no unaccepted high/critical finding.
- Logs and metrics are bounded, redacted, and linked to actionable alerts/runbooks.
- A fresh encrypted backup has been restored and functionally verified.
- CI and release workflows enforce synchronized version, protocol, migration, artifact, and rollback checks.
- `v0.4.0` acceptance is complete, and `v1.0.0` stable private-beta evidence can pass with RTC disabled.
