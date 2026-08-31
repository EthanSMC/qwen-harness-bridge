# Foundation and Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned shared protocol, PostgreSQL job coordinator, complete Qwen MCP tool surface, and fake-Connector end-to-end path for release `v0.1.0`.

**Architecture:** A TypeScript pnpm monorepo hosts runtime schemas in `packages/protocol` and a modular Fastify control plane in `apps/control-plane`. PostgreSQL owns jobs, events, approvals, connectors, repository aliases, and idempotency records; a fake outbound Connector proves dispatch, event, cancellation, and approval flows before DeepSeek Harness integration.

**Tech Stack:** Node.js 20+, pnpm workspaces, TypeScript strict mode, Zod, Fastify, Model Context Protocol TypeScript SDK, PostgreSQL, Drizzle ORM, WebSocket, Vitest, Testcontainers, Biome, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

## Global Constraints

- Every Qwen MCP tool targets a two-second server budget and must stay within the platform's three-second total limit.
- Protocol envelopes use `protocol_version: "1.0"`, UUID message IDs, monotonic sequence numbers, correlation IDs, and RFC 3339 timestamps.
- PostgreSQL is authoritative; state transitions and event append/read-model updates are transactional.
- Public job states are exactly `queued`, `dispatched`, `running`, `waiting_approval`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `expired`.
- Terminal states are immutable; connector health is a separate `fresh | stale | offline` dimension.
- Cloud responses and events never contain raw terminal logs, environment variables, source content, credentials, or absolute local paths.
- The stable asynchronous path is complete without RTC; no RTC code belongs in this plan.
- All packages compile under `strict: true`; runtime boundaries parse untrusted values with Zod.
- Every task ends with a focused commit and leaves `pnpm test` green.

---

## Planned File Map

```text
package.json                         workspace scripts and pinned package manager
pnpm-workspace.yaml                 workspace package discovery
tsconfig.base.json                  shared strict TypeScript settings
biome.json                          formatter and lint policy
vitest.workspace.ts                 package and integration test discovery
docker-compose.yml                  local PostgreSQL and control-plane runtime
.env.example                        non-secret configuration contract
packages/protocol/                  shared Zod schemas and inferred types
apps/control-plane/src/config.ts    validated environment configuration
apps/control-plane/src/db/          Drizzle schema, client, and repositories
apps/control-plane/src/domain/      job state machine and coordinator services
apps/control-plane/src/mcp/         authentication, tools, bounded presenters
apps/control-plane/src/connector/   WebSocket gateway, replay, and ACK handling
apps/control-plane/src/http/        Fastify app, health, and metrics routes
tests/contract/                     MCP and Connector protocol contracts
tests/integration/                  PostgreSQL and fake-Connector scenarios
```

## Task 1: Workspace Baseline and Protocol Package

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `vitest.workspace.ts`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/job.ts`
- Create: `packages/protocol/src/mcp.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/job.test.ts`

**Interfaces:**
- Produces: `JobStatusSchema`, `ConnectorHealthSchema`, `JobSummarySchema`, `SubmitTaskInputSchema`, `JobReceiptSchema`, and inferred TypeScript types from `@qhb/protocol`.
- Consumes: No earlier project code; values and limits come directly from the approved Spec sections 8 and 10.

- [ ] **Step 1: Add the failing protocol test**

```ts
// packages/protocol/src/job.test.ts
import { describe, expect, it } from "vitest";
import { JobReceiptSchema, JobStatusSchema, SubmitTaskInputSchema } from "./index.js";

