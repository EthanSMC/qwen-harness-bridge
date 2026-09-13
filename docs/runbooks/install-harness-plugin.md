# Install the Qwen Harness Bridge Connector

This runbook installs the packaged Connector plugin into a Harness host that supports Cordis plugins. It covers the self-contained artifact, the Keychain credential, the sample wiring, the startup checks, and a platform-general rehearsal.

Scope: one Harness host, one configured repository root, and one Control Plane connector identity. It does not cover Control Plane deployment (see `control-plane-local.md`) or release tagging.

## 1. Prerequisites

- A Harness version that supports Cordis plugins and the injected modules `agents`, `sessions`, `sessionPersistence`, `approval`, and `tools`.
- Node.js and pnpm matching the repository toolchain.
- A Control Plane `wss://` endpoint, a connector UUID, and a bootstrap credential issued out of band. Never place the credential in a repository file, chat, or Issue.
- One repository root that is a real directory, addressed by its canonical absolute path.
- On macOS, a login Keychain available to the account that runs Harness. The Keychain read itself is the only macOS-specific step.

## 2. Build the installable artifact

Run from the repository root. The build is reproducible: the archive is a deterministic ustar with zeroed timestamps and a stable entry order.

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter @qhb/protocol build
pnpm --filter @qhb/harness-plugin build
pnpm --filter @qhb/harness-plugin pack
```

`pack` writes `packages/harness-plugin/dist-package/qhb-harness-plugin.tar` (or the path passed as its first argument) and prints the entry count and artifact SHA-256. Set `QHB_BOOTSTRAP_CREDENTIAL` for the packaging step to also fail when that exact value would be copied in.

The archive is **self-contained**:

| Archive path | Contents |
|---|---|
| `package/package.json` | Installable manifest. `workspace:` specifiers are removed and the vendored runtime packages are listed in `qhbVendoredDependencies`; `qhbSchemaSha256` pins the shipped SQLite schema. |
| `package/cordis.example.yml` | Credential-free sample wiring. |
| `package/dist/**` | Compiled plugin with self-contained source maps. |
| `package/node_modules/**` | Every runtime dependency, including the private workspace package `@qhb/protocol`, `zod`, `ws`, `better-sqlite3` and its transitive closure. |
| `package/LICENSE` | Present only when the repository ships a root license. |

Host-provided peers are deliberately **not** vendored. Every `@deepseek-ai/*` package listed in `peerDependencies` comes from the Harness host. Packaging fails when a supplied credential value or a credential-looking assignment would enter the archive, and the credential guard also covers camelCase keys such as `bootstrapToken` and unquoted values.

Because `better-sqlite3` ships a native binding, build the artifact on a machine whose platform and architecture match the target host.

The packaged smoke test proves the archive installs and runs:

```bash
pnpm --filter @qhb/harness-plugin pack:test
```

Expected: the test extracts the archive into a clean temporary root **outside the repository tree** with no monorepo `node_modules` in its ancestry, links only the host peers `@deepseek-ai/*`, imports the packaged entry in a separate process, loads `cordis.example.yml` and validates it against the packaged config schema, opens the journal, asserts no credential value or credential-looking assignment is present, and asserts that removing the vendored `@qhb/protocol` makes the same import fail closed.

## 3. Store the bootstrap credential

Read the value without echoing it and without leaving it in shell history:

```bash
set +o history
read -r -s -p "Bootstrap credential: " QHB_BOOTSTRAP; printf '\n'
service="qhb-connector"
account="qhb-connector-bootstrap"
security add-generic-password -U -s "$service" -a "$account" -w "$QHB_BOOTSTRAP"
unset QHB_BOOTSTRAP
set -o history
```

`-U` updates an existing item instead of failing. Passing the value through `-w "$QHB_BOOTSTRAP"` is briefly visible to local process listings; if your `security` build supports an interactive prompt (`security add-generic-password -h`), prefer that form.

Verify the exact lookup the plugin performs, without printing the secret:

```bash
test -n "$(security find-generic-password -s "$service" -a "$account" -w)"
```

A missing or unreadable item makes the plugin raise `CONNECTOR_CREDENTIAL_UNAVAILABLE` and fail closed instead of connecting unauthenticated.

## 4. Wire the plugin

1. Create the local database directory: `databasePath` must be an absolute path whose parent directory already exists and is not reached through a symlink.
2. Merge the `plugin` block from `packages/harness-plugin/cordis.example.yml` into the Harness root `cordis.yml`.
3. Replace `connectorId`, `controlPlaneUrl`, `keychainService`, `keychainAccount`, `databasePath`, the repository `id`, `displayName`, and `canonicalPath`.
4. Keep exactly one entry under `repositories`. Two or more entries abort startup with `MULTI_REPOSITORY_UNSUPPORTED` before any effect is registered.

Configuration is validated before the plugin opens the database or the socket. Validation failures surface as `ConfigValidationError` codes:

| Code | Meaning |
|---|---|
| `INVALID_PLUGIN_CONFIG` | Missing, malformed, or unknown field; non-`wss://` URL. |
| `REPOSITORY_PATH_NOT_CANONICAL` | The repository root is relative, unresolvable, or a symlinked path. |
| `INVALID_DATABASE_PATH` | The database path is not absolute. |
| `DATABASE_PATH_UNAVAILABLE` | The parent directory does not exist or cannot be resolved. |
| `DATABASE_PATH_NOT_CANONICAL` | The database file is a symlink or resolves elsewhere. |
| `DUPLICATE_REPOSITORY_ID` | Two repositories share an `id`. |

## 5. Rehearse install, rotation, and rollback on any supported platform

The Harness runtime is platform-general, so the rehearsal does not need macOS. Run:

```bash
pnpm --filter @qhb/harness-plugin rehearse:install -- --out rehearsal.json
```

The script builds, packs, installs into a clean root outside the repository, links only the host peers, loads the sample wiring through the packaged schema, opens the journal, rotates the credential source, and reinstalls the artifact over the same SQLite mapping. It prints a JSON report with the environment, the artifact SHA-256, the sample and configuration digests, and a per-step status:

- `credential-read` reports `PASS` on macOS when a Keychain item is present and `FAIL-CLOSED` with `CONNECTOR_CREDENTIAL_UNAVAILABLE` on any host without `/usr/bin/security`. Both outcomes are correct; record which one you observed.
- `rotate-credential` is `PARTIAL` off macOS: the credential source is rotated and the journal is preserved, but the live Keychain item and the Control Plane exchange cannot be exercised there.

## 6. Load and verify

Start Harness with the plugin enabled and confirm the outbound connection from the Control Plane side, not from local log content.

Checks that must all hold:

- Harness starts without a `ConfigValidationError`.
- The plugin opens `databasePath` and reports its schema version (`1` for this release).
- The Control Plane records the connector as online.
- Submitting a job from the MCP fixture is claimed by this host, runs inside `canonicalPath`, and produces one terminal result.
- No credential value, full log, or private absolute path appears in the Control Plane output or in the artifact.

Then run the repository gates on the installing host:

```bash
pnpm check && pnpm test
```

## 7. Troubleshooting

- `Cannot find package '@qhb/protocol'` while importing the packaged entry: the artifact is not self-contained. Rebuild it with `pnpm --filter @qhb/harness-plugin pack` and confirm the failure stops; the packaged smoke test covers this case.
- `CONNECTOR_CREDENTIAL_UNAVAILABLE`: the Keychain item is missing, the account differs, the login Keychain is locked, or the host is not macOS. Re-run step 3 and re-check the service/account pair.
- `CONNECTOR_SESSION_EXCHANGE_FAILED`: the exchange endpoint rejected the request or was unreachable. Verify the `wss://` host, that the Control Plane serves `/connector/v1/session`, and that the connector UUID and credential are still valid.
- `MULTI_REPOSITORY_UNSUPPORTED`: reduce `repositories` to one entry; per-job redaction for multiple roots is not specified in this release.
- Startup succeeds but no job is claimed: confirm the Control Plane sees the connector as online and that the repository `id` matches the issued identity.
- A policy denial for a search or executable action: the action domain rules are authoritative (see ADR 0002). Do not widen the configuration to bypass a denial.

## 8. Uninstall

Stop Harness, remove the plugin block from the Harness root `cordis.yml`, delete the extracted extension directory, and keep or delete `databasePath` deliberately. To remove the credential, delete the Keychain item:

```bash
security delete-generic-password -s "$service" -a "$account"
```

See `rollback-harness-plugin.md` before deleting the database.
