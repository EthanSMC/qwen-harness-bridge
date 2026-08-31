# Harness Plugin and Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the `v0.1.0` Control Plane to a real DeepSeek Harness instance on the owner's Mac, enforce repository-scoped policy locally, restore work after reconnect, and release the stable asynchronous loop as `v0.2.0`.

**Architecture:** `packages/harness-plugin` is both a Cordis extension and an outbound Connector. The extension exports `apply(ctx)`, owns only the Harness Agents that it creates, persists cloud-to-Harness mappings plus an outbox in SQLite, and talks to the Control Plane through an authenticated TLS WebSocket. Pure adapters isolate official Harness APIs from product orchestration. A local policy guard is authoritative: cloud approval may release `approval_required`, but can never release `denied`.

**Tech Stack:** TypeScript strict mode, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-user-approval`, Zod, `ws`, `better-sqlite3`, Node `child_process.spawn`, Vitest, and the shared `@qhb/protocol` package.

**Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

**Official Harness contracts used:** extension `apply(ctx)`; `ctx.agents.create/resume/get`; `Agent.followup`, `cancel`, `whenIdle`; `session/event`; `tools/pre-execute`; `approval/request`; and closed approval outcomes where only `allowed-once` grants access.

## Global Constraints

- Never expose Harness's built-in HTTP server or a local shell to the public internet.
- The Connector initiates every network connection and accepts commands only through the authenticated, versioned protocol from Plan 1.
- The product `job_id` is authoritative across devices. Harness `SessionId` and native `JobId` are local implementation identifiers stored only in the mapping table.
- The plugin handles only Agents it creates; unrelated local Harness sessions and approvals always delegate to the next listener.
- Every path is resolved with `realpath`; both repository root and target must remain inside the same canonical allow-listed root.
- No command payload from the glasses is executed as shell text. The user request enters Harness as a `UserMessage`.
- SQLite commits a received command before ACK and commits an outbound event before send.
- Only redacted, bounded event summaries leave the Mac. Full logs stay local for seven days.
- Cancellation is idempotent. A terminal Harness result wins over a late cancel acknowledgement.
- Every task ends with a focused commit and leaves `pnpm test` green.

---

## Planned File Map

```text
packages/harness-plugin/package.json             extension package and exports
packages/harness-plugin/src/index.ts             Cordis apply(ctx) entry point
packages/harness-plugin/src/config.ts            validated local configuration
packages/harness-plugin/src/keychain.ts          macOS Keychain credential reader
packages/harness-plugin/src/store/               SQLite migrations and repository
packages/harness-plugin/src/transport/           WebSocket, ACK, replay, heartbeat
packages/harness-plugin/src/policy/              canonical action classifier
packages/harness-plugin/src/harness/             Agent/session adapter and normalizer
packages/harness-plugin/src/approvals/            remote approval answerer
packages/harness-plugin/src/runtime/              command coordinator and recovery
packages/harness-plugin/src/redaction/            outbound data minimization
tests/contract/harness-plugin-shape.test.ts       Cordis plugin contract
tests/integration/harness-connector-e2e.test.ts   real adapter with fake Harness context
tests/security/local-policy.test.ts               local trust-boundary cases
docs/runbooks/install-harness-plugin.md           installation and rollback
docs/product/v0.2.0-acceptance.md                 release evidence
```

## Task 1: Package, Configuration, Keychain, and SQLite State

**Files:**
- Create: `packages/harness-plugin/package.json`
- Create: `packages/harness-plugin/tsconfig.json`
- Create: `packages/harness-plugin/src/config.ts`
- Create: `packages/harness-plugin/src/keychain.ts`
- Create: `packages/harness-plugin/src/store/schema.sql`
- Create: `packages/harness-plugin/src/store/plugin-store.ts`
- Test: `packages/harness-plugin/src/config.test.ts`
- Test: `packages/harness-plugin/src/store/plugin-store.test.ts`

**Interfaces:**

```ts
export type PluginConfig = {
  connectorId: string;
  controlPlaneUrl: `wss://${string}`;
  keychainService: string;
  keychainAccount: string;
  databasePath: string;
  repositories: ReadonlyArray<{
    id: string;
    displayName: string;
    canonicalPath: string;
    approvalTimeoutSeconds: number;
  }>;
};