describe("job protocol", () => {
  it("accepts only public job states", () => {
    expect(JobStatusSchema.parse("waiting_approval")).toBe("waiting_approval");
    expect(() => JobStatusSchema.parse("reconciling")).toThrow();
  });

  it("rejects arbitrary paths and oversized requests", () => {
    expect(() => SubmitTaskInputSchema.parse({
      client_request_id: crypto.randomUUID(),
      repository_id: "/Users/owner/repo",
      request: "run tests",
    })).toThrow();
    expect(() => SubmitTaskInputSchema.parse({
      client_request_id: crypto.randomUUID(),
      repository_id: "novelty-studio",
      request: "x".repeat(4001),
    })).toThrow();
  });

  it("parses the bounded submission receipt", () => {
    const value = JobReceiptSchema.parse({
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued",
      connector_status: "online",
      accepted_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-02T00:00:00.000Z",
    });
    expect(value.short_id).toBe("QH-7M2P");
  });
});
```

- [ ] **Step 2: Create the workspace manifests and install dependencies**

```json
// package.json
{
  "name": "qwen-harness-bridge",
  "private": true,
  "version": "0.1.0",
  "packageManager": "pnpm@10.15.1",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "check": "biome check . && pnpm typecheck && pnpm test",
    "format": "biome format --write .",
    "lint": "biome lint .",
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.2.2",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

Run: `corepack enable && pnpm install`
Expected: lockfile created and all workspace development dependencies installed.

- [ ] **Step 3: Run the test and verify the missing implementation failure**

Run: `pnpm vitest run packages/protocol/src/job.test.ts`
Expected: FAIL because `packages/protocol/src/index.ts` and exported schemas do not exist.

- [ ] **Step 4: Implement the bounded job and MCP schemas**

```ts
// packages/protocol/src/job.ts
import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued", "dispatched", "running", "waiting_approval", "cancelling",
  "succeeded", "failed", "cancelled", "expired",
]);
export const ConnectorHealthSchema = z.enum(["fresh", "stale", "offline"]);
export const RepositoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/);
export const ShortJobIdSchema = z.string().regex(/^QH-[A-Z0-9]{4}$/);

export const SubmitTaskInputSchema = z.object({
  client_request_id: z.string().uuid(),
  repository_id: RepositoryIdSchema,
  request: z.string().trim().min(1).max(4000),
  mode: z.enum(["normal", "read_only"]).default("normal"),
}).strict();

export const JobReceiptSchema = z.object({
  job_id: z.string().uuid(),
  short_id: ShortJobIdSchema,
  status: z.literal("queued"),
  connector_status: z.enum(["online", "offline"]),
  accepted_at: z.string().datetime(),
  expires_at: z.string().datetime(),
}).strict();

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type SubmitTaskInput = z.infer<typeof SubmitTaskInputSchema>;
export type JobReceipt = z.infer<typeof JobReceiptSchema>;
```

Create `packages/protocol/src/mcp.ts` with `ListTasksInputSchema`, `GetTaskInputSchema`, `CancelTaskInputSchema`, `ListPendingApprovalsInputSchema`, `DecideApprovalInputSchema`, and `GetTaskResultInputSchema` using the exact limits from Spec section 8. Re-export every schema and inferred type from `packages/protocol/src/index.ts`.

- [ ] **Step 5: Verify package checks**

Run: `pnpm vitest run packages/protocol/src/job.test.ts && pnpm typecheck`
Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit the workspace and first protocol contract**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json vitest.workspace.ts packages/protocol
git commit -m "feat(protocol): define job and mcp contracts"
```

## Task 2: Connector Envelope and Job State Machine

**Files:**
- Create: `packages/protocol/src/connector.ts`
- Create: `packages/protocol/src/connector.test.ts`
- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/src/domain/job-state.ts`
- Test: `apps/control-plane/src/domain/job-state.test.ts`

**Interfaces:**
- Consumes: `JobStatus` from `@qhb/protocol`.
- Produces: `EnvelopeSchema`, all Connector client/server payload schemas, `canTransition(from, to)`, `assertTransition(from, to)`, and `TERMINAL_JOB_STATES`.

- [ ] **Step 1: Write failing envelope and transition tests**

```ts
// apps/control-plane/src/domain/job-state.test.ts
import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "./job-state.js";

describe("job state machine", () => {
  it("permits the approved lifecycle", () => {
    expect(canTransition("queued", "dispatched")).toBe(true);
    expect(canTransition("running", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
    expect(canTransition("cancelling", "succeeded")).toBe(true);
  });

  it("keeps terminal states immutable", () => {
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(() => assertTransition("cancelled", "running")).toThrow("INVALID_JOB_TRANSITION");
  });
});
```

```ts
// packages/protocol/src/connector.test.ts
import { describe, expect, it } from "vitest";
import { ConnectorEnvelopeSchema } from "./connector.js";

describe("connector envelope", () => {
  it("rejects unsupported versions and invalid expiry", () => {
    const base = {
      protocol_version: "2.0", message_id: crypto.randomUUID(), sequence: 1,
      sent_at: "2026-09-01T00:00:00.000Z", expires_at: "2026-09-01T00:01:00.000Z",
      correlation_id: crypto.randomUUID(), type: "ack", payload: { sequence: 1 },
    };
    expect(() => ConnectorEnvelopeSchema.parse(base)).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `pnpm vitest run packages/protocol/src/connector.test.ts apps/control-plane/src/domain/job-state.test.ts`
Expected: FAIL because Connector schemas and state-machine functions are missing.

- [ ] **Step 3: Implement the exact transition table**

```ts
// apps/control-plane/src/domain/job-state.ts
import type { JobStatus } from "@qhb/protocol";

const transitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["dispatched", "cancelled", "expired"]),
  dispatched: new Set(["running", "cancelled", "expired"]),
  running: new Set(["waiting_approval", "cancelling", "succeeded", "failed", "expired"]),
  waiting_approval: new Set(["running", "cancelling", "failed", "expired"]),
  cancelling: new Set(["cancelled", "succeeded", "failed", "expired"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), expired: new Set(),
};

