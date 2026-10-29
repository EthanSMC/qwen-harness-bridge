# Qwen AI Glasses S1 device acceptance checklist (v0.3.0)

This checklist is the physical-device matrix for the v0.3.0 Qwen Skill release.
It defines the cases before any device run and records only observed results.
Nothing in this file is a device pass yet: every row is
**NOT EXECUTED — BLOCKED-ENVIRONMENT** until the accountable owner supplies the
device and platform environment named in
`tests/e2e/qwen-device-results.json`.

Status legend: **PASS** = observed on the named device and build with the
recorded repetition count; **FAIL** = observed failure, with retest note;
**NOT EXECUTED — BLOCKED-ENVIRONMENT** = the required device, platform or
endpoint is unavailable; **PENDING OWNER** = blocked on an owner-supplied
credential, account or environment.

Related documents: `tests/e2e/qwen-device-results.json`,
`docs/product/v0.3.0-acceptance.md`, the Task 5 checklist
`tests/e2e/qwen-sandbox-checklist.md`, and the publish/rollback runbooks.

## Environment record (fill before the first run)

| Field | Value |
|---|---|
| Device model | PENDING OWNER (Qwen AI Glasses S1) |
| Device firmware | PENDING OWNER |
| Glasses app / Skill runtime version | PENDING OWNER |
| Skill package digest | PENDING OWNER (read from `manifest.json` of the release build) |
| Private platform version ID | PENDING OWNER |
| Control Plane commit | PENDING OWNER |
| Connector commit | PENDING OWNER |
| Network profile (quiet room / noisy room / interrupted) | PENDING OWNER |
| Tester account (owner only) | PENDING OWNER |
| Run timestamps | PENDING OWNER |

## Matrix rules

- Every case runs three repetitions on the recorded device and build.
- A `submit_task` receipt must appear within three seconds of utterance
  completion in every valid repetition.
- Every mutation must be exact: one `submit_task`, one `cancel_task` or one
  `decide_approval` per confirmed user intent; approval decisions use the
  `expected_job_revision` from the list read immediately before the decision.
- Ordered identifiers only address the immediately preceding list; they never
  cross lists.
- Prohibited content applies to both the screen and the speech: credentials,
  absolute local paths, prompts, source snippets, raw logs, approval
  fingerprints, raw UUIDs, percentages and fabricated progress.

## Device matrix

