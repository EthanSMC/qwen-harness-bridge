# Experimental Qwen RTC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly experimental, session-scoped live voice mode that consumes Qwen RTC audio, routes final utterances to the stable Job Coordinator, and streams bounded spoken/highlighted progress without changing stable-mode availability, releasing as `v0.5.0` with experimental support status.

**Architecture:** RTC is an optional Control Plane module mounted only when `QHB_RTC_ENABLED=true`. A thin Qwen wire adapter validates the official start/close callbacks and SSE protocol. An Aliyun RTC consumer delivers audio to a DashScope streaming ASR adapter. Final ASR utterances call the same application services used by MCP. A single serialized SSE writer emits `SPEAK`, `STOP_OUTPUT`, and `APPEND_HIGHLIGHT`, with keepalive, inactivity shutdown, and rate limiting. RTC state is ephemeral and never becomes product job truth.

**Tech Stack:** TypeScript strict mode, Fastify, Zod, official Qwen RTC wire contract, Aliyun RTC server SDK supported by the Qwen public-beta flow, DashScope streaming ASR, Server-Sent Events, Vitest fake timers, provider fakes, and the existing `@qhb/protocol` and Control Plane services.

**Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

## Global Constraints

- RTC is public-beta/experimental and disabled by default. Stable MCP health, readiness, deployment, and acceptance do not depend on RTC credentials or providers.
- The Skill explicitly enters live mode; there is no background connection or offline notification.
- Session output is best-effort and nonreplayable. Product tasks/events remain queryable through stable MCP after any RTC failure.
- Accept only official signed start/close requests, short-lived RTC credentials, HTTPS callbacks, and a single owner identity.
- Never store raw audio. ASR partial text is in memory only. Final utterances are retained only through the normal encrypted task request path when they create a task.
- Only ASR final results trigger commands. Partial hypotheses may update a local UI hint but never mutate job state.
- SSE writes are serialized. `STOP_OUTPUT` cancels queued speech/highlight output, not the underlying Harness job.
- Emit at most one ordinary progress speech update per 10 seconds per session. Approvals and terminal events may bypass that rate limit.
- Send SSE keepalive every 30 seconds and close after 90 seconds without inbound audio, control, or valid output activity.
- No reconnect/replay is claimed. Re-entry starts a new RTC session and uses stable job queries for continuity.
- Every task ends with a focused commit and keeps all stable-mode tests green with RTC both enabled and disabled.

---

## Planned File Map

```text
apps/control-plane/src/rtc/config.ts                  isolated feature configuration
apps/control-plane/src/rtc/wire/                     Qwen callbacks and SSE codec
apps/control-plane/src/rtc/session/                  session registry and lifecycle
apps/control-plane/src/rtc/providers/                RTC and ASR interfaces/adapters
apps/control-plane/src/rtc/router/                   final-utterance intent routing
apps/control-plane/src/rtc/output/                   serialized writer and speech policy
apps/control-plane/src/rtc/plugin.ts                 optional Fastify module
tests/contract/fixtures/qwen-rtc/                    official wire examples
tests/contract/qwen-rtc-wire.test.ts                 callback/SSE contract
tests/integration/rtc-conversation.test.ts           fake-provider live loop
tests/chaos/rtc-failure-isolation.test.ts            failure and stable-mode isolation
tests/e2e/rtc-device-checklist.md                     physical-device cycle matrix
docs/adr/0004-rtc-experimental-boundary.md            nondependency decision
docs/runbooks/rtc-provider-incident.md                disable/fallback procedure
docs/product/v0.5.0-experimental-acceptance.md        release evidence
```

## Task 1: Experimental Boundary and Official Wire Contract Fixtures

