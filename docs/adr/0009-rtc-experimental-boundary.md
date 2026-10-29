# ADR 0009: Experimental RTC Boundary

Status: Accepted (experimental). Supersedes no earlier record. The plan for this
task names the file `0004-rtc-experimental-boundary.md`, but ADR 0004 is already
taken by `0004-connector-event-projection.md`, so this record uses the next free
number. The content requirements are unchanged.

## Context

The product plans an optional glasses voice/video experience on top of the Qwen
hardware platform's audio/video realtime protocol (official pages
`https://device.qianwen.com/docs/qwen/6820210` for the session stream and event
API registration and `https://device.qianwen.com/docs/qwen/6817146` for the
interaction protocol). Stable product work already flows through MCP and must
stay independent of this experiment.

The official protocol defines a JSON request envelope (`specVersion`,
`requestId`, `sessionId`, `type`, `occurredAt`, `payload`), a
`SESSION_START`/`SESSION_CLOSE` request pair, and an SSE response stream whose
only event is `output` carrying `SPEAK` and `STOP_OUTPUT` actions. It
explicitly does not support SSE resumption, `Last-Event-ID`, or message replay,
and it leaves request authentication to the platform API plugin rather than
defining a signature scheme.

## Decision

1. **Stable MCP is authoritative.** Task truth, acceptance, approval, and
   result reads stay on the MCP path. RTC state is ephemeral conversation state
   and never becomes product job truth; losing an RTC session loses no job.
2. **RTC is feature-gated.** `QHB_RTC_ENABLED` defaults to false. With it
   false, configuration ignores absent RTC/ASR credentials, no provider client is
   created, no RTC route is mounted, and the exported metric is
   `qhb_rtc_enabled 0`. Provider credentials are required only when it is true.
3. **RTC has no replay.** The adapter never persists or replays SSE frames; a
   reconnect is a new session. Idempotency belongs to MCP submissions, not to the
   RTC stream.
4. **Provider failures cannot change readiness.** RTC provider, ASR, and
   websocket failures are isolated in the RTC module; liveness and readiness
   remain functions of the stable path.
5. **`v1.0.0` does not require RTC.** Release qualification, tags, and
   acceptance evidence for `v1.0.0` do not depend on the RTC experiment.
6. **Platform fields stay inside `wire/`.** Only normalized types
   (`NormalizedRtcStart`, `RtcOutputCommand`) cross into the application; the
   rest of the codebase never reads Qwen field names.
7. **Adapter security envelope.** Because the official pages define no request
   signature, this repository defines its own verification for the callback
   endpoint: `X-QHB-Signature` is HMAC-SHA256 over
   `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)` with constant-time
   comparison, `X-QHB-Owner-Subject` must equal the configured single owner,
   the timestamp must be within five minutes of server time, callback metadata
   must be HTTPS, the RTC token must not be expired, and the media must be in the
   configured allowlist. This is a local adapter requirement, not a signature
   scheme provided by Qwen, and it must not be described as one.

## Consequences

- The wire contract is testable without any provider: the official examples are
  archived verbatim under `tests/contract/fixtures/qwen-rtc/` with a
  `source.json` recording retrieval date and per-file SHA-256.
- Enabling RTC adds a route and a provider client; disabling it removes both and
  leaves the metric at zero.
- Unknown commands, events, and actions fail closed instead of degrading.
- A future official signature specification can replace the adapter envelope
  without changing normalized types.

## Verification

- `tests/contract/qwen-rtc-wire.test.ts` parses the official fixtures, rejects
  every documented failure mode, and re-encodes the official SSE frames
  byte-for-byte.
- `QHB_RTC_ENABLED=false` keeps `qhb_rtc_enabled` at 0 and mounts no RTC
  module.
