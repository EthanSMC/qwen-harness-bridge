# ADR 0003: Preserve the approved M1 dependency graph

Status: Accepted correction for Issue #64; implementation and verification pending.

## Context

The approved M1 execution has three independent tasks after local plugin state: transport, local policy and the Harness adapter. The existing management graph instead makes each task depend on its immediate predecessor. Synchronizing that graph can overwrite the full approval-task dependency declaration and conflict with already valid parallel claims. Correcting Issue text alone is not durable while the source graph remains different.

## Decision

Apply the following graph to the Harness Connector plan, identifying tasks by their existing stable plan markers and resolving actual GitHub Issue numbers at runtime:

| Task | Prerequisite tasks |
| --- | --- |
| 1: Plugin state | Existing Foundation plan completion prerequisite |
| 2: Transport | M1 Task 1 |
| 3: Local policy | M1 Task 1 |
| 4: Harness adapter | M1 Task 1 |
| 5: Approval and cancellation | M1 Tasks 2, 3, 4 |
| 6: Composition and recovery | M1 Tasks 2, 3, 4, 5 |
| 7: Installation and acceptance | M1 Task 6 |

Preserve every other plan edge and the existing stable/experimental separation. This is a bounded repository-specific correction, not a new scheduling service or generalized dependency language. Do not infer Issue IDs from their numbering/order, silently rewrite active dependency declarations, alter claim generations, or relax the existing mismatch rejection. Keep contributor notes and checklist state intact. No broad GitHub synchronization is part of the implementation or required verification.

## Evidence and consequences

Tests must fail against the old linear graph, prove every M1 edge with nonconsecutive/shuffled Issue identities, prove unchanged other-plan edges, and demonstrate that matching active claims remain unchanged while true active mismatches still fail closed. Task 5 readiness must remain false while Task 2 or Task 3 is open even if Task 4 is complete. Keep task marker uniqueness validation. Review the full final range and require governance/runtime CI; after merge compare graph output with live M1 declarations read-only.

This correction does not authorize dependent implementation before prerequisites merge or skip a version release gate. A mistake could start work early or block valid parallel work. Rollback is a reviewed revert with claims and receipts retained, and broad synchronization held until graph/declarations agree.