**Files:**
- Create: `apps/control-plane/src/rtc/config.ts`
- Create: `apps/control-plane/src/rtc/wire/qwen-rtc-schema.ts`
- Create: `apps/control-plane/src/rtc/wire/sse-codec.ts`
- Create: `tests/contract/fixtures/qwen-rtc/start-request.json`
- Create: `tests/contract/fixtures/qwen-rtc/close-request.json`
- Create: `tests/contract/fixtures/qwen-rtc/speak-event.txt`
- Create: `tests/contract/fixtures/qwen-rtc/stop-output-event.txt`
- Create: `tests/contract/fixtures/qwen-rtc/highlight-event.txt`
- Create: `tests/contract/qwen-rtc-wire.test.ts`
- Create: `docs/adr/0004-rtc-experimental-boundary.md`

**Internal normalized contract:**

```ts
export type NormalizedRtcStart = {
  platformSessionId: string;
  ownerSubject: string;
  media: "audio" | "video";
  roomId: string;
  rtcUserId: string;
  rtcToken: string;
  rtcTokenExpiresAt: string;
  callbackIssuedAt: string;
};

export type RtcOutputCommand =
  | { type: "SPEAK"; text: string; appendHighlight?: string }
  | { type: "STOP_OUTPUT" }
  | { type: "APPEND_HIGHLIGHT"; text: string };
```

- [ ] **Step 1: Archive the exact current official examples as immutable fixtures**

From Qwen documentation pages `6820210` and `6817146`, copy the complete start callback, close callback, `SPEAK`, `STOP_OUTPUT`, and `APPEND_HIGHLIGHT` examples into the named fixture files without secrets. Add `source.json` beside them containing page URL, retrieval date, and SHA-256 of each fixture. Do not reinterpret field names in the fixtures.

- [ ] **Step 2: Write the failing wire-contract test**

Parse official JSON fixtures into `NormalizedRtcStart`; reject unknown owner, wrong signature, expired token, unsupported media, missing session ID, non-HTTPS callback metadata, and timestamp skew over five minutes. Encode internal output commands and compare byte-for-byte with the official SSE fixture framing.

Run: `pnpm vitest run tests/contract/qwen-rtc-wire.test.ts`
Expected: FAIL because schemas and codec are absent.

- [ ] **Step 3: Implement isolated RTC configuration**

`RtcConfigSchema` requires provider credentials only when enabled. With `QHB_RTC_ENABLED=false`, loading the app ignores absent RTC/ASR configuration, mounts no RTC routes, creates no provider client, and exports metric `qhb_rtc_enabled 0`.

- [ ] **Step 4: Implement explicit wire-to-domain translation**

Keep every platform field inside `wire/`; the rest of the application receives only normalized types. Preserve unknown additive fields in fixture parsing only when the official contract allows them; reject unknown command/event types.

- [ ] **Step 5: Document the architecture boundary and verify**

ADR 0004 states that stable MCP is authoritative, RTC has no replay, RTC routes are feature-gated, provider failures cannot change readiness, and `v1.0.0` does not require RTC.

Run: `pnpm vitest run tests/contract/qwen-rtc-wire.test.ts && QHB_RTC_ENABLED=false pnpm vitest run tests/contract/health-metrics.test.ts`
Expected: PASS and no RTC route/provider initialization when disabled.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/rtc/config.ts apps/control-plane/src/rtc/wire tests/contract/fixtures/qwen-rtc tests/contract/qwen-rtc-wire.test.ts docs/adr/0004-rtc-experimental-boundary.md
git commit -m "feat(rtc): define isolated qwen wire contract"
```

## Task 2: Authenticated Session Start, Registry, Keepalive, and Close

**Files:**
- Create: `apps/control-plane/src/rtc/session/rtc-session.ts`
- Create: `apps/control-plane/src/rtc/session/session-registry.ts`
- Create: `apps/control-plane/src/rtc/session/inactivity-watchdog.ts`
- Create: `apps/control-plane/src/rtc/wire/routes.ts`
- Test: `apps/control-plane/src/rtc/session/session-registry.test.ts`
- Test: `tests/security/rtc-authentication.test.ts`

**Interfaces:**

```ts
export interface LiveRtcSession {
  readonly id: string;
  readonly ownerId: string;
  readonly startedAt: Date;
  touch(kind: "audio" | "control" | "output"): void;
  close(reason: RtcCloseReason): Promise<void>;
}

