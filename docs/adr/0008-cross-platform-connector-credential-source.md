# ADR 0008: Platform-general Connector bootstrap credential source

Status: **Accepted.** The accountable owner approved this ADR and the Spec §7.4 / §13.1 amendments in the review thread for the Issue #72 pull request ([decision comment](https://github.com/EthanSMC/qwen-harness-bridge/pull/73#issuecomment-5652064803)), and the implementation lands under that approval.

## Context

Spec §7.4 requires the Harness plugin to "retrieve its long-lived bootstrap credential from macOS Keychain" and Spec §13.1 states that the Connector bootstrap credential is "stored in macOS Keychain". The Harness runtime is platform-general: `@deepseek-ai/dsh@0.1.5-rc.1` boots identically on macOS and Windows, and the plugin itself has no macOS-only runtime dependency other than `/usr/bin/security`.

`packages/harness-plugin/src/index.ts` constructs `MacOSKeychainCredentialReader()` unconditionally, and that reader spawns `/usr/bin/security`. On a non-macOS host `apply()` therefore fails closed with `CONNECTOR_CREDENTIAL_UNAVAILABLE`, which is correct fail-closed behaviour but makes the approved live v0.2.0 acceptance (MCP submit → connector claim → safe repository task → exactly-once approval → reconnect without duplicate work) impossible to execute off macOS, and leaves the M1 acceptance permanently environment-blocked.

The macOS Keychain statement is a platform assumption, not a security property. The credential's protection comes from independent revocation, TLS-only transport, exchange for a short-lived session token, and the rule that the value never enters configuration, logs, evidence or the packaged artifact. Both the Darwin Keychain source and a bounded file or environment source can preserve those properties.

## Decision

Keep macOS Keychain as the default and only automatic source on Darwin, and make the source an explicit, fail-closed configuration choice everywhere else.

1. **Selection.** Configuration gains one optional `credentialSource` object with a required `kind` of `keychain`, `file` or `environment`.
   - Darwin: an absent `credentialSource` means `keychain`, preserving today's behaviour exactly.
   - Non-Darwin: an absent `credentialSource` keeps the existing fail-closed `CONNECTOR_CREDENTIAL_UNAVAILABLE` outcome. No platform silently selects a source.
   - `keychain` remains allowed on any platform and keeps failing closed where `/usr/bin/security` is unavailable.
2. **No secret in configuration.** `file` names an absolute path to a regular file; `environment` names an environment variable. Configuration names a location, never a credential value, and the same rule applies to the packaged sample wiring.
3. **Bounded reads.** A `file` source reads at most 16 KiB from a regular file that is not a symlink and whose parent directory resolves canonically, mirroring the existing database-path rules. An `environment` source reads one variable and rejects an empty or over-long value. Both trim exactly one trailing newline, as `security` output does today.
4. **Fail closed, never leak.** A missing, unreadable, empty, oversized, symlinked, or ambiguous source (more than one kind, an unknown kind, or extra fields) fails with the existing bounded `CONNECTOR_CREDENTIAL_UNAVAILABLE` / `ConfigValidationError` codes. No error, log line, evidence record, or artifact may contain the credential value or the resolved location: public evidence records the source kind only.
5. **One seam.** Every source implements the existing `CredentialReader` interface and is injected at the same `bootstrapCredentialProvider` seam, so the session-token exchange, revocation and short-lived-token behaviour are unchanged.
6. **No root license claim.** Adding a repository root LICENSE is a product and legal decision and stays out of scope; this change only carries the license text that vendored third-party packages already ship.

## Consequences

- The live Harness acceptance can run on Windows and Linux as well as macOS, with the source kind recorded in the evidence.
- Darwin operators see no behavioural change.
- The wire protocol, database schema, migration set and redaction rules are unchanged.
- A non-Darwin deployment must place its bootstrap credential in a file or environment variable that the Harness host controls; the runbooks document both, and neither the artifact nor the evidence ever carries the value.
- Without this ADR the Spec's macOS-only wording would be contradicted by shipping code, so implementation stays blocked until it is approved.

## Alternatives considered

- **Keep macOS Keychain only.** Preserves the Spec text verbatim but permanently blocks the approved Windows/Linux acceptance and requires a macOS host for every future rehearsal.
- **Publish the private `@qhb/protocol` and install it from a registry.** Unrelated to credential storage; rejected as out of scope.
- **Read the credential from a command configured as an argv array.** More expressive than needed, and it would make arbitrary execution a configuration surface; the bounded file and environment sources are sufficient.
