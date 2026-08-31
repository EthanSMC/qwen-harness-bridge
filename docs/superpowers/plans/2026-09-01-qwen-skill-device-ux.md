# Qwen Skill and Device UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a private Qwen Skill that lets the owner create, inspect, cancel, approve, reject, and retrieve DeepSeek Harness tasks with native glasses UI and concise Chinese speech, releasing the stable device experience as `v0.3.0`.

**Architecture:** The Skill is a declarative orchestration layer over the seven stable MCP tools from Plan 1. It never runs local code and never invents repository or task identifiers. Versioned reference files define intent routing, tool-call limits, native UI presentation, TTS, errors, and ambiguity handling. A transcript contract runner validates deterministic tool/UI sequences before Qwen sandbox and real-device testing.

**Tech Stack:** Qwen Skill platform, MCP import configuration, `SKILL.md`, `UiTool.list`, `UiTool.all_text`, `UiTool.pic_and_text`, Qwen TTS behavior, JSON fixtures, TypeScript/Zod transcript validators, Vitest, and official private-publish/real-device workflows.

**Spec:** `docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md`

## Global Constraints

- V1 uses a private Skill entry, not a standalone glasses app, desktop icon, native SDK, or enterprise custom-device capability.
- A Skill turn calls `submit_task` at most once. Retry reuses the same UUID `client_request_id` and identical payload.
- The Skill accepts only repository IDs returned by configuration; it never forwards paths or model-invented aliases.
- Task lists contain at most five rows. Detail body is at most 600 Chinese characters. Spoken text is at most 120 Chinese characters.
- Status is factual stage plus connector freshness; the Skill never invents percentages or completion times.
- Approval requires the current pending list or an exact short ID. Ambiguous ordinal, stale revision, or unclear yes/no gets one clarification and no mutation.
- Results never display raw logs, source contents, credentials, environment values, or absolute local paths.
- `UiTool.pic_and_text` is allowed only for one server-approved HTTPS artifact carrying expiry metadata.
- The stable Skill makes no promise of offline/background push after the user exits. The user reopens the Skill or uses the later experimental RTC session.
- Every task ends with a focused commit and leaves the transcript contract suite green.

---

## Planned File Map

```text
packages/qwen-skill/package.json                    validation scripts
packages/qwen-skill/SKILL.md                        production Skill instructions
packages/qwen-skill/skill.json                      package metadata and version
packages/qwen-skill/mcp.import.example.json         seven-tool MCP import template
packages/qwen-skill/references/intents.md           utterance-to-action routing
packages/qwen-skill/references/tool-contract.md     MCP call and retry rules
packages/qwen-skill/references/ui-contract.md       list/detail/approval/result UI
packages/qwen-skill/references/speech-contract.md   Chinese TTS templates
packages/qwen-skill/references/errors.md            domain error copy
packages/qwen-skill/fixtures/transcripts/           deterministic conversation cases
packages/qwen-skill/src/transcript-schema.ts        fixture runtime schemas
packages/qwen-skill/src/contract-runner.ts           sequence and bound checks
packages/qwen-skill/scripts/lint-skill.mjs           static Skill checks
tests/e2e/qwen-sandbox-checklist.md                  sandbox evidence template
tests/e2e/qwen-device-checklist.md                   real-device evidence template
docs/runbooks/publish-private-qwen-skill.md          publish and rollback
docs/product/v0.3.0-acceptance.md                    release evidence
```

## Task 1: Skill Package and Seven-Tool MCP Import

**Files:**
- Create: `packages/qwen-skill/package.json`
- Create: `packages/qwen-skill/skill.json`
- Create: `packages/qwen-skill/mcp.import.example.json`
- Create: `packages/qwen-skill/src/transcript-schema.ts`
- Create: `packages/qwen-skill/scripts/lint-skill.mjs`
- Test: `packages/qwen-skill/src/transcript-schema.test.ts`

**Package metadata contract:**