export const TERMINAL_JOB_STATES = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);
export const canTransition = (from: JobStatus, to: JobStatus) => transitions[from].has(to);
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`INVALID_JOB_TRANSITION:${from}:${to}`);
}
```

- [ ] **Step 4: Implement the versioned Connector discriminated union**

In `packages/protocol/src/connector.ts`, define strict Zod payloads for `connector.hello`, `connector.heartbeat`, `job.claim`, `job.event`, `approval.requested`, `job.cancelled`, `connector.welcome`, `job.offer`, `job.cancel`, `approval.decision`, `ack`, and `protocol.error`. Wrap them in a discriminated union with common fields and enforce `sequence >= 1` and `protocol_version === "1.0"`.

Use these exact shared type names:

```ts
export type ConnectorClientMessage = z.infer<typeof ConnectorClientMessageSchema>;
export type ConnectorServerMessage = z.infer<typeof ConnectorServerMessageSchema>;
export type JobOfferPayload = z.infer<typeof JobOfferPayloadSchema>;
export type JobEventPayload = z.infer<typeof JobEventPayloadSchema>;
export type ApprovalDecisionPayload = z.infer<typeof ApprovalDecisionPayloadSchema>;
```

- [ ] **Step 5: Run protocol and domain tests**

Run: `pnpm vitest run packages/protocol apps/control-plane/src/domain/job-state.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the state-machine boundary**

```bash
git add packages/protocol apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/src/domain
git commit -m "feat(control-plane): add connector protocol and job state machine"
```

## Task 3: PostgreSQL Schema and Transactional Job Repository

**Files:**
- Create: `apps/control-plane/drizzle.config.ts`
- Create: `apps/control-plane/src/config.ts`
- Create: `apps/control-plane/src/db/client.ts`
- Create: `apps/control-plane/src/db/schema.ts`
- Create: `apps/control-plane/src/db/job-repository.ts`
- Create: `apps/control-plane/src/db/migrations/0001_initial.sql`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Test: `tests/integration/job-repository.test.ts`

**Interfaces:**
- Consumes: job/MCP types from `@qhb/protocol` and `assertTransition` from Task 2.
- Produces: `JobRepository.createIdempotent`, `JobRepository.get`, `JobRepository.list`, `JobRepository.transitionAndAppend`, `JobRepository.claimOffer`, and `JobRepository.recordApprovalDecision`.

- [ ] **Step 1: Write the failing transactional repository test**

