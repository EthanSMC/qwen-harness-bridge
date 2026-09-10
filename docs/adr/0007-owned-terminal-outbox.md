# ADR 0007: One durable owned terminal and outbox boundary

Status: Accepted internal integration refinement for Issue #13 under ADR 0005 and ADR 0006. Implementation, independent review and activation gates remain required.

## Context

The initial-attempt journal establishes identity and drive phases, not a terminal winner. Separate mapping updates and event publication can lose a result, publish twice, or advance transport memory before an outer SQLite transaction rolls back. Cancellation must drain native result processing before competing for the same durable boundary. A receipt ACK proves consumption, including a possible no-effect rejection, rather than acceptance of a local outcome by the server.

## Durable representation

Add a local terminal journal phase, available only through dedicated terminal operations. Preserve every immutable identity, original offer, initial-message proof, mode and unavailable field from the nonterminal predecessor. Terminal closure changes the phase and increments the safe-integer CAS version once. Generic journal advancement cannot set, change or revive terminal closure.

Store one strict versioned terminal record for the exact job and attempt in the existing SQLite metadata table. Its key is `owned-terminal-v1:<job-id>:<attempt>`. The record retains the complete nonterminal predecessor and committed version. A local variant binds the logical operation, canonical sanitized business payload, correlation, actual terminal status and original outbound message ID, sequence and sent time. A remote variant binds a fresh authoritative remote terminal observation and has no outgoing identity or invented native event. The mapping stores the actual terminal status.

The joined reader verifies owner, active-job/generation indexes, predecessor-to-terminal CAS, mapping status and record variant together. A terminal intent without its matching record, a dangling record, an unrelated version change or malformed metadata is corruption, never absence or permission to repair. Local records also require the exact retained outbound request and original `job-coordination-v1` receipt profile. Delivery renewal may change only the permitted outer expiry; business identity and original sent time remain fixed. Historical reads require no current socket and do not change delivery counters.

The physical SQLite schema and user version remain unchanged. Intent records retain their 16 KiB bound; terminal records have a separate 64 KiB bound for their predecessor and bounded projection. Strict validation remains in force for both. No legacy mapping is promoted, no missing winner is reconstructed from a status alone, and no active owner generation is reused.

## Stable identity and data minimization

The logical terminal identity contains the full canonical local owner tuple and one tagged identity: native event sequence, confirmed cancellation revision, or a fixed unavailable identity. A different outcome for the same native event is contradictory content, not a competing event. Unavailability retains its first persisted reason.

Derive the wire correlation deterministically from UTF-8 JSON of the ordered array `['qhb-owned-terminal-v1', jobId, attempt, repositoryId, sessionId, ownerGeneration, kind, identityValue]`. The identity value is the native sequence or cancellation revision, or null for unavailable. Use SHA-256, the first 16 bytes, UUID version-8 and standard variant bits, and canonical lower-case rendering. This domain-separated identifier supports stable retries; it is not an authorization credential. Raw local identities do not become wire fields.

The terminal client constructs wire identity/type/source fields itself. Native projections pass through the reviewed redactor before durable allocation; merely parsing a bounded string is not redaction. Cancellation uses a fixed reason and unavailability uses its fixed latched reason. Callers cannot replace the correlation, product identity or terminal event type through projection fields. Rejected projection data produces no allocation.

## Authority and transaction order

Use the one composed live state registry and the fixed opaque authority verifier. Local terminal operations bind exact owner, predecessor version, operation, current socket epoch, observed job state and immutable conservative deadlines. First-effect admission needs a fresh snapshot; a valid admitted cancellation drain may continue beyond snapshot expiry while its original job/command/epoch/owner lifetime remains valid. A failed check permanently revokes that operation. Cancellation matches confirmed `cancel_revision`, not a later progress revision. Actual native history, successful persistence flush, quiescence and drain remain driver obligations; neither the journal nor the token invents them.

The store owns an outermost immediate transaction and rejects nested entry. It checks authority before entry, after acquiring the writer lock and immediately before commit. A validated existing local winner returns without calling an envelope factory or allocating any candidate. Exact retries must match the original predecessor and canonical proposal. A valid different operation on the same predecessor returns that winner as a competing local result; storage, authority and identity errors are not competing results.