```json
{
  "name": "qwen-harness-bridge",
  "display_name": "眼镜任务台",
  "version": "0.3.0",
  "visibility": "private",
  "language": "zh-CN",
  "stable_mode": true,
  "rtc_mode": false
}
```

- [ ] **Step 1: Write a failing package/schema test**

Assert private visibility, synchronized SemVer, `zh-CN`, stable mode enabled, RTC disabled, exactly seven distinct MCP tool names, HTTPS endpoint, an environment-backed Bearer reference rather than a literal secret, and rejection of transcript fixtures with more than one `submit_task` in a turn.

Run: `pnpm vitest run packages/qwen-skill/src/transcript-schema.test.ts`
Expected: FAIL because the package does not exist.

- [ ] **Step 2: Add the package and transcript schemas**

Define fixture steps as `user`, `mcp_call`, `mcp_result`, `ui_call`, `tts`, and `assistant`. Validate UUID request IDs, known MCP tool names, known UI tool names, bounded visible text, and one mutation target per turn.

- [ ] **Step 3: Add a secret-free MCP import template**

The template declares one remote HTTPS MCP server, Bearer authentication through the Qwen platform's secret field, and only:

```text
submit_task
list_tasks
get_task
cancel_task
list_pending_approvals
decide_approval
get_task_result
```

Use the non-production example endpoint `https://control-plane.example.com/mcp` and secret reference `${QWEN_MCP_BEARER_TOKEN}`. The linter rejects literal token-like values and additional tools.

- [ ] **Step 4: Implement static package checks**

The linter validates front matter, required references, tool names, no absolute local paths, no credential literals, no unsupported push claim, and no RTC route while `rtc_mode` is false.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @qhb/qwen-skill lint && pnpm vitest run packages/qwen-skill/src/transcript-schema.test.ts`
Expected: PASS.

```bash
git add packages/qwen-skill
git commit -m "feat(skill): add private qwen package and mcp contract"
```

## Task 2: Intent Routing, Repository Resolution, and Idempotent Submission

**Files:**
- Create: `packages/qwen-skill/SKILL.md`
- Create: `packages/qwen-skill/references/intents.md`
- Create: `packages/qwen-skill/references/tool-contract.md`
- Create: `packages/qwen-skill/fixtures/transcripts/submit-online.json`
- Create: `packages/qwen-skill/fixtures/transcripts/submit-offline.json`
- Create: `packages/qwen-skill/fixtures/transcripts/submit-retry.json`
- Create: `packages/qwen-skill/fixtures/transcripts/repository-ambiguous.json`
- Test: `packages/qwen-skill/src/contract-runner.test.ts`

**Required Skill front matter:**

```yaml
---
name: qwen-harness-bridge
description: 当用户要通过眼镜给 DeepSeek Harness 布置、查看、取消、审批或读取软件开发任务时使用。
---
```

**Submission sequence:**

```text
utterance
  -> resolve exact configured repository ID
  -> generate one UUID client_request_id
  -> call submit_task once
  -> render receipt
  -> speak short ID and connector state
```

- [ ] **Step 1: Add failing transcript cases**

Cases cover “让 DeepSeek 在 Novelty 跑测试”, explicit read-only mode, Connector offline queue, MCP retry with the same UUID, ambiguous repository name, arbitrary absolute path, and a second task request in the same conversational turn. Expected mutation count is zero or one exactly.

Run: `pnpm vitest run packages/qwen-skill/src/contract-runner.test.ts`
Expected: FAIL because routing and runner are missing.

- [ ] **Step 2: Write single-intent routing instructions**

Define routes `create`, `list`, `inspect`, `cancel`, `list_approvals`, `decide_approval`, `result`, and feature-gated `rtc`. A sentence may contain parameters but only one mutating intent. If two mutations are requested, execute the first explicit one and ask whether to perform the second in a new turn.

- [ ] **Step 3: Write repository resolution rules**

Store the allowed alias table in Skill configuration, not prose examples. Exact configured display name or ID resolves. One fuzzy candidate triggers confirmation. Zero or multiple candidates produces a list and no `submit_task`. Strings containing `/`, `~`, `..`, or drive prefixes are never repository IDs.

- [ ] **Step 4: Write idempotent retry rules**

Generate the UUID before the first call and retain it for the turn. Retry only transport timeout or `TEMPORARY_UNAVAILABLE`, at most once, with byte-identical `repository_id`, `request`, and `mode`. Never retry `IDEMPOTENCY_CONFLICT` or validation/policy errors.

- [ ] **Step 5: Implement the contract runner**

The runner loads every transcript, counts calls per turn, confirms expected tool order and unchanged retry payload, and emits a diff that names the fixture and first invalid step.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @qhb/qwen-skill test:contracts`
Expected: PASS for all submission and repository fixtures.

