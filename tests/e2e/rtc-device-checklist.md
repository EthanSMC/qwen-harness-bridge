# Qwen 眼镜 RTC 十轮真机验收清单（v0.5.0 实验范围）

Status: **NOT EXECUTED — BLOCKED-ENVIRONMENT**

This checklist defines the physical-device acceptance for the experimental RTC scope
(Plan Task 7, Issue #34). It was prepared offline. No Qwen 眼镜 device, no private
Qwen Skill platform account, and no staging Control Plane endpoint were available in
the implementation environment, so **zero of the ten cycles were executed**. The
per-cycle machine-readable record is `tests/e2e/rtc-cycle-results.json`; it contains
ten `NOT EXECUTED` rows with blocker codes. Do not treat this file as acceptance
evidence for any cycle, provider call, or release.

## 0. Preconditions (owner-provided, all currently missing)

| Requirement | Blocker code if missing |
|---|---|
| Qwen 眼镜 physical device plus its exact firmware version | `NO_PHYSICAL_DEVICE` |
| Private Qwen Skill platform account with private-publish permission | `NO_PLATFORM_ACCOUNT` |
| Staging Control Plane endpoint with `QHB_RTC_ENABLED=true` and provider credentials | `NO_STAGING_CONTROL_PLANE` |
| Aliyun RTC app/room provisioning and DashScope ASR key for the staging region | `NO_STAGING_CONTROL_PLANE` |
| Named acceptance window, operator, and signer | `NO_ACCEPTANCE_WINDOW` |

## 1. Experimental package variant (design dependency, not released)

The stable Skill package keeps `rtc_mode: false`; `packages/qwen-skill/src/transcript-schema.ts`
and `packages/qwen-skill/scripts/lint-skill.mjs` fail closed on `rtc_mode: true` or any
RTC route string. Task 7 Step 1 requires an **experimental package variant** that flips
`rtc_mode: true` and adds the RTC route. That variant is a packaging/release decision and
is **not implemented here**: changing the stable manifest would break the schema and lint
guards and would change the stable package's default behavior. The exact copy the variant
must ship is frozen below so the variant build is mechanical once the owner authorizes it:

| Purpose | Exact copy |
|---|---|
| Entry | 进入 DeepSeek 实时模式 |
| Exit | 退出实时模式 |
| Start failure fallback | 实时模式暂不可用，你仍可用任务台查询和操作任务 |
| Stop output (one per cycle) | 停止播报 |

The fallback must route the user back to the stable task-console instructions and must not
imply that a session was created. `STOP_OUTPUT` cancels queued speech only; it never
cancels the underlying Harness job.

## 2. One physical cycle (Plan Task 7 Step 2)

Run every step in order, on the experimental variant, against the staging Control Plane.
Record the evidence named in section 3 for every cycle.

1. **Enter**: say 进入 DeepSeek 实时模式. Expect a spoken confirmation and a new session;
   the Control Plane `/health/components` RTC component must be `ok` and
   `active_sessions` must be `1`.
2. **Submit one harmless test-repository task** through voice (configured test repository
   only), for example 让 DeepSeek 在 alpha 仓库跑一下测试. Expect one short ID and no
   duplicate on any repeated ASR final.
3. **Ask at least two follow-up questions**: one status question (比如 它现在怎么样) and
   one detail/result question (比如 看一下 QH-XXXX). Expect stable MCP task data, no
   second job, and speech under the Skill limit.
4. **Exercise STOP_OUTPUT once** while output is playing: say 停止播报. Expect queued
   speech/highlight to stop, the session to stay active, and the job to keep running.
5. **Exit**: say 退出实时模式. Expect the SSE stream to end, `active_sessions` to return
   to `0`, and no leaked session in `/health/components`.
6. **Verify stable query**: in stable mode ask 我有哪些任务 and read the submitted short
   ID/result. Expect the same job and no stable-mode regression.
7. **Re-enter with a new session**: say 进入 DeepSeek 实时模式 again and confirm a new
   session ID hash, one active session, and no duplicate job from the previous cycle.

A cycle is **PASS** only when steps 1–7 complete. Any step that needs a retry is recorded
with the retry count; a repeated ASR final that creates a second job is a **FAIL**.

## 3. Recording fields (Plan Task 7 Step 3)

One row per cycle in `tests/e2e/rtc-cycle-results.json`:

| Field | Rule |
|---|---|
| `device_firmware` | Exact device model and firmware string as shown on the device |
| `skill_digest` | SHA-256 of the experimental Skill artifact installed on the device |
| `session_id_hash` | `sha256(platformSessionId)` truncated to 16 hex characters; never the raw ID |
| `provider_region` | Aliyun RTC / DashScope region used for the staging account |
| `timings_ms.start_ack` | Enter command to spoken confirmation |
| `timings_ms.first_audio_frame` | From `first_audio_bucket_ms` telemetry or provider log |
| `timings_ms.first_asr_final` | From `first_asr_final_bucket_ms` telemetry |
| `timings_ms.first_output` | From `first_output_bucket_ms` telemetry |
| `commands_observed` | SSE command kinds actually observed (`speak`, `stop_output`, `progress`, …) |
| `disconnect_reason` | One bounded close reason (`user_exit`, `provider_disconnect`, …) |
| `stable_job_ids` | Stable `job_id`/`short_id` pairs touched in the cycle |
| `coverage` | Which special cases (approval/cancel/disconnect/ASR-noise) this cycle covers |

Never record RTC tokens, room IDs, user IDs, audio, transcripts, SSE bodies, or absolute
local paths. Session IDs are hashed; transcripts stay on the device.

## 4. Ten-cycle coverage matrix

| Cycle | Required special case |
|---|---|
| 1 | Baseline enter/multi-turn/exit/re-enter |
| 2 | Baseline |
| 3 | One **approval** round trip (审批 → 批准第一个) |
| 4 | Baseline |
| 5 | Baseline |
| 6 | One **cancellation** (取消 QH-XXXX) |
| 7 | Baseline |
| 8 | One **RTC disconnect** (network drop or provider close) and stable fallback |
| 9 | One **ASR-noise** case (background speech/noise must not duplicate a job) |
| 10 | Baseline plus final exit hygiene check |

All ten cycles must complete with no leaked session, no duplicate job from repeated ASR
final, and no stable-mode regression.

## 5. Failure handling and abort conditions

- Missing device/account/staging endpoint: do not start; keep the cycle `NOT EXECUTED`.
- Start failure: say the exact fallback copy and confirm stable query still works; record
  the bounded provider reason from `/health/components`.
- RTC disconnect mid-cycle: record the bounded close reason, confirm the job id is stable,
  and verify stable query works before the next cycle.
- Any credential, token, audio, or transcript appearing in an evidence file aborts the
  acceptance run.

## 6. Sign-off

| Field | Value |
|---|---|
| Artifact version / digest | _owner to provide_ |
| Acceptance window (UTC) | _owner to provide_ |
| Device operator | _owner to provide_ |
| Independent signer | _owner to provide_ |
| Result | **NOT EXECUTED — BLOCKED-ENVIRONMENT** |
| Release decision | **v0.5.0 NOT RELEASED** |