| ID | Utterance example | Expected MCP calls | Expected UI | Expected TTS | Prohibited content | Repetitions | Result |
|---|---|---|---|---|---|---|---|
| D-01 | 安静环境：让 DeepSeek 在 Novelty Web 跑测试 | `submit_task` once | `UiTool.all_text` receipt with short id and connector state | 任务 QH-XXXX 已创建，等待 Mac 接单。 | prompt body, UUID, path, secret, percentage | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-02 | 嘈杂环境：重复同一句创建请求 | `submit_task` once; no duplicate submission on speech retry | `UiTool.all_text` receipt | same receipt template | duplicate task, retried payload change, raw transcript | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-03 | 在线 Mac：让 DeepSeek 在 Novelty Web 跑测试 | `submit_task` once | receipt with 连接正常 freshness | receipt template with connector state | invented dispatch time, percentage | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-04 | 离线 Mac：让 DeepSeek 在 Novelty Web 跑测试 | `submit_task` once and keep the same request id while queued | receipt with queued state and 连接中断 freshness | 连接中断，正在协调 | invented delivery, duplicate submit | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-05 | 我有哪些任务 | `list_tasks` limit 5 | `UiTool.list` with five rows: short id, title, status, stage, freshness, unread, relative time | 任务列表已显示，共五个。 | raw job UUID, request body, event payload, percentage | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-06 | 看一下第一个 | `get_task` for the first row of the immediately preceding list | `UiTool.all_text` detail | 任务 QH-XXXX <status> | cross-list inference, raw UUID | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-07 | 看一下第五个 | `get_task` for the fifth row of the immediately preceding list | `UiTool.all_text` detail | 任务 QH-XXXX <status> | out-of-range guess, cross-list inference | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-08 | 看一下 QH-7M2P | `get_task` | `UiTool.all_text` with status, stage, freshness, at most five event summaries, pending approval, terminal summary | 任务 QH-7M2P 正在执行，阶段：运行测试。 | invented progress, percentage, ETA, raw log | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-09 | 看一下 QH-7M2P with stale or offline connectivity | `get_task` | detail shows 连接不稳定 or 连接中断，正在协调 | 连接不稳定 / 连接中断，正在协调 | claimed live connection, invented update time | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-10 | 批准第二个 | `list_pending_approvals` immediately before the decision, then `decide_approval` once with the revision from that list | `UiTool.list` with at most five approval rows: short id, action, impact, risk, expiry | one confirmation sentence with action and impact, then 已批准 QH-XXXX。 | approval fingerprint, raw revision, UUID, decision without confirmation | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-11 | 拒绝第一个 | `list_pending_approvals`, then `decide_approval` once with decision reject | `UiTool.list` approval rows | confirmation with action and impact, then rejection receipt | fingerprint, silent decision, raw revision | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-12 | 批准第二个 after the approval expired | `list_pending_approvals`; no mutation | `UiTool.list` refreshed rows plus explanation | refresh guidance, no decision | expired decision attempted, silent retry | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-13 | 取消 QH-9F3C | `get_task` to resolve the exact job and current revision, then `cancel_task` once | `UiTool.all_text` with the returned status | 任务 QH-9F3C 正在取消。 / 已取消 | repeated cancel, invented terminal state | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-14 | 读出 QH-9F3C 的结果 | `get_task_result` | `UiTool.all_text` summary, changed files (relative), test summary, artifact metadata | result summary within 120 characters | source body, raw log, absolute path, credential | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-15 | 读出 QH-9F3C 的图片 with an invalid image | `get_task_result` | `UiTool.pic_and_text` only for one HTTPS image of a supported type with a future expiry; otherwise `UiTool.all_text` fallback | 图片不可用，已显示文本信息。 | unavailable link in body, local path, multiple images | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-16 | 提交过程中网络中断 | `submit_task` once; at most one byte-identical retry for timeout or temporary unavailability | receipt explains the unknown or retried state | honest failure or retry state | duplicate task, changed payload, fabricated success | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| D-17 | 任务运行中退出 Skill 后重新进入 | read-only `list_tasks` and `get_task` on re-entry | list/detail with persisted state | persisted status only | offline push claim, restoration from stale cache | 3 | NOT EXECUTED — BLOCKED-ENVIRONMENT |

## Privacy and unsupported-capability verification (Step 3)

| ID | Check | Expected | Result |
|---|---|---|---|
| P-01 | Displayed and spoken output | No credential, absolute path, prompt, source snippet, raw log, fingerprint or private session link | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| P-02 | Exit Skill during a running job | The product does not claim an offline push or background notification | NOT EXECUTED — BLOCKED-ENVIRONMENT |
| P-03 | Reopen and query after exit | The persisted job state is shown correctly and matches the Control Plane | NOT EXECUTED — BLOCKED-ENVIRONMENT |

## Release gate (Step 4)

Command: `pnpm check && pnpm test && pnpm --filter @qhb/qwen-skill check:package`

Status: **NOT EXECUTED — BLOCKED-ENVIRONMENT** for the release gate as a whole,
because the manual device result and the platform evidence are prerequisites.
The repository gates are executed on the closing pull request and their observed
results must be recorded in `docs/product/v0.3.0-acceptance.md`.

## Per-run evidence to record

For every repetition record: run timestamp, device firmware, package digest,
private version ID, Control Plane and Connector commits, utterance audio class
(quiet/noisy), wall-clock submit latency, tool latency, selected route, UI tool
used, spoken text, Control Plane correlation id, pass/fail, and any failure with
its retest note. Do not record credentials, absolute local paths, raw logs or
prompts.

## Sign-off

| Field | Value |
|---|---|
| Tester | PENDING OWNER |
| Device verified | PENDING OWNER |
| All matrix rows PASS | PENDING OWNER |
| Privacy checks PASS | PENDING OWNER |
| v0.3.0 acceptance decision | **PENDING — NOT RELEASED** |