export interface CredentialReader {
  read(service: string, account: string): Promise<string>;
}

export interface PluginStore {
  recordInbound(messageId: string, sequence: number, body: string): "new" | "duplicate";
  mapJob(input: { jobId: string; attempt: number; sessionId: string; status: string }): void;
  findJob(jobId: string): LocalJobMapping | undefined;
  enqueueEvent(event: StoredOutboundEvent): void;
  pendingEvents(afterSequence: number): StoredOutboundEvent[];
  acknowledgeEvent(messageId: string): void;
  close(): void;
}
```

- [ ] **Step 1: Write failing configuration and persistence tests**

Cover rejection of `ws://`, duplicate repository IDs, nonexistent/noncanonical roots, approval timeout outside 60–1800 seconds, duplicate inbound IDs, monotonic local event sequences, and reopening the SQLite file after simulated process exit.

Run: `pnpm vitest run packages/harness-plugin/src/config.test.ts packages/harness-plugin/src/store/plugin-store.test.ts`
Expected: FAIL because the package and implementation do not exist.

- [ ] **Step 2: Add the package and exact runtime dependencies**

The package exports `.` from `dist/index.js`, declares the six official `@deepseek-ai/*` packages as peer dependencies matching the installed Harness release, and keeps `@qhb/protocol`, Zod, `ws`, and `better-sqlite3` as runtime dependencies. Add it to the root build, typecheck, and test scripts.

- [ ] **Step 3: Implement validated configuration**

Parse one JSON configuration object at plugin startup. Resolve each configured path with `realpath`, reject a symlinked root whose canonical path differs from the explicit configured canonical path, freeze the returned object, and emit only repository IDs in validation errors.

- [ ] **Step 4: Implement a non-shell Keychain reader**

Use `spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"])`; never use `exec`, never log stdout, cap stderr at 1 KiB, and convert nonzero exit into `CONNECTOR_CREDENTIAL_UNAVAILABLE`.

- [ ] **Step 5: Implement and migrate SQLite atomically**

Use WAL mode and tables `inbound_messages`, `job_mappings`, `outbound_events`, and `metadata`. `job_mappings` has unique `(job_id, attempt)` and unique `session_id`. `outbound_events` keeps payload JSON, message ID, sequence, attempts, and acknowledged timestamp. Migration version is stored in `PRAGMA user_version`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run packages/harness-plugin/src/config.test.ts packages/harness-plugin/src/store/plugin-store.test.ts`
Expected: PASS, including close/reopen recovery.

```bash
git add package.json packages/harness-plugin
git commit -m "feat(connector): add local configuration and durable store"
```

## Task 2: Outbound Connector Transport, ACK, and Replay

**Files:**
- Create: `packages/harness-plugin/src/transport/session-token-client.ts`
- Create: `packages/harness-plugin/src/transport/connector-client.ts`
- Create: `packages/harness-plugin/src/transport/backoff.ts`
- Test: `packages/harness-plugin/src/transport/connector-client.test.ts`
- Test: `tests/contract/connector-version-negotiation.test.ts`

**Interfaces:**

```ts
export interface ConnectorClient {
  start(signal: AbortSignal): Promise<void>;
  publish(type: ClientMessageType, payload: unknown, correlationId: string): Promise<void>;
  onCommand(handler: (command: ServerEnvelope) => Promise<void>): () => void;
}

