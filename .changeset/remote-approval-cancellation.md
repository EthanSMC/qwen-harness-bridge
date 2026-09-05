---
"@qhb/harness-plugin": patch
---

Add internal remote approval and cancellation components with one-time decision validation, bounded approval waits, official Harness answerer registration, and cancellation through a shared terminal arbitration port. Plugin composition still needs to supply authoritative revision reservations, canonical action ownership, transport-loss invalidation, and shared Agent terminal wiring.

Limit admission to 32 concurrent approval lifetimes and one per job attempt, retaining slots through delivery and cleanup. Retry transient cancellation terminal failures on the same owner without repeating the Agent cancellation effect.

Revalidate approval authority after synchronous reservation cleanup so cleanup-time revocation cannot deliver an executable grant.
