---
"@qhb/harness-plugin": patch
---

Add opt-in negotiated transport epochs, synchronous tracked sync allocation, and immutable request-bound state receipt recovery. Preserve legacy durable transport behavior; state delivery and receipt ACKs do not grant execution authority.

Atomically retain proven state completion across expiry and restored receipt identities, preventing repeated state callbacks after a replacement commit and restart.
