# ADR 0004: Bounded Connector event projection

Status: Accepted implementation decision for Issue #13; integrated verification pending.

## Context

Task 6 requires field-level redaction, 500 UTF-8 byte summaries and up to 50 changed-file names. The shared event validator currently caps every array at 32. Merely sending 32 names would silently narrow the approved result contract. Passing raw Harness event objects through recursive string replacement would also retain source bodies or tool arguments under unexpected keys.

## Decision

The plugin constructs a fresh public event payload from an explicit projection: summary, stage, changed_files, tests (passed, failed, total), and artifacts (name, media_type, url). Other fields are omitted without reading their values. Permitted structured fields must be correctly typed, dense and data-only; accessors, custom prototypes, executable serialization, cycles, non-finite counters and invalid path/URL structure reject the event with a fixed local error, never an input-derived exception. Known private fields are not made publishable by renaming them. This projection does not infer result content from arbitrary model text.

Redaction runs before UTF-8 truncation, covering explicitly supplied local secrets, credential patterns, environment assignments, source-like text and raw/multiline output. Repository paths use the existing canonical path resolver, including its nearest-existing-ancestor handling for deleted files. Publish only contained relative changed-file names, never a replacement absolute path. Other home prefixes and private paths become fixed redaction markers. HTTP(S) artifact URLs lose credentials, query and fragment; unsupported or malformed URLs reject. Structured identifiers and paths are validated rather than shortened. Only summaries and human-readable artifact names are text-truncated; a valid changed-file list may be capped at 50 only after all bounded input entries have been validated. Inputs beyond the bounded inspection limit reject instead of claiming a partial validation.

The shared validator permits up to 50 items only for the exact top-level changed_files field, and that field must be a dense string array. Other arrays retain the 32-item cap; nested lookalike fields receive no exception. The existing 500-byte string, 16-KiB payload, depth and key limits remain. Oversized structured output rejects rather than dropping fields to fit. The projection passes through this shared validator before it is eligible for the durable outbox.

## Compatibility and integration

Existing correctly typed payloads within the previous bounds remain readable. The earlier generic schema also accepted malformed changed_files values such as scalars; these now reject, so this is a validation tightening as well as an increased string-list capacity, not blanket acceptance of every formerly parseable payload. Do not rewrite historical malformed queued records into successful events; surface an explicit incompatible-state condition. A previous server rejects a 33–50-name payload; it must not be treated as successful delivery or permission. The integrated Task 6 plugin must negotiate an explicit composition capability with the updated server before accepting work, and must not emit extended payloads to an unconfirmed server. Capability negotiation and the real pre-enqueue call site remain required Task 6 integration work, not evidence provided by this component alone. Rollback disables incompatible Connectors, retains their durable state, and does not rewrite queued events or pretend old receivers support the extension.

## Verification

Test actual projection plus shared parsing for 50 names and reject 51 wire names, non-string members, nested cap bypasses and the unchanged 16-KiB bound. Security fixtures cover bearer/API credentials, environment assignments, source/tool arguments, user homes, repository paths, traversal, symlink escape, deleted files, URL credentials/query/fragment, multibyte truncation, malformed structures beyond the first 50 entries, and accessors that must not execute. Preserve useful safe summaries, file names, test counters and artifact metadata. Whole-plugin tests must later prove the projection is used before every relevant outbox write; these unit/contract tests cannot establish that integration.