export interface SessionTokenClient {
  exchange(input: { connectorId: string; bootstrapCredential: string }): Promise<{
    token: string;
    expiresAt: string;
  }>;
}
```

- [ ] **Step 1: Write failing transport tests with a local TLS WebSocket fixture**

Assert bootstrap exchange, `connector.hello`, negotiated protocol `1.0`, heartbeat every 10 seconds, ACK only after durable receipt, duplicate command suppression, replay of unacknowledged outbound events, token refresh before expiry, exponential reconnect delays of 1/2/4/8/16/30 seconds with 20% jitter, and shutdown through `AbortSignal`.

Run: `pnpm vitest run packages/harness-plugin/src/transport/connector-client.test.ts tests/contract/connector-version-negotiation.test.ts`
Expected: FAIL because the transport is missing.

- [ ] **Step 2: Implement credential exchange and TLS restrictions**

Require `https:` for token exchange and `wss:` for WebSocket. Use the platform CA store; do not expose an option to disable certificate validation. Keep the bootstrap credential only in the stack frame needed for exchange and replace it with the returned short-lived token.

- [ ] **Step 3: Implement receive-before-ACK semantics**

Parse with shared Zod schemas, reject wrong version/expired timestamp/invalid sequence, insert the envelope into SQLite, dispatch a new message exactly once, then enqueue its ACK. A duplicate valid message is not dispatched but still receives an ACK.

- [ ] **Step 4: Implement durable send and replay**

`publish` first writes an outbound row. The send loop transmits rows in sequence, leaves them pending across socket loss, and marks only a matching server ACK as acknowledged. On `connector.welcome`, resume from the lower of local pending sequence and server replay cursor without renumbering events.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run packages/harness-plugin/src/transport/connector-client.test.ts tests/contract/connector-version-negotiation.test.ts`
Expected: PASS with fake timers and no external network.

```bash
git add packages/harness-plugin/src/transport tests/contract/connector-version-negotiation.test.ts
git commit -m "feat(connector): add authenticated websocket replay transport"
```

## Task 3: Canonical Repository and Action Policy Engine

**Files:**
- Create: `packages/harness-plugin/src/policy/types.ts`
- Create: `packages/harness-plugin/src/policy/canonical-path.ts`
- Create: `packages/harness-plugin/src/policy/action-classifier.ts`
- Create: `packages/harness-plugin/src/policy/register-guard.ts`
- Test: `tests/security/local-policy.test.ts`
- Test: `packages/harness-plugin/src/policy/action-classifier.test.ts`

**Interfaces:**

```ts
export type PolicyClass = "automatic" | "approval_required" | "denied";

export type CanonicalAction = {
  toolName: string;
  executable?: string;
  argv: readonly string[];
  cwd: string;
  repositoryId: string;
  touchedPaths: readonly string[];
  environmentRead: "none" | "declared" | "arbitrary";
  networkIntent: "none" | "read" | "write";
  fileChange: "none" | "bounded" | "destructive";
  externalSideEffect: "none" | "message" | "deploy" | "purchase";
};

export type PolicyDecision = {
  classification: PolicyClass;
  fingerprint: string;
  reasonCode: string;
  actionSummary: string;
  impactSummary: string;
};
```

- [ ] **Step 1: Write a table-driven failing policy suite**

Automatic cases: file reads, search, tests, builds, and bounded edits wholly inside the repository. Approval cases: package install, git push, deploy, network write, external message, destructive edit. Denied cases: arbitrary command supplied by cloud, Keychain access, secret/environment dump, system settings, absolute path outside root, `..` traversal, and symlink escape. Verify the fingerprint is stable for equivalent canonical actions and changes when material arguments change.

Run: `pnpm vitest run packages/harness-plugin/src/policy/action-classifier.test.ts tests/security/local-policy.test.ts`
Expected: FAIL because the classifier is absent.

- [ ] **Step 2: Implement canonical path containment**

Resolve existing targets with `realpath`; for new targets, resolve the nearest existing ancestor, append normalized remaining segments, and confirm `relative(root, target)` is neither absolute nor prefixed by `..`. Recheck immediately before execution to close symlink swap races.

- [ ] **Step 3: Implement structured classification and SHA-256 fingerprinting**

Create canonical JSON by sorting object keys and preserving argument order, then hash `repositoryId`, tool identity, executable, arguments, paths, and side-effect flags. Human summaries never participate in authorization.

- [ ] **Step 4: Register the monotonic Harness tool guard**

