# Roll back the Harness Connector plugin

This runbook returns an installed macOS Connector to a previous packaged plugin artifact while preserving the local journal and the same SQLite mapping.

Scope: plugin artifact rollback on one Mac. It does not roll back the Control Plane, its PostgreSQL data, or the signing identity. It is a prerequisite rehearsal for the M5 private-beta rollback gate, not a substitute for it.

## Before you change anything

Record, without capturing secrets:

- the currently installed artifact digest and the target rollback artifact digest;
- the configured `databasePath` and the plugin schema version reported at startup (`1` for this release);
- the connector state reported by the Control Plane (online, offline, or job-owned).

## Procedure

1. Stop Harness so no Agent is running and no new job is claimed. Confirm the Control Plane shows the connector offline.
2. Back up the journal database from the stopped host. Copy the file; do not move it:

```bash
cp -- "$databasePath" "$databasePath.backup-$(date -u +%Y%m%dT%H%M%SZ)"
```

3. Install the previous artifact into the Harness extension root, replacing the current extraction. Keep the Cordis `plugin` block and therefore the same `databasePath`, repository `id`, and `canonicalPath`.
4. Start Harness.
5. Verify reconnection and no duplicate execution: the connector returns online, owned jobs are re-admitted from `databasePath` through the attempt journal, and each job reaches exactly one terminal outcome.
6. If the rollback target predates a schema change, do not open a database written by a newer build against it. Restore the matching backup taken in step 2 instead of guessing.

## Verification

- Harness starts with the previous artifact and no `ConfigValidationError`.
- The plugin opens the same `databasePath` and reports the expected schema version.
- The Control Plane records the connector online and a submitted job completes exactly once.
- Approval behaviour matches the rolled-back version: a required approval pauses once and only the matching unexpired decision resumes it.

## If rollback fails

- Startup aborts with `DATABASE_PATH_UNAVAILABLE` or a schema mismatch: stop, and restore the backup from step 2.
- The connector stays offline with `CONNECTOR_SESSION_EXCHANGE_FAILED`: the rollback artifact is incompatible with the current credential or Control Plane protocol version. Do not delete the journal; leave jobs queued and state the blocker.
- A job is re-admitted twice: stop the extension immediately; the journal is the authority, so preserve it and escalate with the exact job identifiers rather than retrying the rollback.

## After a successful rollback

Keep the database backup until the release verification window closes. Remove the rolled-back extraction only when the previous artifact is no longer referenced by the Harness root `cordis.yml`.
