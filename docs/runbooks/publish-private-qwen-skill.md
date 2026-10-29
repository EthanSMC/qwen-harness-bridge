# Publish the private Qwen Skill

This runbook publishes the built private Qwen Skill artifact to the owner's Qwen
platform account, binds it to that account only, and records the evidence needed
to prove the access scope. It is written for the accountable repository owner.

Status: the local build and check steps below have been executed and are green.
The platform steps in "Publish" and "Verify access scope" are
**NOT EXECUTED — BLOCKED-ENVIRONMENT**: they need the owner's Qwen platform
account and secret configuration, which this implementation environment does not
have. Do not claim a platform result that was not observed.

## Preconditions

Record these before starting; none of them may contain a credential value:

- the built artifact digest from `node packages/qwen-skill/scripts/check-package.mjs`;
- the artifact version from `manifest.json` and the exact source commit it records;
- the owner Qwen platform account that is allowed to use the Skill;
- the production MCP endpoint URL and the platform secret entry that holds its
  access value (the secret itself stays in the platform secret store);
- the previous private artifact version retained for rollback.

## Build and check locally

Run from the repository root:

```bash
node packages/qwen-skill/scripts/build-package.mjs
node packages/qwen-skill/scripts/check-package.mjs
```

When the build runs outside a git checkout (for example in a container), it
takes the source commit from `GITHUB_SHA`, `QHB_SOURCE_COMMIT` or
`SOURCE_COMMIT`, in that order; `--source-commit <sha>` overrides it. The build
fails when no commit can be resolved, and it never invents one.

The build writes `dist/qwen-skill-<version>.zip`, `dist/manifest.json` and
`dist/SHA256SUMS`. The check re-reads the archive, recomputes every checksum,
derives the expected content list again, re-runs the build to prove digest
reproducibility, and confirms that the seven MCP tools match the protocol schema
sources. Both commands must exit zero before any platform step.

The artifact must contain only `SKILL.md`, `skill.json`,
`mcp.import.example.json`, `config/repositories.json`, the referenced
Markdown files and the transcript schema mapping. It must never contain
transcript fixtures, tests, source maps, local reports, environment files,
keychain material or a credential literal.

## Publish

These steps are owner-only and are **NOT EXECUTED** in this repository's
automation environment:

1. Sign in to the Qwen platform with the owner account.
2. Create or update the private Skill from `dist/qwen-skill-<version>.zip` and
   record the platform version ID it returns.
3. Bind the Skill to the owner account only; do not add a shared account, team
   scope or public listing.
4. Configure the MCP server import from the packaged `mcp.import.example.json`
   URL and the secret reference through the platform secret configuration. Do
   not paste the access value into the Skill description, a prompt or a comment.
5. Record the platform run ID, the artifact digest, the import timestamp and the
   account binding as publish evidence.

## Verify access scope

**NOT EXECUTED**: an unrelated account check needs a second platform identity.

1. From an account that is not the bound owner, confirm the Skill is not
   discoverable and cannot be invoked.
2. From the owner account, invoke one read-only route and confirm the expected
   receipt is returned.
3. Record both observations and the account identifiers used for the check. Do
   not record passwords, tokens or session links.

## Evidence requirements

Publish evidence is complete only when it contains:

- the artifact digest and the matching `manifest.json` version and source commit;
- the platform version ID, publish timestamp and platform run ID;
- the account binding result and the unrelated-account denial result;
- the verified MCP endpoint URL (not the secret value) and the secret reference
  name;
- the rollback pointer to the retained previous artifact version.

Attach the evidence to the release record, not to a private agent thread.

## Failure handling

- Build or check exits non-zero: fix the reported content, version or secret
  issue; never disable a check to publish.
- Platform import fails: keep the previous version active and record the exact
  platform error code; do not retry with a modified artifact under the same
  version.
- Access-scope verification fails: unpublish the Skill, rotate the MCP secret,
  and treat the publish as failed until the owner re-verifies the binding.
- Rollback is required: follow `docs/runbooks/rollback-qwen-skill.md`.

## Privacy rules

- Never publish credentials, access values, absolute local paths, raw logs,
  prompts or private session links.
- Keep the secret only in the platform secret store and the repository
  environment for local runs.
- Record the account binding and denial result as facts, not as screenshots with
  private account data.
