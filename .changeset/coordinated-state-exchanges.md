---
"@qhb/harness-plugin": patch
---

Add bounded live job-state observations with exact persisted request and socket-epoch binding, immutable snapshots, and an original two-second waiter budget. Limit pending observations to 32 total and one per job, and withdraw them on abort, epoch loss, disposal, or failure. Observations and receipt ACKs do not authorize Agent or tool execution.