```ts
// tests/integration/job-repository.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./support/postgres.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";

describe("JobRepository", () => {
  const db = createTestDatabase();
  beforeAll(() => db.start());
  afterAll(() => db.stop());

  it("creates one job for a repeated idempotency key", async () => {
    const repo = new JobRepository(db.client);
    const input = { ownerId: "owner-1", clientRequestId: crypto.randomUUID(), repositoryId: "novelty-studio", requestCiphertext: "cipher", requestDigest: "digest" };
    const first = await repo.createIdempotent(input);
    const second = await repo.createIdempotent(input);
    expect(second.jobId).toBe(first.jobId);
  });

  it("appends an event in the same transaction as the state revision", async () => {
    const repo = new JobRepository(db.client);
    const job = await repo.createIdempotent({ ownerId: "owner-1", clientRequestId: crypto.randomUUID(), repositoryId: "novelty-studio", requestCiphertext: "cipher", requestDigest: "digest" });
    const updated = await repo.transitionAndAppend(job.jobId, 0, "dispatched", { type: "job.dispatched", payload: {} });
    expect(updated.revision).toBe(1);
    expect((await repo.events(job.jobId))[0]?.sequence).toBe(1);
  });
});
```

- [ ] **Step 2: Start PostgreSQL and verify the test fails**

Run: `docker compose up -d postgres && pnpm vitest run tests/integration/job-repository.test.ts`
Expected: FAIL because the migration, test support, and repository do not exist.

- [ ] **Step 3: Define the database schema and migration**

Create Drizzle tables named `owners`, `connectors`, `repository_policies`, `jobs`, `job_events`, `approvals`, `idempotency_records`, and `connector_messages`. Include:

- Unique `(owner_id, client_request_id)` on idempotency records.
- Unique `(job_id, sequence)` on job events.
- Unique `(connector_id, direction, sequence)` on Connector messages.
- Integer `revision NOT NULL DEFAULT 0` on jobs.
- Encrypted request ciphertext plus digest, never plaintext request columns.
- `expires_at`, `request_delete_at`, and `retention_delete_at` timestamps.

Run: `pnpm --filter @qhb/control-plane drizzle-kit generate`
Expected: generated SQL matches `0001_initial.sql` and includes all constraints.

- [ ] **Step 4: Implement optimistic transactional repository methods**

`transitionAndAppend` must execute one database transaction, lock the current job revision, call `assertTransition`, update only when `revision = expectedRevision`, append exactly one next-sequence event, and return `REVISION_CONFLICT` when the conditional update affects zero rows.

`createIdempotent` must compare request digests. Equal digest returns the original job; unequal digest throws `IDEMPOTENCY_CONFLICT`.

- [ ] **Step 5: Run integration tests and inspect constraints**

Run: `pnpm vitest run tests/integration/job-repository.test.ts`
Expected: PASS.

Run: `docker compose exec postgres psql -U qhb -d qhb -c '\d jobs'`
Expected: `revision`, status check, expiry fields, and foreign keys are present.

- [ ] **Step 6: Commit the persistent state layer**

```bash
git add .env.example docker-compose.yml apps/control-plane/drizzle.config.ts apps/control-plane/src/config.ts apps/control-plane/src/db tests/integration
git commit -m "feat(control-plane): persist jobs and events transactionally"
```

## Task 4: Job Coordinator and Complete MCP Tool Surface

**Files:**
- Create: `apps/control-plane/src/domain/errors.ts`
- Create: `apps/control-plane/src/domain/job-coordinator.ts`
- Create: `apps/control-plane/src/domain/presenters.ts`
- Create: `apps/control-plane/src/mcp/auth.ts`
- Create: `apps/control-plane/src/mcp/server.ts`
- Create: `apps/control-plane/src/mcp/tools.ts`
- Create: `apps/control-plane/src/http/app.ts`
- Create: `apps/control-plane/src/main.ts`
- Test: `tests/contract/mcp-tools.test.ts`
- Test: `apps/control-plane/src/domain/job-coordinator.test.ts`

**Interfaces:**
- Consumes: Task 1 MCP schemas and Task 3 `JobRepository`.
- Produces: all seven public MCP tools and `JobCoordinator` methods `submit`, `list`, `get`, `cancel`, `listApprovals`, `decideApproval`, and `getResult`.

- [ ] **Step 1: Write failing idempotency, cancellation, and bounded-output tests**