export type RtcCloseReason =
  | "platform_close"
  | "user_exit"
  | "inactive"
  | "token_expired"
  | "provider_error"
  | "server_shutdown";
```

- [ ] **Step 1: Write failing lifecycle and authentication tests**

Cover valid start, duplicate start idempotency, same session with modified room/user, invalid signature, unknown owner, token expiry, platform close, client disconnect, 30-second keepalive, 89/90-second inactivity boundary, and server shutdown. Assert close executes once and disposes provider streams/writer.

Run: `pnpm vitest run apps/control-plane/src/rtc/session/session-registry.test.ts tests/security/rtc-authentication.test.ts`
Expected: FAIL because registry/routes are absent.

- [ ] **Step 2: Implement signed callback verification before body use**

Verify the official Qwen signature over the exact raw request bytes, timestamp, and nonce before parsing business fields. Persist a short-lived nonce digest to reject replay. Authorize the single owner subject and redact RTC tokens from all errors/logs.

- [ ] **Step 3: Implement an in-memory bounded session registry**

Allow one active session per owner and at most two total sessions for restart overlap. A duplicate identical start returns the existing stream; a conflicting duplicate returns `RTC_SESSION_CONFLICT`. Session state does not survive process restart by design.

- [ ] **Step 4: Implement timers and deterministic close**

Inject `Clock`. Write SSE comment keepalive at 30-second intervals. Reset inactivity only on valid audio, control, or successful output activity. At 90 seconds close providers, stop output, finish SSE, unregister, and emit a bounded disconnect reason metric.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/control-plane/src/rtc/session/session-registry.test.ts tests/security/rtc-authentication.test.ts`
Expected: PASS with fake timers and exactly-once teardown.

```bash
git add apps/control-plane/src/rtc/session apps/control-plane/src/rtc/wire/routes.ts tests/security/rtc-authentication.test.ts
git commit -m "feat(rtc): add authenticated session lifecycle"
```

## Task 3: Aliyun RTC Consumer and DashScope Streaming ASR

**Files:**
- Create: `apps/control-plane/src/rtc/providers/types.ts`
- Create: `apps/control-plane/src/rtc/providers/aliyun-rtc-consumer.ts`
- Create: `apps/control-plane/src/rtc/providers/dashscope-asr.ts`
- Create: `apps/control-plane/src/rtc/providers/audio-normalizer.ts`
- Test: `apps/control-plane/src/rtc/providers/audio-normalizer.test.ts`
- Test: `apps/control-plane/src/rtc/providers/provider-adapters.test.ts`

**Interfaces:**

```ts
export interface RtcConsumer {
  join(input: NormalizedRtcStart, signal: AbortSignal): Promise<AsyncIterable<AudioFrame>>;
  leave(): Promise<void>;
}

export interface StreamingAsr {
  recognize(frames: AsyncIterable<AudioFrame>, signal: AbortSignal): AsyncIterable<{
    kind: "partial" | "final";
    text: string;
    startedAtMs: number;
    endedAtMs: number;
  }>;
}

export type AudioFrame = {
  pcm16le: Uint8Array;
  sampleRateHz: 16000;
  channels: 1;
  sequence: number;
};
```

- [ ] **Step 1: Write failing audio/provider contract tests**

Feed supported RTC frame formats, jitter, duplicates, missing sequence, silence, oversized frames, provider token expiry, ASR reconnect failure, and abort. Require normalized 16 kHz mono PCM, bounded 200 ms frames, monotonic output sequence, no raw audio persistence, and final-hypothesis deduplication.

Run: `pnpm vitest run apps/control-plane/src/rtc/providers`
Expected: FAIL because adapters are absent.

