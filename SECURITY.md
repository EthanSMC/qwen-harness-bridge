# Security Policy

## Supported versions

No runtime release is supported yet. Once private beta begins, only the latest stable release and the immediately previous rollback-compatible release receive fixes. Experimental RTC does not inherit a stable availability commitment.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials, private repository paths, prompts, logs, or source data. Use GitHub private vulnerability reporting for this repository. If that channel is unavailable, contact the repository owner through a previously established private channel and include only the minimum reproduction material.

The owner will acknowledge a valid private report, classify impact, preserve evidence, revoke affected credentials when necessary, and publish a private fix/rotation plan before any disclosure.

## Security boundaries

- Qwen and Connector credentials are independent, scoped, revocable, and never committed.
- The Mac Connector is outbound-only; DeepSeek Harness is not exposed directly.
- Local repository/action policy is authoritative and fail-closed.
- Only `allowed-once` releases an approval-required Harness action. Rejected, cancelled, unavailable, expired, mismatched, and denied actions do not execute.
- Full logs and repository content stay on the Mac; cloud events are bounded and redacted.
- RTC audio is not persisted, and RTC can be disabled without affecting stable operation.

Threat-model evidence and security test ownership are maintained in `docs/architecture/threat-model.md` when Plan 4 begins.