```ts
// apps/control-plane/src/domain/job-coordinator.test.ts
it("returns the same receipt for an identical client request", async () => {
  const first = await coordinator.submit(owner, input);
  const second = await coordinator.submit(owner, input);
  expect(second.job_id).toBe(first.job_id);
});

it("cancels queued work immediately and rejects a stale revision", async () => {
  const job = await coordinator.submit(owner, input);
  await expect(coordinator.cancel(owner, { job_id: job.job_id, expected_revision: 7 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  const cancelled = await coordinator.cancel(owner, { job_id: job.job_id, expected_revision: 0 });
  expect(cancelled.status).toBe("cancelled");
});
```

```ts
// tests/contract/mcp-tools.test.ts
it("returns submit_task inside the two-second service budget", async () => {
  const started = performance.now();
  const result = await mcp.callTool("submit_task", validSubmit);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(result.structuredContent.status).toBe("queued");
});
```

- [ ] **Step 2: Run focused tests to establish failure**

Run: `pnpm vitest run apps/control-plane/src/domain/job-coordinator.test.ts tests/contract/mcp-tools.test.ts`
Expected: FAIL because the coordinator and MCP server are missing.

- [ ] **Step 3: Implement stable domain errors and bounded presenters**

Define `DomainErrorCode` as the exact Spec section 12 codes plus `REVISION_CONFLICT` and `UNAUTHENTICATED`. Presenters must:

- Limit list output to five items.
- Limit recent events to five.
- Strip internal IDs other than job/approval IDs.
- Convert absolute paths to configured repository display names or relative paths.
- Truncate titles to 40 and stage text to 36 Chinese characters without splitting surrogate pairs.

- [ ] **Step 4: Implement the coordinator methods**

`submit` validates repository ownership, encrypts the request, writes idempotency/job records, derives the seven-character short ID as `QH-` plus four Crockford Base32 characters (for example `QH-7M2P`), and returns connector online/offline status. `cancel` implements queued-immediate and running-`cancelling` behavior. `decideApproval` accepts only the first unexpired matching revision and schedules one decision message.

- [ ] **Step 5: Register and authenticate all MCP tools**

Register exact names:

```ts
const publicToolNames = [
  "submit_task", "list_tasks", "get_task", "cancel_task",
  "list_pending_approvals", "decide_approval", "get_task_result",
] as const;
```

`auth.ts` compares the configured Bearer token with `timingSafeEqual`, rejects missing or multiple Authorization headers, and binds every request to the single configured owner. Tool handlers parse with the protocol schemas and map `DomainError` to stable MCP error content without stack traces.

- [ ] **Step 6: Run contract, timing, and type checks**

Run: `pnpm vitest run apps/control-plane/src/domain/job-coordinator.test.ts tests/contract/mcp-tools.test.ts && pnpm typecheck`
Expected: PASS; timing test remains below 2000 ms on local PostgreSQL.

- [ ] **Step 7: Commit the complete public API**

```bash
git add apps/control-plane/src/domain apps/control-plane/src/mcp apps/control-plane/src/http apps/control-plane/src/main.ts tests/contract
git commit -m "feat(mcp): expose asynchronous task control tools"
```

## Task 5: Connector Gateway, Replay, and Fake Connector

**Files:**
- Create: `apps/control-plane/src/connector/auth.ts`
- Create: `apps/control-plane/src/connector/session.ts`
- Create: `apps/control-plane/src/connector/gateway.ts`
- Create: `apps/control-plane/src/connector/outbox.ts`
- Create: `tests/integration/support/fake-connector.ts`
- Create: `tests/integration/connector-gateway.test.ts`
- Create: `tests/integration/foundation-e2e.test.ts`

**Interfaces:**
- Consumes: Connector schemas from Task 2, `JobCoordinator` from Task 4, and Connector message persistence from Task 3.
- Produces: `/connector/v1` WebSocket endpoint, session token exchange, replayable server outbox, ACK processing, and `FakeConnector` test client.

- [ ] **Step 1: Write the failing dispatch/reconnect scenario**