- [ ] **Step 2: Implement audio normalization with bounded buffering**

Decode only formats documented by the selected RTC SDK, resample to 16 kHz mono PCM16LE, cap buffer at two seconds, drop duplicate frames, and close with `RTC_AUDIO_GAP` when a gap exceeds the SDK recovery window. Never serialize frame bytes into logs or events.

- [ ] **Step 3: Implement the RTC provider adapter behind `RtcConsumer`**

Join with the session's short-lived token, subscribe only to the owner audio track, reject unexpected publishers, surface first-frame and disconnect telemetry, and make `leave()` idempotent.

- [ ] **Step 4: Implement DashScope streaming ASR behind `StreamingAsr`**

Create one ASR stream per RTC session, send normalized frames with backpressure, emit partial/final hypotheses, reject empty finals, collapse repeated final IDs, and abort immediately on session close. Provider credentials come from server secret configuration and are never returned to Qwen.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/control-plane/src/rtc/providers`
Expected: PASS with provider fakes; tests assert zero filesystem/database audio writes.

```bash
git add apps/control-plane/src/rtc/providers
git commit -m "feat(rtc): consume audio and stream dashscope asr"
```

## Task 4: Final-Utterance Router to Stable Job Services

**Files:**
- Create: `apps/control-plane/src/rtc/router/types.ts`
- Create: `apps/control-plane/src/rtc/router/utterance-router.ts`
- Create: `apps/control-plane/src/rtc/router/session-context.ts`
- Create: `tests/integration/rtc-conversation.test.ts`
- Test: `apps/control-plane/src/rtc/router/utterance-router.test.ts`

**Interfaces:**

```ts
export type LiveIntent =
  | { kind: "submit"; repositoryId: string; request: string; mode: "normal" | "read_only" }
  | { kind: "list" }
  | { kind: "inspect"; jobId: string }
  | { kind: "cancel"; jobId: string; expectedRevision: number }
  | { kind: "approve" | "reject"; approvalId: string; expectedJobRevision: number }
  | { kind: "result"; jobId: string }
  | { kind: "exit" }
  | { kind: "clarify"; prompt: string };
```

- [ ] **Step 1: Write failing multi-turn routing tests**

Cover submit, list then ordinal detail, pending approval then “批准第一个”, cancel by short ID, result, unclear pronoun, repository ambiguity, duplicate ASR final, partial-only input, and “退出实时模式”. Assert only final hypotheses mutate state and every application call uses the stable coordinator/approval services rather than a parallel RTC database path.

Run: `pnpm vitest run apps/control-plane/src/rtc/router/utterance-router.test.ts tests/integration/rtc-conversation.test.ts`
Expected: FAIL because the router is absent.

- [ ] **Step 2: Implement bounded session context**

Keep only the last task list (five IDs), last approval list (five IDs/revisions), current focused task, and last final-ASR digest. Expire ordinal context after two minutes or after any conflicting list. Do not retain free-form conversation history beyond the active session.

- [ ] **Step 3: Route through the existing application interfaces**

Call the same `JobCoordinator`, task query, result acknowledgement, and `ApprovalService` used by MCP. Derive one UUID `client_request_id` from platform session ID plus final-ASR event ID so duplicate final delivery returns the same job receipt.

- [ ] **Step 4: Implement deterministic spoken summaries**

Reuse the Skill's status/error localization package. Return one response object containing speech text, optional highlight, and focused IDs. Keep speech under 120 Chinese characters and ask one clarification instead of guessing.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/control-plane/src/rtc/router/utterance-router.test.ts tests/integration/rtc-conversation.test.ts`
Expected: PASS; database assertions show only stable job/approval records.

```bash
git add apps/control-plane/src/rtc/router tests/integration/rtc-conversation.test.ts
git commit -m "feat(rtc): route live utterances through stable services"
```

