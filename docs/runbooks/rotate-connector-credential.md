# Rotate the Connector bootstrap credential

This runbook rotates the macOS Keychain bootstrap credential for one installed Connector without losing queued or running jobs. The credential is read lazily at each session-token exchange, so an update takes effect on the next exchange rather than at process start.

Scope: credential rotation only. It does not change the connector UUID, the repository root, or the Control Plane deployment.

## When to rotate

- Scheduled rotation, operator offboarding, or suspected disclosure.
- The Control Plane reports `CONNECTOR_SESSION_EXCHANGE_FAILED` for a credential that was already revoked.

## Procedure

1. Issue the replacement credential in the Control Plane **before** touching the Mac. Keep the previous credential valid until step 5 succeeds, so a failed rotation never leaves the connector unable to authenticate.
2. Update the Keychain item in place. The service and account names must stay exactly as configured, otherwise the plugin cannot find the item:

```bash
set +o history
read -r -s -p "New bootstrap credential: " QHB_BOOTSTRAP; printf '\n'
service="qhb-connector"
account="qhb-connector-bootstrap"
security add-generic-password -U -s "$service" -a "$account" -w "$QHB_BOOTSTRAP"
unset QHB_BOOTSTRAP
set -o history
test -n "$(security find-generic-password -s "$service" -a "$account" -w)"
```

3. Force a fresh exchange so the running process stops using the cached session token. The connector reconnects after the extension is reloaded or Harness is restarted; a session token stays valid until its own expiry, so a rotation is complete only after the next successful exchange.
4. Confirm the Control Plane accepted the new credential: the connector returns online and the next claim succeeds.
5. Revoke the previous credential in the Control Plane only after the new exchange is observed.
6. Confirm no job was lost: jobs that were queued or owned are re-admitted from the local journal database at `databasePath`, and no job is executed twice.

## Verification

- The connector is online with the new credential.
- One submitted job is claimed and reaches exactly one terminal outcome.
- The Keychain lookup returns a non-empty value for the configured service/account pair.
- No credential value appears in the Control Plane output, local logs, or the artifact.

## Rollback of a rotation

Restore the previous value with the same in-place update, then force a fresh exchange:

```bash
security add-generic-password -U -s "$service" -a "$account" -w "$PREVIOUS_VALUE"
```

If the previous credential was already revoked in the Control Plane, the connector fails closed with `CONNECTOR_SESSION_EXCHANGE_FAILED` until a valid credential is installed. Jobs stay in PostgreSQL or in the local journal; they are not lost by a failed rotation.

## Failure handling

- Never delete the Keychain item and leave it missing while Harness runs: the reader returns `CONNECTOR_CREDENTIAL_UNAVAILABLE` and the connector refuses to authenticate.
- Never copy the credential into `cordis.yml`, an environment file inside the repository, an Issue, a pull request, or the release artifact.
- If the same exchange failure persists three times, stop and check Control Plane revocation state instead of retrying the Keychain write.