```ts
// tests/integration/foundation-e2e.test.ts
it("dispatches once and restores event delivery after reconnect", async () => {
  const connector = await FakeConnector.connect(app, credentials);
  const receipt = await mcp.callTool("submit_task", validSubmit);
  const offer = await connector.next("job.offer");
  expect(offer.payload.job_id).toBe(receipt.structuredContent.job_id);

  await connector.send("job.claim", { job_id: offer.payload.job_id, attempt: 1, lease_id: offer.payload.lease_id });
  await connector.disconnectWithoutAck();
  const resumed = await FakeConnector.connect(app, { ...credentials, last_server_sequence: 0 });
  expect((await resumed.next("ack")).sequence).toBeGreaterThan(0);
  expect(resumed.received.filter((m) => m.type === "job.offer")).toHaveLength(0);
});
```

- [ ] **Step 2: Run the scenario to verify failure**

Run: `pnpm vitest run tests/integration/connector-gateway.test.ts tests/integration/foundation-e2e.test.ts`
Expected: FAIL because `/connector/v1` and `FakeConnector` do not exist.

- [ ] **Step 3: Implement Connector session authentication**

Create a bootstrap endpoint that accepts the per-Connector credential ID and secret, compares the stored hash, and returns a signed 15-minute session token containing `owner_id`, `connector_id`, `protocol_version`, `iat`, and `exp`. The WebSocket endpoint accepts only that token and rejects Qwen MCP credentials.

- [ ] **Step 4: Implement sequence, outbox, heartbeat, and replay**

For each connector direction, persist the next sequence transactionally. Retain unacknowledged server messages in `connector_messages`. On `connector.hello`, send `connector.welcome`, replay all server messages after `last_server_sequence`, and reject a sequence gap from the client with `protocol.error`.

Heartbeat constants:

```ts
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const CONNECTOR_STALE_AFTER_MS = 20_000;
export const CONNECTOR_OFFLINE_AFTER_MS = 30_000;
export const OFFER_LEASE_MS = 30_000;
```

- [ ] **Step 5: Implement claim and event ingestion**

`job.claim` uses compare-and-swap on `queued|dispatched`, attempt, and lease ID. `job.event` verifies the claimed attempt, validates the event schema, redacts payload fields, and appends exactly one sequence. Duplicate message IDs return ACK without a second event.

- [ ] **Step 6: Run reconnect and duplicate-delivery tests**

Run: `pnpm vitest run tests/integration/connector-gateway.test.ts tests/integration/foundation-e2e.test.ts`
Expected: PASS, including disconnect-before-ACK replay and duplicate event deduplication.

- [ ] **Step 7: Commit the outbound Connector boundary**

```bash
git add apps/control-plane/src/connector tests/integration
git commit -m "feat(connector): add authenticated dispatch and replay gateway"
```

## Task 6: Approval, Cancellation, and Terminal Result End-to-End

**Files:**
- Modify: `apps/control-plane/src/domain/job-coordinator.ts`
- Modify: `apps/control-plane/src/connector/gateway.ts`
- Modify: `tests/integration/support/fake-connector.ts`
- Create: `tests/integration/approval-flow.test.ts`
- Create: `tests/integration/cancellation-flow.test.ts`
- Create: `tests/integration/result-flow.test.ts`

**Interfaces:**
- Consumes: `approval.requested`, `approval.decision`, `job.cancel`, and `job.event` protocol messages.
- Produces: one-time approval decisions, cancellation race behavior, immutable terminal summaries, and unread-result acknowledgement.

- [ ] **Step 1: Add failing approval fingerprint tests**

```ts
it("rejects a decision after the action fingerprint changes", async () => {
  const approval = await fakeConnector.requestApproval({ action_fingerprint: "sha256:one", job_revision: 3 });
  await repository.supersedeApproval(approval.id, "sha256:two", 4);
  await expect(coordinator.decideApproval(owner, {
    approval_id: approval.id, decision: "approve", expected_job_revision: 3,
  })).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
});
```

- [ ] **Step 2: Add failing cancellation-race and result-acknowledgement tests**

Test that a running job moves to `cancelling`, a success event arriving before cancel ACK wins as `succeeded`, a later cancel ACK is ignored and audited, and repeated `get_task_result` returns the same `acknowledged_at`.

- [ ] **Step 3: Run the three focused suites and verify failure**

