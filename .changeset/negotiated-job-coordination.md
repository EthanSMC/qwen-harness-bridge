---
"@qhb/protocol": patch
"@qhb/control-plane": patch
---

Add opt-in server job coordination envelopes and immutable state snapshots with separate durable receipt ACKs. Validate historical offer proof, classify authorized no-effect conflicts, and guard PostgreSQL job business limits. Legacy peers retain their existing wire behavior. Fresh client transport authority and complete plugin integration remain required before the coordinated feature ships.
