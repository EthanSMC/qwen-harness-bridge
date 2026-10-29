# Solo same-thread self-review contract

Status: approved by the accountable owner. This document is the written design
required by Issue #69 (owner reinstatement comment
https://github.com/EthanSMC/qwen-harness-bridge/issues/69#issuecomment-6486602246,
2026-10-29T02:55:03Z). It is normative for the review gate until the owner
supersedes it in the same public thread.

## 1. Why

The repository has one direct collaborator, the accountable owner. When no
distinct eligible direct collaborator exists, the previous contract offered only
a separately-run independent reviewer. That reviewer is no longer available for
every change, so a change could not pass the gate even when the implementer had
done every verifiable check. Issue #69 adds an explicitly labelled, weaker
option for exactly that situation instead of silently weakening the independent
path.

## 2. The three review modes

Exactly one mode is selected in the pull-request body. The selector is explicit:
no mode is inferred from the absence of a collaborator.

| Mode | Who reviews | Required evidence | Claim strength |
|---|---|---|---|
| `formal` | A distinct eligible direct GitHub collaborator | A current-head APPROVED GitHub review by that collaborator | Strongest: independent account approval |
| `solo-independent` | A fresh independent subagent reviewer, distinct from the implementer | A structured report comment on this PR, schema v1 (`qhb-independent-review:v1`) | Independent agent review, same accountable author |
| `solo-self-review` | The implementer itself, on the same public thread | A structured report comment on this PR, schema v2 (`qhb-self-review:v2`), labelled same-thread | Weakest: the implementer checks its own work; never independent review, never a GitHub approval |

The mode selector stays mutually exclusive: the validator rejects zero checked
modes and more than one checked mode.

## 3. Eligibility

- `formal` is required whenever at least one distinct eligible direct
  collaborator exists. `eligibleCollaborators` and the live state validator keep
  that rule: a solo mode (independent or self-review) fails closed while an
  eligible collaborator exists.
- `solo-independent` and `solo-self-review` are available only when no distinct
  eligible direct collaborator exists. Both therefore require the solo
  eligibility reference and verification date.
- Self-review never becomes available by leaving the mode unchecked, by naming no
  reviewer, or by a body that omits the self-review declaration. It is only
  reachable through the dedicated mode line plus its required declarations.

## 4. Evidence structure

### 4.1 Pull-request body

Solo modes add these fields:

- `Solo eligibility evidence URL or repository-status reference (required for solo mode):`
- `Solo eligibility verification date (required for solo mode):`
- `Independent review report URL (required for solo mode):` for
  `solo-independent`
- `Same-thread self-review report URL (required for self-review mode):` for
  `solo-self-review`
- `Self-review is explicitly weaker than independent review and is not a GitHub approval: [x] Yes`
  is required for `solo-self-review` and must stay unchecked otherwise.

Common fields are unchanged: implementer agent ID, reviewer agent ID, reviewer
identity, commit range (`base.sha..head.sha`), findings, fix rounds, verdict,
and the current PR checks URL.

### 4.2 Reviewer identity declarations

| Declaration | `formal` | `solo-independent` | `solo-self-review` |
|---|---|---|---|
| Reviewer is distinct from implementer | [x] Yes | [x] Yes | [x] No |
| Fresh review of this exact commit range | [x] Yes | [x] Yes | [x] Yes |
| Independent review | [x] Yes | [x] Yes | [x] No |
| Self-review disclosure | unchecked | unchecked | [x] Yes |

### 4.3 Structured report comment

Independent reports keep schema v1 byte-for-byte: marker
`<!-- qhb-independent-review:v1 sha256:<digest> -->`, twelve keys, `reviewer_id`
different from `implementer_id`. Existing and historical independent reports are
never rewritten or relabelled.

Self-review reports use a distinct schema v2 and marker
`<!-- qhb-self-review:v2 sha256:<digest> -->`:

```json
{
  "schema_version": 2,
  "mode": "self-review",
  "repository": "Owner/repo",
  "issue_number": 69,
  "base_sha": "<base>",
  "head_sha": "<head>",
  "implementer_id": "other",
  "reviewer_id": "other",
  "reviewer_identity": "other",
  "verdict": "PASS",
  "findings": [],
  "fix_rounds": 0,
  "verification": ["observed command results"]
}
```

Rules for v2: unknown fields are rejected; `mode` must be `self-review`;
`implementer_id`, `reviewer_id` and `reviewer_identity` must be identical
because the review is same-thread; `PASS` with an open blocker is rejected; the
digest must match the canonical body; the comment must be authored by the
accountable PR author, be on the same pull request, and be unedited.

Shared requirements for every mode: exact repository, Issue, and
`base.sha..head.sha` binding; immutable digest-verified report comments; one
current `/pull/<n>/checks` URL; required current-head CI; findings and fix
rounds recorded; `PASS` with no unresolved blocker.

## 5. Honest labelling

A self-review report is never described as independent review, an independent
subagent reviewer, or a GitHub approval. The body's self-review disclosure, the
v2 marker and the mode field make the weakness machine-visible and
human-visible. The PR checklist keeps "The author did not self-approve or
fabricate review evidence" true for self-review: the author records its own
checks as exactly that, and no approval of a different account is claimed.

## 6. Mutual exclusion and failure modes

The gate fails closed when:

- no mode or more than one mode is checked;
- a solo mode is selected while a distinct eligible direct collaborator exists;
- the selected mode's own evidence is missing, or another mode's evidence is
  present (for example formal review fields in a solo mode, or an independent
  report URL in self-review mode);
- the identity declarations contradict the selected mode (distinct or
  independent answered Yes for self-review, or No for the other modes);
- the report comment is stale (base/head mismatch), edited, tampered (digest
  mismatch), authored by a different account, on a different pull request, or
  names a different Issue;
- the verdict is not PASS or an unresolved blocker is recorded;
- the CI evidence is not this pull request's current checks URL, or a required
  current-head check is not successful.

## 7. Historical compatibility

- Reports written before this contract have no mode field: the v1 marker and its
  twelve keys remain the independent-report contract. Nothing is relabelled.
- Old pull requests that only know the formal and solo modes keep validating:
  the two original mode lines are unchanged, and the new evidence fields are
  optional outside self-review mode.
- The validator never reinterprets an existing comment. A v1 comment is
  independent evidence; a v2 comment is self-review evidence; a comment that
  mixes markers or fields is rejected.

## 8. Rollback

Revert the change set that introduces the mode. The pull-request validator then
returns to the formal/solo contract, the previously accepted self-review PRs
become unmergeable until re-reviewed independently, and no stored report or
historical comment is modified. No database, protocol, or runtime state is
involved.

## 9. Owner confirmation

This is a rule change. The pull request that implements it is not merged until
the accountable owner confirms the contract in a public repository comment. The
owner's reinstatement comment above authorizes the implementation; the merge
confirmation is recorded separately on the pull request.