```bash
git add packages/qwen-skill/SKILL.md packages/qwen-skill/references/intents.md packages/qwen-skill/references/tool-contract.md packages/qwen-skill/fixtures packages/qwen-skill/src/contract-runner.ts packages/qwen-skill/src/contract-runner.test.ts
git commit -m "feat(skill): route tasks with idempotent submission"
```

## Task 3: Native Task List, Detail, Result, and Speech Presentation

**Files:**
- Create: `packages/qwen-skill/references/ui-contract.md`
- Create: `packages/qwen-skill/references/speech-contract.md`
- Create: `packages/qwen-skill/fixtures/transcripts/list-tasks.json`
- Create: `packages/qwen-skill/fixtures/transcripts/inspect-running.json`
- Create: `packages/qwen-skill/fixtures/transcripts/inspect-offline.json`
- Create: `packages/qwen-skill/fixtures/transcripts/result-text.json`
- Create: `packages/qwen-skill/fixtures/transcripts/result-image.json`
- Test: `packages/qwen-skill/src/presentation-contract.test.ts`

**Visible mappings:**

| Domain value | Glasses text |
|---|---|
| `queued` | 等待 Mac 接单 |
| `dispatched` | Mac 已接单 |
| `running` | 正在执行 |
| `waiting_approval` | 等待你的批准 |
| `cancelling` | 正在取消 |
| `succeeded` | 已完成 |
| `failed` | 执行失败 |
| `cancelled` | 已取消 |
| `expired` | 已过期 |
| `fresh` | 连接正常 |
| `stale` | 连接不稳定 |
| `offline` | 连接中断，正在协调 |

- [ ] **Step 1: Write failing presentation contracts**

Assert `list_tasks(limit=5)` precedes `UiTool.list`, ordinals map only to the immediately preceding list, detail calls `get_task`, at most five redacted events appear, no percentages appear, body length is at most 600 Chinese characters, and TTS is at most 120. Image results require `https`, one image, and future expiry metadata.

Run: `pnpm vitest run packages/qwen-skill/src/presentation-contract.test.ts`
Expected: FAIL because UI references and fixtures are missing.

- [ ] **Step 2: Define `UiTool.list` task rows**

Each row contains short ID, bounded title, localized status, stage, freshness, unread marker, and relative last-update text. Sort by `updated_at` descending and preserve the MCP order. Never put raw `job_id`, request body, or event payload into the row.

- [ ] **Step 3: Define `UiTool.all_text` detail layout**

Render repository display name, short ID, status, stage, freshness, last update, up to five event summaries, pending approval headline, and terminal summary. Drop oldest events first when approaching 600 characters. Use “暂无进度详情” for empty events, not fabricated progress.

- [ ] **Step 4: Define result and artifact presentation**

Text uses `UiTool.all_text` and includes summary, relative changed-file names, test summary, and artifact metadata. One explicitly allowed time-limited image uses `UiTool.pic_and_text`. Multiple, local-path, expired, non-HTTPS, or unknown media falls back to text metadata.

- [ ] **Step 5: Define concise TTS templates**