Run: `pnpm vitest run tests/integration/approval-flow.test.ts tests/integration/cancellation-flow.test.ts tests/integration/result-flow.test.ts`
Expected: FAIL on missing approval supersession, cancellation arbitration, and result acknowledgement.

- [ ] **Step 4: Implement canonical approval decisions**

Hash `job_id`, attempt, revision, canonical tool/executable, canonical arguments, canonical working directory, and risk class with SHA-256. Store the fingerprint on approval creation. Expiry sets `decision=reject` and emits one `approval.decision` message. The first valid explicit decision wins via conditional update `WHERE decision IS NULL AND expires_at > now()`.

- [ ] **Step 5: Implement terminal arbitration and unread result semantics**

Accept the first valid terminal transition by job revision. Record later incompatible terminal messages as audit events without changing the job. `get_task_result` sets `acknowledged_at` only when null and returns the existing timestamp on repeat calls.

- [ ] **Step 6: Run all control-plane tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit complete task-control behavior**

```bash
git add apps/control-plane/src tests/integration
git commit -m "feat(control-plane): complete approval cancellation and result flows"
```

## Task 7: Container Runtime, Health, Metrics, and Release Gate

**Files:**
- Modify: `docker-compose.yml`
- Create: `apps/control-plane/Dockerfile`
- Create: `apps/control-plane/src/http/health.ts`
- Create: `apps/control-plane/src/http/metrics.ts`
- Create: `tests/contract/health-metrics.test.ts`
- Create: `docs/runbooks/control-plane-local.md`
- Create: `docs/product/v0.1.0-acceptance.md`

**Interfaces:**
- Consumes: complete control-plane app and fake Connector.
- Produces: `/health/live`, `/health/ready`, `/metrics`, reproducible OCI image, local runbook, and `v0.1.0` acceptance evidence.

- [ ] **Step 1: Write failing health separation and metric-name tests**

```ts
it("keeps liveness independent from database readiness", async () => {
  db.simulateUnavailable();
  expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
});

it("exports stable metric names", async () => {
  const body = (await app.inject({ url: "/metrics" })).body;
  expect(body).toContain("qhb_mcp_submit_duration_seconds");
  expect(body).toContain("qhb_connector_online");
  expect(body).toContain("qhb_job_queue_age_seconds");
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm vitest run tests/contract/health-metrics.test.ts`
Expected: FAIL because health and metrics routes are missing.

- [ ] **Step 3: Implement health and bounded metrics**

Liveness reports only event-loop/process health. Readiness checks PostgreSQL migration version and write/read transaction. Metrics use bounded labels: job status, message type, and stable error code; never job ID, owner ID, repository name, or prompt content.

- [ ] **Step 4: Build and run the OCI image**

Run: `docker compose build control-plane && docker compose up -d && docker compose ps`
Expected: PostgreSQL and control-plane are healthy.

- [ ] **Step 5: Execute the foundation release gate**

Run: `pnpm check && pnpm vitest run tests/integration/foundation-e2e.test.ts`
Expected: all checks pass and fake Connector completes submit → claim → progress → approval → result.

Run: `curl -fsS http://localhost:8080/health/ready`
Expected: JSON `{ "status": "ready" }`.

- [ ] **Step 6: Record exact acceptance evidence**

In `docs/product/v0.1.0-acceptance.md`, record command, commit SHA, timestamp, observed submit latency, reconnect case, approval case, and final pass/fail for every Spec section 16 requirement covered by this plan.

- [ ] **Step 7: Commit the foundation release candidate**

```bash
git add apps/control-plane/Dockerfile apps/control-plane/src/http docker-compose.yml tests/contract docs/runbooks docs/product
git commit -m "chore(release): prepare v0.1.0 control plane baseline"
```

## Plan Completion Evidence

This plan is complete only when all of the following are authoritative and green:

- `pnpm check`
- PostgreSQL integration suites with Testcontainers or Docker Compose
- Full MCP contract suite for all seven tools
- Fake Connector end-to-end including reconnect, duplicate delivery, approval, cancellation, and result acknowledgement
- OCI image health/readiness verification
- `docs/product/v0.1.0-acceptance.md` tied to the tested commit SHA