Use `ctx.tools.guard()` for unconditional `denied` outcomes so later plugins cannot reopen them. Use `tools/pre-execute` to convert `approval_required` into Harness's standard approval request path. Do not register the guard globally; register it in the scoped context passed to each bridge-owned Agent's `setup` callback.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run packages/harness-plugin/src/policy/action-classifier.test.ts tests/security/local-policy.test.ts`
Expected: PASS for every matrix row and symlink-race fixture.

```bash
git add packages/harness-plugin/src/policy tests/security/local-policy.test.ts
git commit -m "feat(policy): enforce canonical repository action policy"
```

## Task 4: Official Harness Agent and Session Adapter

**Files:**
- Create: `packages/harness-plugin/src/harness/types.ts`
- Create: `packages/harness-plugin/src/harness/agent-adapter.ts`
- Create: `packages/harness-plugin/src/harness/event-normalizer.ts`
- Create: `packages/harness-plugin/src/harness/register-session-listener.ts`
- Test: `packages/harness-plugin/src/harness/agent-adapter.test.ts`
- Test: `packages/harness-plugin/src/harness/event-normalizer.test.ts`

**Interfaces:**

```ts
export interface HarnessAgentAdapter {
  create(input: { jobId: string; repositoryPath: string; request: string }): Promise<{
    sessionId: string;
  }>;
  resume(input: { jobId: string; sessionId: string }): Promise<void>;
  cancel(jobId: string): Promise<"requested" | "already_idle" | "unknown">;
  dispose(): Promise<void>;
}

export type NormalizedHarnessEvent = {
  jobId: string;
  type: "stage.changed" | "progress.updated" | "tool.started" | "tool.finished" | "job.succeeded" | "job.failed";
  stage: string;
  summary: string;
  occurredAt: string;
};
```

- [ ] **Step 1: Write failing adapter tests against a typed fake Context**

Assert `ctx.agents.create({ id: SessionId(...), meta: { cwd }, agentOptions, setup })`, `createUserMessage`, `agent.followup(message)`, `agent.whenIdle()`, `ctx.agents.resume({ resumeSessionId, ... })`, `agent.cancel({ kind: "user" })`, and `AgentHandle.dispose()`. Assert no event from an unrelated session is emitted.

Run: `pnpm vitest run packages/harness-plugin/src/harness/agent-adapter.test.ts packages/harness-plugin/src/harness/event-normalizer.test.ts`
Expected: FAIL because the adapter is absent.

- [ ] **Step 2: Implement create and resume without correlating followup to turn end**

Mint a branded `SessionId` from a local UUID, call `ctx.agents.create`, save the mapping before `followup`, then send a `createUserMessage({ content: [{ type: "text", text: request }], source: { kind: "user" } })`. Treat `followup()` only as enqueue; whole-job completion is determined from the owned session event stream plus `whenIdle`, not by assuming a message owns a later `turn/end`.

- [ ] **Step 3: Normalize only bounded durable events**

Listen to `session/event`. Convert turn/step boundaries, tool call/result, assistant message, and turn-end reason into stage and terminal summaries. Drop reasoning deltas, raw arguments, absolute paths, and text chunks from cloud events. A successful idle transition is terminal only after a committed terminal turn event.

- [ ] **Step 4: Persist Harness identifiers and recover live mappings**

On startup, inspect nonterminal mappings. Resume persisted sessions through `ctx.agents.resume`; if persistence is unavailable or the session cannot load, emit one `job.failed` with `HARNESS_SESSION_LOST`. Never create a second Agent for the same `(job_id, attempt)`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run packages/harness-plugin/src/harness`
Expected: PASS, including unrelated-session isolation and dispose quiescence.

```bash
git add packages/harness-plugin/src/harness
git commit -m "feat(harness): adapt owned agents and session events"
```

## Task 5: Remote Approval Answerer and Cancellation

**Files:**
- Create: `packages/harness-plugin/src/approvals/approval-broker.ts`
- Create: `packages/harness-plugin/src/approvals/register-answerer.ts`
- Create: `packages/harness-plugin/src/runtime/cancel-handler.ts`
- Test: `packages/harness-plugin/src/approvals/approval-broker.test.ts`
- Test: `packages/harness-plugin/src/runtime/cancel-handler.test.ts`

**Interfaces:**

