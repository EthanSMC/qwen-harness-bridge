# Qwen Harness Bridge Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the linked plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved Qwen Harness Bridge design through five independently verifiable plans, keeping stable asynchronous delivery releasable without the experimental RTC path.

**Architecture:** One TypeScript monorepo delivers a cloud Control Plane, outbound Mac Connector embedded in a DeepSeek Harness plugin, and private Qwen Skill. PostgreSQL owns cross-device state; SQLite owns local receipt/outbox and Harness mappings. Stable MCP calls create and query asynchronous jobs. RTC is a feature-gated adapter over the same services and is never a dependency of stable readiness.

**Tech Stack:** Node.js 20+, pnpm, TypeScript, Zod, Fastify, official MCP TypeScript SDK, PostgreSQL/Drizzle, WebSocket, SQLite, DeepSeek Harness Cordis APIs, Qwen Skill/MCP/UI, optional Aliyun RTC and DashScope ASR, Vitest/Testcontainers/Toxiproxy, Docker/OCI, and GitHub Actions/Changesets.

**Approved Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

## Delivery Order

```text
Plan 1: Foundation / Protocol / Control Plane / Fake Connector (v0.1.0)
   |
   v
Plan 2: Real Harness Plugin and Mac Connector (v0.2.0)
   |
   v
Plan 3: Private Qwen Skill and Device UX (v0.3.0)
   |
   v
Plan 4 Tasks 1-6: Reliability, Security, Operations (v0.4.0)
   |
   +--> Plan 5: Experimental RTC (v0.5.0, independent feature flag)
   |
   +--> Plan 4 Task 7: stable private-beta qualification (v1.0.0)
```

Plan 5 depends on stable service interfaces from Plans 1–4 but does not sit on the stable acceptance critical path. In the nominal sequence, tag experimental RTC as `v0.5.0` before `v1.0.0`; the `v1.0.0` qualification suite still runs with RTC disabled. If RTC is deferred and the repository goes directly from `v0.4.0` to `v1.0.0`, do not later reuse `v0.5.0`; retarget Plan 5 to the next valid synchronized minor release.

## Plan Index and Exit Gates

| Order | Plan | Release | Authoritative exit gate |
|---:|---|---:|---|
| 1 | [Foundation and Control Plane](2026-09-01-foundation-control-plane.md) | `v0.1.0` | Seven MCP tools, PostgreSQL state machine, fake Connector claim/progress/approval/cancel/result, two-second server budget |
| 2 | [Harness Plugin and Connector](2026-09-01-harness-plugin-connector.md) | `v0.2.0` | Real `apply(ctx)` extension, outbound replay transport, canonical local policy, session restore, fail-closed approval |
| 3 | [Qwen Skill and Device UX](2026-09-01-qwen-skill-device-ux.md) | `v0.3.0` | Private Skill, transcript contracts, sandbox, three-run physical device flows, sub-three-second receipt |
| 4 | [Reliability, Security, and Operations](2026-09-01-reliability-operations.md) | `v0.4.0`, then `v1.0.0` | Chaos/replay, threat tests, restore drill, telemetry, protected CI, rollback rehearsal, seven-day dogfood |
| 5 | [Experimental Qwen RTC](2026-09-01-experimental-rtc.md) | `v0.5.0` experimental | Official wire contracts, provider isolation, serialized SSE, ten device session cycles, stable suite green with RTC off |

## Cross-Plan Contracts That Must Not Drift

- Protocol version is `1.0`; additive messages require capability negotiation and contract fixtures.
- Public job states are exactly `queued`, `dispatched`, `running`, `waiting_approval`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `expired`.
- Connector health is `fresh`, `stale`, or `offline` and is never encoded as a job state.
- The public tool surface is exactly seven tools: `submit_task`, `list_tasks`, `get_task`, `cancel_task`, `list_pending_approvals`, `decide_approval`, and `get_task_result`.
- The cloud product `job_id` crosses all components. Harness `SessionId`/native `JobId`, platform RTC session ID, and display short ID never replace it.
- Every mutation uses idempotency or optimistic revision. Terminal state and first valid approval decision are immutable.
- Local policy classes are exactly `automatic`, `approval_required`, and `denied`; approval can release only `approval_required`.
- Qwen calls target two seconds server time and three seconds end-to-end. Lists show at most five, detail at most 600 Chinese characters, and speech at most 120 Chinese characters.
- Heartbeat is 10 seconds, stale is 20 seconds, offline is 30 seconds, offer lease is 30 seconds, queue expiry is 24 hours, run timeout is 60 minutes, and default approval expiry is 5 minutes.
- Cloud keeps redacted records for 30 days, deletes encrypted original requests 24 hours after terminal, and local full logs expire after 7 days.
- Stable readiness and private-beta acceptance run with `QHB_RTC_ENABLED=false`.