For a new winner, the only precommit callback is the transport's private pure envelope constructor. It computes a candidate using the existing sequence allocator but cannot enqueue, publish, mutate memory, schedule work, recurse or return an asynchronous result. The store validates the candidate and atomically writes the intent CAS, terminal mapping, terminal record, outbound row and original profile. Every required row count is checked. Failure or revocation rolls back all writes; no ignored insert or sequence probing hides a conflict.

All outbound allocators share one synchronous non-reentrant section, including generic publication, sync, hello, ACK and heartbeat. Transport adopts sequence and pending memory only after the outermost transaction returns committed, then schedules normal delivery. Existing or losing proposals do neither. If postcommit adoption becomes uncertain, fail-stop and recover from durable rows instead of allocating with stale memory or claiming rollback. Restart retains the existing sequence and replay contract.

Generic publication and generic store enqueue cannot emit a terminal for a journal-owned attempt. Only the dedicated operation may do so; no caller-controlled bypass or generic transaction callback is introduced. For owned generic `job.event`, allow only the exact nonterminal names `stage.changed`, `progress.updated`, `tool.started` and `tool.finished`, with no nested payload `status` member. Reject other names, aliases, case/whitespace variants and status overrides rather than approximate the server's sanitized terminal interpretation. Check this before client identity allocation and again against actual ownership at store insertion; a preflight is not a grant. Dedicated terminal payloads have the strict minimized projection shape and cannot carry an overriding status. Unowned legacy consumers retain their existing behavior.

## Remote terminal reconciliation

A fresh correlated observation of remote succeeded, failed, cancelled or expired state can stop local drive without creating an outbound winner. Its separate reconciliation authority requires snapshot, epoch, owner and clock validity, but cannot demand a future job deadline for an already expired job. Dedicated timing checks reuse the exact arithmetic without weakening local effect admission or synthesizing a future expiry. Reconciliation must stay snapshot-current through its short transaction.

When no terminal exists, atomically record the remote variant, phase/version and mapping, with no factory or outbox. An existing local winner stays immutable even if the server reports a different final outcome; return local evidence and remote observation separately. A remote record is never described as a local competing outbound winner. Cancellation treats remote reconciliation explicitly, not as a fabricated successful cancellation or an arbitrary boolean persistence result.

All native completed/error/session-lost producers and cancellation must use the same sink. The driver enlists result processing synchronously, waits for actual native quiescence and persistence, and drains result work before cancellation arbitration. Normal-work/approval revocation is separate from the admitted cancellation lifetime. One product attempt retains its one session and initial request through settlement; new waking work cannot revive it.

## Retention, rollback and verification

Retain compact intent, generation, terminal and linked receipt/outbox proof together, including ACKed rows. They are not seven-day full logs. Native full-log retention remains a separate requirement. Rollback preserves the database and must leave unsupported integrated execution unavailable; physical schema compatibility does not prove safe operation by an older plugin.

Required evidence includes real SQLite multi-row rollback/CAS/corruption/reopen tests, exact retry after expiry renewal and ACK, no legacy terminal bypass, both local race orders, remote closure with zero outbound allocation, and immutable predecessor/version linkage. Use actual transport, SQLite, live state/authority and loopback TLS for allocation ordering, reentrancy, sequence exhaustion, failure before send, uncertain postcommit recovery and replay. Wire the actual cancellation handler to this sink for result-before-cancel and failed-commit behavior; an injected boolean winner is not evidence of the transaction.

Real native factory/history/flush, policy tools, approval publication, full plugin teardown, end-to-end recovery, minimum supported runtime and release acceptance remain mandatory before activation. This ADR is not their PASS.

## Alternatives

Independent best-effort mapping and publication do not establish one winner. Wrapping generic publication in an outer transaction advances memory at a nested savepoint rather than durable commit. A second sequence allocator or a refreshed retry identity breaks replay. Treating unavailable persistence as a competing terminal hides failure. The selected boundary accepts explicit unavailability and preserves evidence instead of creating a second execution or event.