```ts
export interface ApprovalBroker {
  request(input: {
    jobId: string;
    attempt: number;
    fingerprint: string;
    actionSummary: string;
    impactSummary: string;
    riskClass: string;
    signal?: AbortSignal;
  }): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
  acceptDecision(message: ApprovalDecisionMessage): "accepted" | "ignored";
}
```

- [ ] **Step 1: Write failing approval and cancellation race tests**

Cover matching approval, rejection, expiry, wrong job revision, wrong fingerprint, duplicate decision, disconnect, abort while waiting, local `denied`, cancel while running, cancel while waiting approval, and terminal completion racing cancel.

Run: `pnpm vitest run packages/harness-plugin/src/approvals packages/harness-plugin/src/runtime/cancel-handler.test.ts`
Expected: FAIL because broker and handler are missing.

- [ ] **Step 2: Register an owner-scoped official Harness answerer**

Register `ctx.on("approval/request", async (req, next) => ...)`. Delegate with `next()` unless `req.agent.id` belongs to this plugin. Look up the canonical action by `callId`, emit `approval.requested`, and wait at most the repository timeout. Return `allowed-once` only for a matching unexpired cloud approval. Map rejection to `rejected`, caller abort to `cancelled`, and transport loss/timeout to `unavailable`.

- [ ] **Step 3: Validate every approval decision again locally**

Require exact approval ID, product job ID, attempt, job revision, action fingerprint, and future expiry. Delete the waiter after the first decision. A cloud `approve` cannot change a stored local `denied` classification.

- [ ] **Step 4: Implement cancellation using official Agent semantics**

For a live owned Agent call `agent.cancel({ kind: "user" })`; do not arm a future cancellation when idle. Withdraw a pending approval with its `AbortController`. After quiescence, emit `job.cancelled` only if no committed terminal outcome already exists.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run packages/harness-plugin/src/approvals packages/harness-plugin/src/runtime/cancel-handler.test.ts`
Expected: PASS with only one terminal event in every race.

```bash
git add packages/harness-plugin/src/approvals packages/harness-plugin/src/runtime/cancel-handler.ts packages/harness-plugin/src/runtime/cancel-handler.test.ts
git commit -m "feat(connector): bridge approvals and cancellation fail closed"
```

## Task 6: Plugin Composition, Redaction, and End-to-End Recovery

**Files:**
- Create: `packages/harness-plugin/src/redaction/redact-event.ts`
- Create: `packages/harness-plugin/src/runtime/job-command-coordinator.ts`
- Create: `packages/harness-plugin/src/index.ts`
- Create: `tests/contract/harness-plugin-shape.test.ts`
- Create: `tests/integration/harness-connector-e2e.test.ts`
- Create: `tests/security/connector-redaction.test.ts`

**Plugin entry point:**

```ts
import type { Context } from "@deepseek-ai/cordis";

export const name = "qwen-harness-bridge";
export const inject = ["agents", "sessions", "sessionPersistence", "approval"];