## GitHub Milestones and Issue Slices

Create these milestones with the exact titles and releases:

1. `M0 — v0.1.0 Product and technical baseline`
2. `M1 — v0.2.0 Async Harness task loop`
3. `M2 — v0.3.0 Glasses UI and approvals`
4. `M3 — v0.4.0 Reliability and security`
5. `M4 — v0.5.0 Experimental RTC`
6. `M5 — v1.0.0 Stable private beta`

Create one implementation issue per numbered task in the linked plans. Each issue body contains:

- Goal and exact plan/task anchor.
- File list and interfaces copied from the plan.
- Every checkbox step from that task.
- Test commands and expected results.
- Release milestone, area label, priority, and risk label.
- Dependencies expressed with “Blocked by #…” only when the earlier task supplies a consumed interface.
- Definition of done requiring focused commit, green tests, and updated acceptance evidence when applicable.

Use labels:

```text
type:feature       type:test          type:docs          type:security
area:protocol      area:control-plane area:connector     area:harness
area:qwen-skill    area:rtc           area:operations    area:release
priority:p0        priority:p1        priority:p2
risk:low           risk:medium        risk:high
```

Mapping rules:

- Plans 1–3 default to `type:feature`; test-only acceptance tasks use `type:test` plus `area:release`.
- Plan 4 security and backup tasks carry `risk:high`; observability/release carry `risk:medium`.
- Plan 5 issues all carry `area:rtc`; provider, authentication, and failure-isolation tasks carry `risk:high`.
- The `v1.0.0` qualification issue belongs to M5 and is blocked by every M0–M3 release gate, never by M4.

## Pull Request and Version Discipline

- Branch from protected `main` using `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `security/<issue>-<slug>`, or `docs/<issue>-<slug>`.
- PR title follows Conventional Commits and links one primary issue.
- Protocol/schema/architecture changes link the approved Spec and an ADR.
- A PR cannot combine stable-path behavior and RTC behavior unless it changes a shared interface and proves stable tests with RTC disabled.
- Each user-visible package change adds one Changeset; all packages share one synchronized SemVer in V1.
- Merge only after format, lint, typecheck, unit, contract, integration, security, build, and documentation-link checks required for the touched area pass.
- Release tags are immutable `vX.Y.Z`. Artifact manifests record source commit and OCI/plugin/Skill digests.

## Release Decision Checklist

For each release:

- [ ] Every issue in its milestone is closed or explicitly moved with a documented noncritical reason.
- [ ] All plan completion evidence exists and names one commit SHA.
- [ ] Protocol compatibility and database migration range are recorded.
- [ ] Control Plane image, Harness plugin, and Skill artifact digests are reproducible.
- [ ] Previous compatible artifacts remain available and rollback checks pass.
- [ ] Known limitations and manual Qwen evidence are current.
- [ ] Security scan has no unaccepted high/critical production finding.
- [ ] Git tag, CHANGELOG, GitHub Release, package versions, and acceptance file agree.

Additional `v1.0.0` requirements:

- [ ] Plans 1–4 are complete; M4 RTC may remain open or disabled.
- [ ] Latest encrypted backup restore drill passes.
- [ ] Deploy and rollback rehearsal passes.
- [ ] Seven-day dogfood exit criteria pass.
- [ ] Stable end-to-end suite passes with RTC disabled.

## Execution Start

Start with Plan 1 Task 1. Do not scaffold later runtime packages ahead of their plan merely to make the repository look complete; create only the management files, Specs, and plans before implementation. After each task, update its GitHub issue and commit the smallest coherent green change. At each milestone, run the full release gate before starting behavior that depends on it.
