# Repository Agent Contract

GitHub is the shared source of truth for repository work. The Issue assignee is the accountable human; an AI agent is a traceable executor or reviewer, never an anonymous owner.

## Before editing

1. Read `CONTRIBUTING.md`, `docs/github/ai-collaboration.md`, the target Issue, and every linked specification or implementation-plan task.
2. Confirm the Issue is open, has exactly one managed `type:*`, has `status:ready`, has no assignee, has no open declared dependency, and has no open pull request that closes it.
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
- Keep the 24-hour implementation lease active with a bounded public checkpoint until a qualifying pull request enters review:

```text
/ai-heartbeat
claim-id: 550e8400-e29b-41d4-a716-446655440000
summary: protocol schema implemented; integration tests remain
```

- Use `/ai-block` only for a concrete external condition, `/ai-resume` after verifying that condition changed, and `/ai-release` when abandoning the claim. Handoff is release followed by a fresh claim from the recipient.
- Copy the current workflow-generated claim UUID into the required `claim-id` field for every heartbeat, block, resume, or release. If `CLAIM_MISMATCH` is returned, stop and verify the current receipt and assigned executor. Only the executor for that generation may retry; otherwise use explicit release and fresh claim for handoff.
- Create the qualifying pull request strictly before the implementation lease expires. Its verified `pr-open` receipt grants a durable review lock; `/ai-heartbeat` is not accepted in `status:review`. Closing it unmerged restores `status:in-progress` with a fresh 24-hour lease.
- At task start, record what is in scope, what is out of scope, and what proves completion; update that boundary only when scope changes. Subsequent checkpoints state concrete progress, remaining work or the exact blocker, and bounded verification. Unrelated side tasks do not block a completed deliverable. After the same failure occurs three times, change method or state the exact blocker. Fix blocking correctness findings in the current review; record optional enhancements as follow-up work. Report the verification outcome already observed instead of repeating an expensive full suite without a relevant change or unresolved concern.
- Never publish a private agent thread or share link, prompt, model reasoning, credential, raw/full log, source body, private repository path, or local absolute path.

## Pull request and completion

- The pull request author and accountable Issue assignee must match.
- Include exactly one standalone primary `Closes #N`, the current workflow claim receipt URL, accountable owner, safe implementer agent class, exact verification evidence, risk, compatibility, migration/privacy impact, and rollback.
- A different agent or eligible collaborator reviews the complete final commit range. Follow the formal-collaborator or solo-maintainer review gate in `CONTRIBUTING.md`; never self-approve or fabricate evidence.
- Every new push invalidates stale review evidence. Merge only after the required current-head checks pass and all conversations are resolved.
- After merge, verify that the intended Issue closed as completed, `status:done` is present, the assignee was removed, the merge commit is reachable from `origin/main`, and the branch/worktree can be safely removed.
- A milestone is complete only when its Issues, acceptance evidence, checks, changelog, versions, rollback artifacts, tag, and GitHub Release all pass the documented release gate.

If GitHub state is missing, contradictory, malformed, stale, or unavailable, stop and fail closed. Do not infer ownership or completion from local files or an agent conversation.