## Task 5: Serialized SSE Output, Interruption, Highlight, and Rate Limit

**Files:**
- Create: `apps/control-plane/src/rtc/output/serialized-sse-writer.ts`
- Create: `apps/control-plane/src/rtc/output/speech-fragmenter.ts`
- Create: `apps/control-plane/src/rtc/output/progress-scheduler.ts`
- Create: `apps/control-plane/src/rtc/output/job-event-subscription.ts`
- Test: `apps/control-plane/src/rtc/output/serialized-sse-writer.test.ts`
- Test: `apps/control-plane/src/rtc/output/progress-scheduler.test.ts`

**Interfaces:**

```ts
export interface RtcOutput {
  speak(text: string, options?: { highlight?: string; priority?: "normal" | "urgent" }): Promise<void>;
  stopOutput(): Promise<void>;
  keepalive(): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing serialization/timing tests**

Queue concurrent progress, approval, terminal, keepalive, and stop operations. Assert SSE frames never interleave, `STOP_OUTPUT` cancels queued speech, fragments preserve UTF-8 characters and punctuation, ordinary progress is no faster than 10 seconds, approval/terminal preempt queued progress, and writes after close are rejected without throwing into stable services.

Run: `pnpm vitest run apps/control-plane/src/rtc/output`
Expected: FAIL because writer/scheduler are absent.

- [ ] **Step 2: Implement one writer queue per session**

All SSE bytes pass through a promise chain guarded by session abort. Flush complete frames only. Keepalive uses official comment/event framing and cannot overtake command output. A socket error closes only the RTC session.

- [ ] **Step 3: Implement safe `SPEAK` fragmentation**

Split at Chinese/English sentence punctuation within the platform's documented fragment limit, then at Unicode grapheme boundaries. Pair `APPEND_HIGHLIGHT` with the same bounded factual summary. Never split or speak task IDs character by character.

- [ ] **Step 4: Implement progress scheduling**

Subscribe to redacted product job events only for jobs touched in this RTC session. Coalesce ordinary events to the newest stage every 10 seconds. Approval and terminal events clear stale progress and emit immediately. On session close, unsubscribe without affecting the job.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/control-plane/src/rtc/output`
Expected: PASS under 100 randomized concurrent schedules with fake timers.

```bash
git add apps/control-plane/src/rtc/output
git commit -m "feat(rtc): serialize interruptible live progress output"
```

## Task 6: Optional Module Composition and Failure Isolation

**Files:**
- Create: `apps/control-plane/src/rtc/plugin.ts`
- Modify: `apps/control-plane/src/http/app.ts`
- Create: `apps/control-plane/src/rtc/observability.ts`
- Create: `tests/chaos/rtc-failure-isolation.test.ts`
- Create: `docs/runbooks/rtc-provider-incident.md`

- [ ] **Step 1: Write the failing isolation suite**

Inject missing credentials, provider startup rejection, mid-audio disconnect, ASR failure, SSE disconnect, token expiry, session-registry saturation, and RTC module exception. In every case, stable `/health/ready`, all seven MCP tools, Connector job progress, approval, and result queries remain healthy.

Run: `pnpm vitest run tests/chaos/rtc-failure-isolation.test.ts`
Expected: FAIL until plugin isolation is complete.

- [ ] **Step 2: Mount the optional Fastify module**

Register RTC routes and provider factories only when enabled. Use a child plugin scope, child abort controller, separate concurrency limit, and separate circuit breaker. RTC degradation is exposed in `/health/components` and metrics but excluded from core readiness.

- [ ] **Step 3: Add bounded RTC telemetry**

Record active session count, start outcome, time to first audio frame, time to first ASR final, time to first output, output command type, and disconnect reason. Do not log audio, transcripts, RTC token, room/user IDs, or SSE text.

- [ ] **Step 4: Document incident fallback**

