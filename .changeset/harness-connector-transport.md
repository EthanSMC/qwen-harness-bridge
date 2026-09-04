---
"@qhb/harness-plugin": minor
"@qhb/control-plane": minor
"@qhb/protocol": minor
---

Add authenticated HTTPS/WSS Connector transport with heartbeat, token refresh,
bounded reconnect, and negotiated `durable-receipts-v1` recovery. Renew only client
delivery expiry while preserving immutable identity and business deadlines.
Persist receipt-proven prefixes and reconnect anchors, bound unconfirmed traffic
to 32 frames/128 KiB, restore verified ACKs, and suppress expired command handlers.

Capable control planes acknowledge every consumed client frame, including client
ACKs, and durably record expired business rejections after rolling back effects.
Legacy hellos retain legacy behavior; the new plugin requires an explicit welcome
echo and preserves incompatible state for recovery. Deploy both endpoints together;
rollback must retain receipt/outbox data and treat unsupported peers as unavailable.
