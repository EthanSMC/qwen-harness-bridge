# Qwen sandbox and private publish checklist

This checklist records the Task 5 evidence for the private Qwen Skill. It mixes
three kinds of rows and never upgrades one into another:

- **PASS** — executed in this repository or CI on the recorded commit, with the
  observed command result quoted.
- **NOT EXECUTED — BLOCKED-ENVIRONMENT** — the step needs an external platform
  account, endpoint or service that this implementation environment does not
  have. The blocker is named; no result is claimed.
- **PENDING OWNER** — the step is written down for the accountable owner and is
  executed only when the preconditions in the linked runbook are met.

Related runbooks: `docs/runbooks/publish-private-qwen-skill.md`,
`docs/runbooks/rollback-qwen-skill.md`.

## Recorded environment

- Source commit of the package build: the commit that contains this checklist.
- Package version: `0.3.0` from `skill.json` and `packages/qwen-skill/package.json`.
- Platform sandbox account: not available in this environment.
- Staging Control Plane endpoint: not configured in this environment.
- Docker/PostgreSQL: the Docker CLI is not available in this environment, so the
  staging Control Plane plus fake Connector cannot be started here.

## A. Package artifact evidence (executed)

| ID | Check | Command | Observed result |
|---|---|---|---|
| P-01 | Artifact builds with a manifest and digest | `node packages/qwen-skill/scripts/build-package.mjs` | PASS: `SKILL_PACKAGE_BUILD version=0.3.0 sha256=<digest> entries=10 source=<commit>` |
| P-02 | Independent package check | `node packages/qwen-skill/scripts/check-package.mjs` | PASS: `SKILL_PACKAGE_CHECK PASS version=0.3.0 sha256=<digest> entries=10 protocol_tools=7` |
| P-03 | Two builds of the same source have the same digest | `src/package-build.test.ts` reproducibility case | PASS: equal `archive_sha256` and byte-identical archives |
| P-04 | Content allowlist and denylist | `src/package-build.test.ts` content case | PASS: required files present; fixtures, tests, maps, reports, environment files and keychain material absent |
| P-05 | Version mismatch fails closed | `src/package-build.test.ts` version case | PASS: build exits non-zero with `VERSION_MISMATCH` when `skill.json` differs from the package version |
| P-06 | Literal credential in the MCP import fails closed | `src/package-build.test.ts` secret case | PASS: build exits non-zero with a secret/credential error |
| P-07 | Tampered archive digest is rejected | `src/package-build.test.ts` digest case | PASS: check exits non-zero with a digest mismatch |
| P-08 | Manifest/archive listing mismatch is rejected | `src/package-build.test.ts` listing case | PASS: check exits non-zero on the entry mismatch |
| P-09 | Artifact rollback rehearsal keeps the seven tools | `src/package-build.test.ts` rollback case | PASS: candidate digest differs, both artifact manifests expose the same seven MCP tools, the retained previous artifact still passes the check |
| P-10 | Seven tools match the protocol schema sources | `node packages/qwen-skill/scripts/check-package.mjs` (protocol surface phase) | PASS: every tool maps to an existing protocol file and exported schema |
| P-11 | Package protocol suite | `vitest run packages/protocol/src` | PASS: 3 files, 144 tests |
| P-12 | Static skill lint, typecheck, formatting | `node packages/qwen-skill/scripts/lint-skill.mjs`; `tsc -p packages/qwen-skill/tsconfig.json --noEmit`; `biome check packages/qwen-skill` | PASS: lint and typecheck exit 0; biome reports no fixes |
| P-13 | Source commit outside a git checkout | `src/package-build.test.ts` no-git cases | PASS: a copied tree with no `.git` builds when `GITHUB_SHA` (or `QHB_SOURCE_COMMIT` / `SOURCE_COMMIT`) is set and records that commit; with none set the build exits non-zero and writes no manifest |

The digest is recorded in `dist/manifest.json` next to the version and source
commit. The checklist is not the digest authority: read the manifest produced by
the build under test.

Version terminology: the Task 5 text says "root Changeset version". In this
repository the Changesets-managed version source for the private package is
`packages/qwen-skill/package.json`; the build compares
`skill.json.version` with that value (never a hardcoded number and not only one
side). The monorepo version from the root `package.json` is recorded separately
as `monorepo_version` for traceability and legitimately differs today
(`0.3.0` for the package, `0.1.0` for the monorepo), so it is not the equality
target. A build outside a git checkout takes the commit from `GITHUB_SHA`,
`QHB_SOURCE_COMMIT` or `SOURCE_COMMIT`, and fails when none is available.

## B. Official Qwen sandbox matrix (NOT EXECUTED — BLOCKED-ENVIRONMENT)