Examples are deterministic templates, not free-form paraphrases: “任务 QH-7M2P 已创建，等待 Mac 接单”, “任务 QH-7M2P 正在执行，阶段：运行测试”, and “任务 QH-7M2P 已完成，结果已显示”. Speech omits file lists, raw errors, and approval fingerprints.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run packages/qwen-skill/src/presentation-contract.test.ts && pnpm --filter @qhb/qwen-skill lint`
Expected: PASS for normal, stale, offline, terminal, and artifact fixtures.

```bash
git add packages/qwen-skill/references/ui-contract.md packages/qwen-skill/references/speech-contract.md packages/qwen-skill/fixtures packages/qwen-skill/src/presentation-contract.test.ts
git commit -m "feat(skill): add bounded native task presentation"
```

## Task 4: Approval, Cancellation, and Error UX

**Files:**
- Create: `packages/qwen-skill/references/errors.md`
- Create: `packages/qwen-skill/fixtures/transcripts/approval-list.json`
- Create: `packages/qwen-skill/fixtures/transcripts/approval-confirm.json`
- Create: `packages/qwen-skill/fixtures/transcripts/approval-stale.json`
- Create: `packages/qwen-skill/fixtures/transcripts/approval-ambiguous.json`
- Create: `packages/qwen-skill/fixtures/transcripts/cancel-running.json`
- Create: `packages/qwen-skill/fixtures/transcripts/cancel-race.json`
- Create: `packages/qwen-skill/fixtures/transcripts/errors.json`
- Test: `packages/qwen-skill/src/mutation-safety.test.ts`

- [ ] **Step 1: Write failing mutation-safety fixtures**

Test exact approval ID, ordinal from current list, “批准它” without context, expired approval, stale revision, duplicate approval, rejection, cancel with stale revision, and terminal result racing cancellation. Assert no mutation call occurs for ambiguity or stale context.

Run: `pnpm vitest run packages/qwen-skill/src/mutation-safety.test.ts`
Expected: FAIL because the workflows are not defined.

- [ ] **Step 2: Define approval list and detail UI**

Call `list_pending_approvals` immediately before an ordinal decision. Render at most five items with job short ID, action, impact, risk, and expiry. Before calling `decide_approval`, speak one confirmation sentence containing action and impact; do not expose the fingerprint.

- [ ] **Step 3: Define optimistic concurrency behavior**

Use the `expected_job_revision` from the immediately preceding detail/list result. On `REVISION_CONFLICT`, `APPROVAL_EXPIRED`, `APPROVAL_ALREADY_DECIDED`, or `APPROVAL_SUPERSEDED`, refresh the task and explain the current state; never silently retry a mutation.

- [ ] **Step 4: Define cancellation behavior**

Resolve exact job, obtain current revision, call `cancel_task` once, and present the returned authoritative state. Queued cancellation may be terminal immediately; running cancellation remains “正在取消” until a later query reports terminal.

- [ ] **Step 5: Map stable errors to Chinese copy**

Include mappings for authentication, rate limit, invalid repository, connector offline, idempotency conflict, job not found, revision conflict, expired approval, unavailable approval channel, timeout, and internal error. Each message gives one safe next action and never leaks stack traces.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @qhb/qwen-skill test:contracts`
Expected: PASS with zero unsafe mutation sequences.

```bash
git add packages/qwen-skill/references/errors.md packages/qwen-skill/fixtures packages/qwen-skill/src/mutation-safety.test.ts
git commit -m "feat(skill): add safe approvals cancellation and errors"
```

## Task 5: Qwen Sandbox, Private Publish, and Rollback

**Files:**
- Create: `tests/e2e/qwen-sandbox-checklist.md`
- Create: `docs/runbooks/publish-private-qwen-skill.md`
- Create: `docs/runbooks/rollback-qwen-skill.md`
- Create: `packages/qwen-skill/scripts/build-package.mjs`
- Create: `packages/qwen-skill/scripts/check-package.mjs`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a failing package-build smoke test**

Build into a temporary directory and assert it contains `SKILL.md`, `skill.json`, all referenced Markdown files, and secret-free MCP import JSON. Assert the package excludes transcript test fixtures, source maps, local reports, `.env`, and Keychain material.

