# ADR 0001: Negotiated durable Connector receipts

Status: Accepted implementation correction for Issue #9; implementation and independent verification pending.

## Context

The original Connector implementation cannot recover an allocated client message that expires before first receipt, retires uncertain one-way frames on socket close, and can overrun the gateway's 128-message admission queue. These conflict with the approved durable reconnect outcome. Merely increasing the TTL or delaying socket writes does not establish durable progress.

## Decision

Retain envelope protocol version `1.0` and introduce the opt-in capability `durable-receipts-v1` in the existing client hello capabilities array. Add an optional capabilities array to the welcome payload. A capable server echoes this capability only when requested. Legacy hellos receive the existing welcome shape and retain their existing receipt semantics. The new Harness Connector requires an explicit echoed capability before dispatching commands or sending post-hello traffic; absence is a bounded compatibility failure, never an implicit fallback to unsafe replay.

For this negotiated capability only:

1. A locally generated client message has immutable message ID, sequence, type, correlation ID, payload, and original `sent_at`. Its envelope `expires_at` is a renewable delivery lease. Renew only this field, and commit the renewal in SQLite before sending. A fresh or renewed delivery must have expiry strictly after receiver time and no more than 60 seconds ahead, with an explicitly documented bounded clock allowance if needed. Duplicate identity excludes only the renewable expiry and still binds every immutable field, using precise timestamp normalization and the original payload digest. Exact duplicates already committed may recover their recorded disposition without repeating effects; an expired first delivery is rejected. No server-command execution deadline is renewable under this rule.
2. Business deadlines remain independent and immutable: job expiry, dispatch lease, approval payload expiry, revision, attempt, and action fingerprint never change during transport renewal. An authorized, structurally valid next-sequence message rejected by a business expiry must be durably consumed with a bounded correlated rejection outcome and receipt ACK, without any business effects. This permits later sequences to proceed. Authorization failures, malformed identity, sequence conflicts, database errors and unknown failures remain fail-closed; they must not be disguised as successfully consumed work. Partial business mutations must be rolled back before a rejection receipt commits.
3. The server persists an ACK for every consumed client frame, including client ACK frames. The hello's welcome is proof of consumption of the hello; other dispositions may include a rejection outcome plus their receipt ACK. The client persists server ACKs but never generates an ACK in response to a server ACK. Thus the receipt chain terminates. An ACK is receipt evidence, not execution success, approval, or permission.
4. A receipt must match a locally allocated client sequence and its stored correlation. Because server receipt commits are contiguous, such a match proves the committed client prefix through that sequence. Persist the proven prefix and retire only rows proven consumed. Do not infer receipt from socket send completion, close handshakes, elapsed time, or buffered bytes. Preserve separately the hello needed as the reconnect anchor. Select a new hello only at a connection boundary when all previously allocated client frames are proven consumed; atomically persist/select that anchor before retiring the prior one.
5. Bound sent-but-unconfirmed traffic to 32 frames and 128 KiB, including control frames. Release window credit only on application receipt evidence. Persisted allocation remains ordered across reconnect and restart; never discard or renumber allocated rows. Coalesce redundant ACK intents before allocation, and retain the 10-second heartbeat schedule. Missing receipt progress must trigger bounded reconnect rather than bypassing the window.
6. Accept only verified server response restorations from expiry tombstones. Restored ACKs must bind their payload sequence and correlation to a known local outbound frame; welcome restoration must satisfy the active hello identity and cursor contract. Arbitrary same-sequence rewrites remain denied.
7. Check incoming command expiry after durable receipt and immediately before each handler invocation. Record an expired disposition without invoking a handler once its deadline passes. Existing attempt-level idempotency and terminal-state rules remain authoritative.

## Compatibility and persistence

The optional welcome field is sent only to clients that explicitly request the capability, preserving unchanged legacy peer payloads. New Connector/old server pairs fail compatibility verification before command dispatch. An old pending hello without the capability cannot be silently rewritten to opt in; surface an explicit incompatible-state result, preserving its database for recovery. No prior released plugin includes this unpublished transport, so no deployed v0.1.0 transport state migration is claimed.

Use existing PostgreSQL JSON metadata and SQLite metadata/payload storage where possible. Any required schema change must have its own tested migration. Receipt profile and recorded disposition must be recoverable from durable data, not only a mutable in-memory connection flag. A later capability change cannot reinterpret an older receipt or weaken its identity check.

## Required evidence

Tests must exercise both endpoints together for delayed first delivery beyond 60 seconds, unreceived queued product/control frames, expired business operations followed by valid traffic, lost ACK followed by tombstone/restoration, abort after socket send but before receipt commit, and at least 130 accumulated ACKs against the real bounded gateway. Include malformed/modified renewals, omitted negotiation, legacy compatibility, business rollback, expiry crossing during receipt/handler delivery, durable restart, and the existing 100,000-row allocation case. Use real PostgreSQL for transaction/receipt guarantees and real loopback TLS/WebSocket for queue/admission behavior; socket doubles alone do not prove these interactions.

## Consequences

This is a negotiated semantic extension, not a claim that unchanged peers implement the new behavior. Both endpoints ship together in v0.2.0; rollback preserves durable state and makes unsupported peers unavailable rather than silently dropping or repeating work. The implementation expands Issue #9 only as needed to fulfill its approved durable transport and recovery outcome.