Blocker B1: no Qwen platform sandbox account or credential exists in this
environment. Blocker B2: no staging Control Plane endpoint is configured. Blocker
B3: the Docker CLI is unavailable, so a local staging Control Plane with the fake
Connector cannot be started here.

Each row must be filled after the owner runs it, with the platform run ID, package
digest, MCP latency, selected route, UI tool used, spoken text and pass/fail.

| Case | Utterance example | Expected MCP call | UI tool | Spoken expectation | Platform run ID | MCP latency | Route | Result |
|---|---|---|---|---|---|---|---|---|
| create | "让 DeepSeek 在 Novelty Web 跑测试" | `submit_task` | text receipt | short id and connector state | — | — | — | NOT EXECUTED (B1, B2, B3) |
| list | "我有哪些任务" | `list_tasks` | `UiTool.list` | list count | — | — | — | NOT EXECUTED (B1, B2, B3) |
| detail | "看一下 QH-7M2P" | `get_task` | `UiTool.all_text` | status and stage | — | — | — | NOT EXECUTED (B1, B2, B3) |
| cancel | "取消 QH-9F3C" | `get_task`, then `cancel_task` once | `UiTool.all_text` | cancellation state | — | — | — | NOT EXECUTED (B1, B2, B3) |
| approval list | "有哪些待审批" | `list_pending_approvals` | `UiTool.list` | list count | — | — | — | NOT EXECUTED (B1, B2, B3) |
| approval confirm | "批准第二个" | `list_pending_approvals`, then `decide_approval` | `UiTool.list` | action and impact confirmation | — | — | — | NOT EXECUTED (B1, B2, B3) |
| approval reject | "拒绝第一个" | `list_pending_approvals`, then `decide_approval` | `UiTool.list` | action and impact confirmation | — | — | — | NOT EXECUTED (B1, B2, B3) |
| expired approval | "批准第二个" after expiry | `list_pending_approvals`, no mutation | `UiTool.list` | refresh and explain | — | — | — | NOT EXECUTED (B1, B2, B3) |
| result text | "读出 QH-9F3C 的结果" | `get_task_result` | `UiTool.all_text` | result summary | — | — | — | NOT EXECUTED (B1, B2, B3) |
| result image | "读出 QH-9F3C 的图片" | `get_task_result` | `UiTool.pic_and_text` | image caption or fallback | — | — | — | NOT EXECUTED (B1, B2, B3) |
| error mapping | "看一下 QH-9F3C" with a forced error | any read call | text detail | one safe next action | — | — | — | NOT EXECUTED (B1, B2, B3) |

The transcript fixtures in `packages/qwen-skill/fixtures/transcripts/` already
encode the expected sequences for these utterances and are validated by the
contract and mutation-safety suites, but a fixture is not a platform run.

## C. Private publish and access scope (PENDING OWNER)

Blockers B1 and B2 apply. Follow `docs/runbooks/publish-private-qwen-skill.md`.

| Step | Evidence to record | Result |
|---|---|---|
| Upload the built artifact as a private Skill | platform version ID, digest, timestamp | PENDING OWNER |
| Bind the Skill to the owner account only | account binding result | PENDING OWNER |
| Configure the MCP endpoint and secret reference | endpoint URL, secret reference name (never the value) | PENDING OWNER |
| Unrelated account cannot discover or invoke | second account, denial observation | PENDING OWNER |

## D. Platform rollback and job queryability (PENDING OWNER)

Blockers B1 and B2 apply. The artifact-level rehearsal (P-09) is executed; the
platform switch and live job queries are not. Follow
`docs/runbooks/rollback-qwen-skill.md`.

| Step | Evidence to record | Result |
|---|---|---|
| Retain the previous private version | previous version ID and digest | PENDING OWNER |
| Switch the active version back | platform rollback timestamp and run ID | PENDING OWNER |
| All seven tools still match protocol 1 | imported tool list equals the seven names | PENDING OWNER |
| Queued job is still queryable | job identifier, state and timestamp | PENDING OWNER |
| Running job is still queryable | job identifier, progress and terminal result | PENDING OWNER |

Local equivalence for the rollback tool surface is executed (P-09 and P-10): the
candidate and previous artifacts expose the same seven MCP tools and every tool
maps to an existing protocol schema. Live queue and running-job queryability
depends on a running Control Plane and is **NOT EXECUTED — BLOCKED-ENVIRONMENT**
(no staging endpoint; Docker/PostgreSQL unavailable).

## Sign-off

| Item | Value |
|---|---|
| Package digest | read from `dist/manifest.json` |
| Source commit | `manifest.json` `source_commit` |
| Platform version ID | PENDING OWNER |
| Sandbox matrix | NOT EXECUTED (B1, B2, B3) |
| Private publish and access scope | PENDING OWNER (B1, B2) |
| Platform rollback and job queries | PENDING OWNER (B1, B2) |
| Accountable owner | the Issue assignee |
