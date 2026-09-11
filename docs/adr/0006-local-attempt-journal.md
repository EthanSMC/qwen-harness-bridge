# ADR 0006: Durable local attempt identity and initial-input journal

Status: Accepted implementation refinement for Issue #13 under ADR 0005. No runtime, integration, or release completion is implied.

## Decision

Before creating a native Agent, store one immutable offer-bound intent containing the product job, attempt, repository alias and lease, the original offer identity, a preallocated SessionId, the exact native initial MessageId, a SHA-256 digest of the original request, and a fresh local owner-generation UUID. The request itself remains in the existing local receipt/session storage, not in new journal metadata or public evidence. Native MessageIds are opaque bounded strings, not assumed UUIDs.

Persist this versioned journal and its active-job/generation indexes in the existing SQLite metadata table, in the same outermost immediate transaction as the corresponding mapping. The existing strict schema and user_version remain unchanged; no legacy mapping is promoted into an owned intent. Unknown or corrupt records fail closed. Legacy mapJob cannot change a journal-owned mapping. Historical receipt replacement does not replace immutable intent identity.

The local phases are prepared, creating, submitting and started. They are not public job statuses. A safe-integer CAS version advances on each transition; the owner-generation UUID remains immutable and is never reused. One job has one locally active owned attempt; this first journal stage does not enable takeover or replacement. The later terminal integration must prove the previous owner's terminal closure before enabling another attempt, if needed.

- prepared records identity only, before native factory invocation. It grants no execution authority.
- creating is committed before entering a native factory. Only this exact persisted session may be resumed; ambiguous or missing session history cannot justify a new session.
- submitting is committed before the sole initial followup invocation. Recovery must never invoke followup again merely because the journal has not reached started.
- started records the exact own-session initial user/message event, matching MessageId and request digest, after a successful native session persistence flush. A caller-supplied proof record is not itself a native flush: the adapter must inspect actual own-session history and require the real flush result before calling the journal transition.

A separate monotonic unavailable reason preserves the phase and identity, advances the CAS version and permanently prevents further drive transitions for that intent. It is not a wire terminal and never manufactures a terminal winner. Storage failure leaves the previous state unchanged; recovery can inspect it but cannot infer execution permission from absence of a newer flag.

Journal operations return only after their own outermost transaction commits and reject entry from an already active transaction. They do not invoke native factories, allocate transport sequences, publish output, or grant fresh authority. The coordinator must independently enforce exact current socket, state, attempt, repository, mode and applicable conservative deadlines under ADR 0005, including rechecking immediately before each native effect after synchronous storage work. Mode is recorded only on the first creating transition and cannot subsequently change.

## Terminal integration boundary

Success, failure and cancellation must later share one owned terminal operation, not independent mapJob/publish calls. That operation will check exact owner and predecessor version inside the outermost transaction, retain a validated terminal-to-outbox/profile link, and call the transport's pure envelope factory only when no winner exists. Transport memory may advance only after commit. Historical winner reads must not mutate delivery counters or require a fresh socket. Exact retry identity excludes renewable delivery expiry, but includes the stable logical terminal identity, correlation and sanitized business payload.

Normal action/approval revocation is separate from an already admitted cancellation-drain lifetime. Cancellation binds confirmed cancel_revision, not a later progress revision. Neither this journal nor a durable ACK provides such permission. Remote already-terminal reconciliation must remain distinct from a locally committed winner; it cannot create an invented outbound event. These consumer boundaries remain required before plugin activation.

## Compatibility, retention and rollback

All existing unowned mappings, receipt rows and outbox rows remain unchanged. Retain compact intent identity and future winner links alongside their receipt/outbox recovery evidence; do not delete them as if they were seven-day full logs. Full native-log retention remains a separate integration requirement. No destructive migration, queue deletion, legacy backfill or automatic replay of ambiguous initial input is authorized. Rollback preserves the database and keeps incompatible integrated execution unavailable; preserving the physical schema alone does not make an older adapter safe for new owned intents.

## Verification

Use real SQLite files and reopen checks for atomic prepare, immutable identities, exact CAS transitions, non-reusable generations, one active attempt, opaque native MessageIds, mode immutability, unavailable latching, corrupt metadata/index/mapping detection, legacy coexistence and legacy-write refusal. Inject SQL failures after each multi-row mutation and verify full rollback. Reject nested transactions before mutation. Native flush/history and crash-at-followup evidence, atomic terminal races, live authority and the complete plugin gate are separate mandatory integration tests, not established by journal unit tests.

## Alternatives

Separate best-effort mappings and in-memory started flags cannot distinguish a crash before input from a crash after input. Automatically retrying a submitting intent risks duplicate execution. A new schema version is unnecessary for this bounded metadata record and would widen rollback obligations. The selected journal accepts conservative unavailability at ambiguous boundaries in exchange for never silently issuing a second initial request.