Runbook steps: disable `QHB_RTC_ENABLED`, drain sessions for up to 90 seconds, force-close remaining RTC resources, verify stable MCP readiness and a create/query smoke test, then investigate provider-specific telemetry. No Control Plane rollback is required to disable RTC.

- [ ] **Step 5: Verify and commit**

Run: `QHB_RTC_ENABLED=false pnpm test && QHB_RTC_ENABLED=true pnpm vitest run tests/contract/qwen-rtc-wire.test.ts tests/integration/rtc-conversation.test.ts tests/chaos/rtc-failure-isolation.test.ts`
Expected: both commands PASS.

```bash
git add apps/control-plane/src/rtc/plugin.ts apps/control-plane/src/rtc/observability.ts apps/control-plane/src/http/app.ts tests/chaos/rtc-failure-isolation.test.ts docs/runbooks/rtc-provider-incident.md
git commit -m "feat(rtc): isolate live mode behind a feature flag"
```

## Task 7: Ten-Cycle Physical-Device Acceptance and Experimental Release

**Files:**
- Create: `tests/e2e/rtc-device-checklist.md`
- Create: `tests/e2e/rtc-cycle-results.json`
- Create: `docs/product/v0.5.0-experimental-acceptance.md`
- Modify: `packages/qwen-skill/skill.json`
- Modify: `packages/qwen-skill/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Enable the Skill route only in the experimental package variant**

Set `rtc_mode: true` for the experimental package and add exact entry “进入 DeepSeek 实时模式” plus exit “退出实时模式”. If start fails, say “实时模式暂不可用，你仍可用任务台查询和操作任务” and route back to stable instructions.

- [ ] **Step 2: Define one physical cycle**

Each cycle performs enter, receive confirmation, submit one harmless test-repository task, ask at least two follow-up status/detail questions, exercise `STOP_OUTPUT` once, exit, verify stable query, then re-enter with a new session. Include one approval cycle, one cancellation cycle, one RTC disconnect, and one ASR-noise case across the ten runs.

- [ ] **Step 3: Execute ten consecutive enter/multi-turn/exit/re-enter cycles**

Record device firmware, Skill digest, session IDs as hashes, provider region, start/first-frame/final-ASR/first-output timings, commands observed, disconnect reason, and stable job IDs. Required: ten completed cycles, no leaked session, no duplicate job from repeated ASR final, and no stable-mode regression.

- [ ] **Step 4: Run final automated release gates**

Run: `QHB_RTC_ENABLED=false pnpm test`
Expected: all stable tests PASS.

Run: `QHB_RTC_ENABLED=true pnpm vitest run tests/contract/qwen-rtc-wire.test.ts tests/integration/rtc-conversation.test.ts tests/chaos/rtc-failure-isolation.test.ts`
Expected: all RTC suites PASS.

- [ ] **Step 5: Record experimental limitations and commit**

Acceptance explicitly states: session-scoped only, no offline push, no replay/reconnect, provider public-beta dependency, best-effort speech, stable query fallback, and not part of `v1.0.0` support SLO.

```bash
git add tests/e2e/rtc-device-checklist.md tests/e2e/rtc-cycle-results.json docs/product/v0.5.0-experimental-acceptance.md packages/qwen-skill CHANGELOG.md
git commit -m "chore(release): qualify v0.5.0 experimental rtc"
```

## Plan Completion Evidence

This plan is complete only when:

- Official Qwen callback and SSE fixtures pass byte-level contract tests.
- Signed start/close, keepalive, 90-second inactivity close, and exactly-once teardown pass deterministic tests.
- RTC audio reaches DashScope ASR without raw-audio persistence; only final hypotheses can mutate state.
- Live commands reuse stable coordinator and approval services with idempotency.
- SSE output is serialized, interruptible, highlighted, and rate-limited.
- Every injected RTC failure leaves stable MCP/Connector readiness and behavior green.
- Ten physical enter/multi-turn/exit/re-enter cycles pass and are tied to one experimental artifact digest.
