# Repository Agent Contract

GitHub is the shared source of truth for repository work. The Issue assignee is the accountable human; an AI agent is a traceable executor or reviewer, never an anonymous owner.

## Before editing

1. Read `CONTRIBUTING.md`, `docs/github/ai-collaboration.md`, the target Issue, and every linked specification or implementation-plan task.
2. Confirm the Issue is open, has `status:ready`, has no assignee, has no open declared dependency, and has no open pull request that closes it.
3. Post `/ai-claim` with a safe agent class and wait for the repository workflow's success receipt. A command comment by itself is not a claim.
4. Do not work on an Issue claimed by somebody else or begin before the success receipt exists.

```text
/ai-claim
agent: codex
```

## While working

- Use one Issue, one supported branch, one isolated worktree, and one primary pull request.
- Branch from current `origin/main` using `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `security/<issue>-<slug>`, or `docs/<issue>-<slug>`.
- Use test-first development for behavior changes. Preserve unrelated user changes and avoid parallel writes to shared files.
- Keep the 24-hour claim lease active with a bounded public checkpoint:

```text
/ai-heartbeat
summary: protocol schema implemented; integration tests remain
```

- Use `/ai-block` only for a concrete external condition, `/ai-resume` after verifying that condition changed, and `/ai-release` when abandoning the claim. Handoff is release followed by a fresh claim from the recipient.
- Never publish a private agent thread or share link, prompt, model reasoning, credential, raw/full log, source body, private repository path, or local absolute path.

## Pull request and completion

- The pull request author and accountable Issue assignee must match.
- Include exactly one primary `Closes #N`, the workflow claim receipt URL, accountable owner, safe implementer agent class, exact verification evidence, risk, compatibility, migration/privacy impact, and rollback.
- A different agent or eligible collaborator reviews the complete final commit range. Follow the formal-collaborator or solo-maintainer review gate in `CONTRIBUTING.md`; never self-approve or fabricate evidence.
- Every new push invalidates stale review evidence. Merge only after the required current-head checks pass and all conversations are resolved.
- After merge, verify that the intended Issue closed as completed, `status:done` is present, the assignee was removed, the merge commit is reachable from `origin/main`, and the branch/worktree can be safely removed.
- A milestone is complete only when its Issues, acceptance evidence, checks, changelog, versions, rollback artifacts, tag, and GitHub Release all pass the documented release gate.

If GitHub state is missing, contradictory, malformed, stale, or unavailable, stop and fail closed. Do not infer ownership or completion from local files or an agent conversation.