export function apply(ctx: Context): void {
  // Validate configuration, register effect-scoped listeners, then start the
  // outbound Connector in a Cordis-owned lifecycle. Teardown aborts transport,
  // disposes owned AgentHandles, flushes the outbox, and closes SQLite.
}
```

- [ ] **Step 1: Write failing plugin-shape, redaction, and end-to-end tests**

The contract test imports `name`, `inject`, and `apply`. Security fixtures include bearer tokens, API keys, environment assignments, user home paths, sensitive URL query strings, tool arguments, and source snippets. E2E drives Control Plane → `job.offer` → Harness fake context → progress → approval → completion, kills the socket mid-run, restarts the plugin, and proves one execution plus ordered replay.

Run: `pnpm vitest run tests/contract/harness-plugin-shape.test.ts tests/security/connector-redaction.test.ts tests/integration/harness-connector-e2e.test.ts`
Expected: FAIL because composition is incomplete.

- [ ] **Step 2: Implement command coordination**

Validate job attempt and expiry, persist `job.offer`, resolve the repository alias locally, CAS the local mapping, emit `job.claim`, create/resume the Agent, and forward normalized events. Handle `job.cancel` and `approval.decision` through their dedicated components. Unknown messages produce `protocol.error` without execution.

- [ ] **Step 3: Implement redaction and bounds**

Replace secrets and home prefixes with fixed tokens, convert absolute repository paths to relative paths, strip URL query and fragment, cap event summary at 500 UTF-8 bytes, cap changed-file list at 50 entries, and reject rather than truncate malformed structured fields.

- [ ] **Step 4: Compose `apply(ctx)` with effect-scoped teardown**

Initialize once, register listeners before connecting, start transport under one abort controller, and dispose in this order: stop intake, abort pending approvals, cancel/await owned Agents, flush persisted outbox, close WebSocket, close SQLite. Teardown failures are contained and reported locally without uploading secrets.

- [ ] **Step 5: Run the complete plugin gate**

Run: `pnpm check && pnpm vitest run packages/harness-plugin tests/contract/harness-plugin-shape.test.ts tests/security/local-policy.test.ts tests/security/connector-redaction.test.ts tests/integration/harness-connector-e2e.test.ts`
Expected: PASS with no external network and no duplicate Agent creation.

- [ ] **Step 6: Commit the integrated plugin**

```bash
git add packages/harness-plugin tests/contract/harness-plugin-shape.test.ts tests/security tests/integration/harness-connector-e2e.test.ts
git commit -m "feat(harness): complete durable qwen connector plugin"
```

## Task 7: macOS Installation, Upgrade, and v0.2.0 Acceptance

**Files:**
- Create: `packages/harness-plugin/cordis.example.yml`
- Create: `packages/harness-plugin/scripts/package.mjs`
- Create: `docs/runbooks/install-harness-plugin.md`
- Create: `docs/runbooks/rotate-connector-credential.md`
- Create: `docs/runbooks/rollback-harness-plugin.md`
- Create: `docs/product/v0.2.0-acceptance.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the packaging smoke test**

Add a test that builds a tarball, installs it into a temporary Harness extension root, loads `cordis.example.yml`, imports the package entry, and verifies no credential value is copied into the artifact.

Run: `pnpm --filter @qhb/harness-plugin pack:test`
Expected: FAIL until the packaging script and sample wiring exist.

- [ ] **Step 2: Implement reproducible packaging and documented wiring**

The artifact contains compiled code, source maps, license, schema version, and sample Cordis configuration. The sample config references Keychain service/account names and local DB path but contains no token or absolute user-specific repository path.

- [ ] **Step 3: Exercise install, credential rotation, and rollback on a test Mac account**

Record commands to add the bootstrap credential to Keychain, configure one repository alias, load the extension, verify outbound connection, rotate the credential without losing jobs, stop Harness, install the previous plugin tarball, and reconnect with the same SQLite mapping.

- [ ] **Step 4: Execute the v0.2.0 release gate**

Run: `pnpm check && pnpm test`
Expected: all unit, contract, integration, and security suites pass.

Manual expected result: submit from the MCP fixture, online Mac claims within five seconds, a safe repository task completes, approval pauses/resumes exactly once, reconnect does not duplicate work, and final cloud output contains no raw secrets or full logs.

- [ ] **Step 5: Record evidence and commit**

`docs/product/v0.2.0-acceptance.md` records commit SHA, Harness version, macOS version, configuration digest, test commands, timestamps, reconnect evidence, approval evidence, and pass/fail for Spec acceptance items 2, 3, 5, 6, 7, and 10.

```bash
git add packages/harness-plugin/cordis.example.yml packages/harness-plugin/scripts docs/runbooks docs/product CHANGELOG.md
git commit -m "chore(release): prepare v0.2.0 harness connector"
```

## Plan Completion Evidence

This plan is complete only when:

- The packaged Cordis extension exports `apply(ctx)` and loads in the supported DeepSeek Harness version.
- A real owned Agent receives a task through `followup`, emits normalized progress, and restores from its persisted session.
- SQLite and WebSocket replay produce one product execution for duplicate delivery and restart cases.
- Local canonical-path and action-policy security suites pass.
- Approval is fail-closed, fingerprint-bound, one-time, and unable to override `denied`.
- Full logs and credentials remain on the Mac; redaction fixtures cannot escape.
- `docs/product/v0.2.0-acceptance.md` ties all evidence to one tested commit SHA.
