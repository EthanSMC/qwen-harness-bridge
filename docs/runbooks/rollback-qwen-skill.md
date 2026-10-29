# Roll back the private Qwen Skill

This runbook returns the private Qwen Skill on the owner Qwen platform to a
previous package version while keeping queued and running jobs queryable. It
covers the Skill package and its platform binding only; it does not roll back the
Control Plane, PostgreSQL or the Connector.

Status: the artifact-level rehearsal below has been executed locally and is
green. Switching the active platform version and the live job-query check are
**NOT EXECUTED — BLOCKED-ENVIRONMENT**: they need the owner Qwen platform
account and a staging Control Plane with PostgreSQL, which this implementation
environment does not provide.

## Before you change anything

Record, without capturing secrets:

- the current active package version and its artifact digest;
- the target rollback package version and its artifact digest;
- the Control Plane build and Connector build that stay unchanged;
- one queued and one running job identifier that will be queried after the switch.

## Artifact-level rehearsal (local, executed)

Build the current artifact twice and prove the digest is stable:

```bash
node packages/qwen-skill/scripts/build-package.mjs --out dist/rehearsal-a
node packages/qwen-skill/scripts/build-package.mjs --out dist/rehearsal-b
node packages/qwen-skill/scripts/check-package.mjs --package dist/rehearsal-a
```

The focused suite `packages/qwen-skill/src/package-build.test.ts` also builds a
candidate version from a copied package tree, proves the two digests differ, and
proves both artifacts expose the same seven MCP tools. That is the artifact-level
rollback rehearsal; it does not touch a live platform.

## Switch the active version (owner-only, NOT EXECUTED)

1. Keep the previous artifact version uploaded and private; do not delete it.
2. In the Qwen platform, switch the active version back to the retained artifact.
3. Keep the same MCP endpoint URL and the same secret reference; do not rotate
   the secret as part of the rollback.
4. Record the platform rollback timestamp, platform run ID, previous and active
   version IDs, and the artifact digest that is now active.

## Verify after rollback (NOT EXECUTED for the live Control Plane)

1. Confirm all seven MCP tools still match protocol version 1:
   `submit_task`, `list_tasks`, `get_task`, `cancel_task`,
   `list_pending_approvals`, `decide_approval`, `get_task_result`.
   The local `check-package` command already proves the tool surface from the
   artifact; on the platform, confirm the imported tool list equals the same
   seven names.
2. Query the queued job recorded before the switch and confirm its state is
   returned.
3. Query the running job and confirm its progress and later terminal result are
   still returned.
4. Submit one new task and confirm the receipt short id is returned.
5. Record each query result with the job identifier and timestamp.

If the live Control Plane is unavailable, record
`NOT EXECUTED — BLOCKED-ENVIRONMENT` with the exact missing dependency; do not
mark the rollback verified.

## Failure handling

- The platform refuses the previous version: keep the current version active and
  record the exact platform error code; do not publish a rebuilt artifact under
  the old version.
- The MCP tools no longer match: stop the rollback, unpublish the Skill, and
  restore the previous active version after the tool surface is re-verified.
- Queued or running jobs become unqueryable: leave the Control Plane running,
  preserve the evidence, and escalate with the job identifiers instead of
  retrying the rollback.
- Approval or cancellation behaviour differs after rollback: treat the rollback
  as failed and restore the previous active version.

## Completion evidence

Rollback is complete only when the artifact digest, platform version IDs and
timestamps, seven-tool verification, queued-job query and running-job query are
all recorded and the unrelated-account access scope stayed unchanged.