Run: `pnpm --filter @qhb/qwen-skill build && pnpm --filter @qhb/qwen-skill check:package`
Expected: FAIL until scripts are implemented.

- [ ] **Step 2: Implement reproducible packaging**

Sort archive entries, normalize timestamps, emit SHA-256, and include version plus source commit in a manifest. The build fails when `skill.json` version differs from the root Changeset version.

- [ ] **Step 3: Execute the official Qwen sandbox matrix**

Run all create/list/detail/cancel/approval/result/error utterances against the staging Control Plane and fake Connector. Record platform run ID, package digest, MCP latency, selected route, UI tool used, spoken text, and pass/fail in `tests/e2e/qwen-sandbox-checklist.md`.

- [ ] **Step 4: Publish privately and verify access scope**

Follow the official private-publish flow, bind only the owner account, import the production MCP endpoint and secret through platform secret configuration, and verify an unrelated account cannot discover or invoke the Skill.

- [ ] **Step 5: Rehearse rollback**

Retain the previous private package version, switch the active version back, confirm all seven tools still match protocol `1.0`, and verify queued/running jobs remain queryable after rollback.

- [ ] **Step 6: Commit publish automation and evidence template**

```bash
git add packages/qwen-skill/scripts tests/e2e/qwen-sandbox-checklist.md docs/runbooks CHANGELOG.md
git commit -m "chore(skill): add private publish and rollback workflow"
```

## Task 6: Real-Device Acceptance and v0.3.0 Release

**Files:**
- Create: `tests/e2e/qwen-device-checklist.md`
- Create: `tests/e2e/qwen-device-results.json`
- Create: `docs/product/v0.3.0-acceptance.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Define the physical-device matrix before testing**

Include quiet/noisy voice submission, online/offline Mac, five-row list, first/last ordinal, running detail, stale freshness, approval/rejection, expired approval, cancellation, text result, image fallback, network interruption, and Skill exit/re-entry. Each case names expected MCP calls, UI type, TTS, and prohibited content.

- [ ] **Step 2: Run three repetitions of every stable flow on Qwen AI Glasses S1**

Capture wall-clock submit latency from utterance completion to receipt display, tool server latency, UI legibility, speech correctness, identifier resolution, and Control Plane correlation ID. Required create receipt is under three seconds in all valid repetitions.

- [ ] **Step 3: Verify privacy and unsupported-capability wording**

Inspect displayed and spoken output for credentials, absolute paths, prompts, source snippets, and raw logs. Exit the Skill during a job and confirm the product does not claim an offline push; reopening and querying must show the correct persisted state.

- [ ] **Step 4: Run the complete v0.3.0 gate**

Run: `pnpm check && pnpm test && pnpm --filter @qhb/qwen-skill check:package`
Expected: PASS.

Manual expected result: Spec acceptance items 1, 4, 5, 6, and 8 pass on the physical device; every mutation is exact and every UI/TTS bound is respected.

- [ ] **Step 5: Record acceptance and commit**

`docs/product/v0.3.0-acceptance.md` records device model/firmware, Skill package digest, private version ID, Control Plane and Connector commits, test timestamps, three-run latency evidence, failures/retests, and final sign-off.

```bash
git add tests/e2e/qwen-device-checklist.md tests/e2e/qwen-device-results.json docs/product/v0.3.0-acceptance.md CHANGELOG.md
git commit -m "chore(release): prepare v0.3.0 glasses experience"
```

## Plan Completion Evidence

This plan is complete only when:

- The private Skill exposes every stable task-control journey through the seven MCP tools.
- Transcript contracts prove one-submit-per-turn, exact repository resolution, bounded native UI, safe approval, and stable error copy.
- Qwen sandbox evidence is tied to the packaged artifact digest.
- Physical glasses create a job in under three seconds and accurately show task, freshness, approval, cancellation, and result states.
- Skill exit/re-entry works through persisted queries without claiming unsupported offline push.
- `docs/product/v0.3.0-acceptance.md` ties device and automated evidence to one release candidate.
