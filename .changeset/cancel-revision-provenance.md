---
"@qhb/control-plane": patch
---

Persist internal cancellation provenance atomically with running cancellation commands and reject exhausted cancellation revisions safely. Add a nullable checked column without backfilling legacy rows; rollback retains the column and its data.
