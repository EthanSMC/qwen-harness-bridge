# RTC provider incident runbook

Use this when the experimental RTC live mode is failing, looping, or degraded
while the stable task console must stay available. RTC is optional and isolated:
disabling it never requires a Control Plane rollback.

## Symptoms

- `/health/components` shows `components.rtc.status` other than `ok`.
- Provider telemetry shows disconnect, ASR failure or circuit-open counts.
- Live sessions cannot start or stop but MCP, Connector jobs, approvals and
  results still work.

## Immediate action: disable RTC

1. Set `QHB_RTC_ENABLED=false` on the Control Plane deployment and restart it.
   With the flag disabled no RTC configuration is validated and no RTC route or
   provider factory is mounted, so startup cannot fail for a missing RTC secret.
2. During the restart the Control Plane calls the implemented RTC plugin drain
   path: it waits up to 90 seconds for active sessions to finish, then
   force-closes every remaining RTC resource. Force-close is a real code path
   (`drainAndClose()` -> `forceClose()` -> registry `closeAll`), not only a
   documented claim; it is covered by the chaos suite.
3. Do not wait for sessions to end before disabling: RTC degradation must never
   block core readiness.

## Verify stable recovery

- `GET /health/ready` returns `{"status":"ready"}` (HTTP 200).
- `GET /health/components` returns `components.core.status = "ok"` and
  `components.rtc.status = "disabled"` (or `closed` during shutdown).
- `GET /health/live` and `GET /healthz` stay 200.
- MCP smoke: list the seven tools (`submit_task`, `list_tasks`, `get_task`,
  `cancel_task`, `list_pending_approvals`, `decide_approval`,
  `get_task_result`) and run a read-only query such as `list_tasks` and
  `list_pending_approvals`; both must succeed.
- Connector smoke: submit one harmless task and read its result through the same
  MCP tools; confirm job progress, approvals and results still work.

## Investigate

- Read bounded RTC telemetry from `/health/components`:
  active session count, start outcomes, first audio/ASR-final/output buckets,
  output command types, disconnect reasons and ASR failure count. Values are
  allowlisted labels and duration buckets only.
- Read `qhb_rtc_enabled` and `qhb_rtc_disconnects_total` from `/metrics`.
- Never collect audio, transcripts, RTC tokens, room ids, user ids or SSE text;
  the RTC layer never records them.
- Provider credentials belong to server secret configuration and are never
  returned to Qwen.

## Recovery

1. Fix the provider or configuration issue outside the Control Plane.
2. Re-enable `QHB_RTC_ENABLED=true` with valid RTC configuration and restart.
3. Confirm `/health/components` returns `components.rtc.status = "ok"` before
   re-running live acceptance.
4. No database migration or Control Plane rollback is required to disable or
   re-enable RTC.
