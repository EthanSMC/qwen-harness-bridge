import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const spec = "docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md";
const plans = [
  "docs/superpowers/plans/2026-09-01-foundation-control-plane.md",
  "docs/superpowers/plans/2026-09-01-harness-plugin-connector.md",
  "docs/superpowers/plans/2026-09-01-qwen-skill-device-ux.md",
  "docs/superpowers/plans/2026-09-01-reliability-operations.md",
  "docs/superpowers/plans/2026-09-01-experimental-rtc.md",
];
const governance = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/implementation.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/workflows/governance.yml",
  ".github/workflows/ai-issue-lifecycle.yml",
  ".github/pull_request_template.md",
  ".github/labels.yml",
  ".github/milestones.yml",
  "docs/github/repository-status.md",
];
const aiGovernance = [
  "AGENTS.md",
  "docs/github/ai-collaboration.md",
  "docs/github/ai-lifecycle-migrations.json",
  "docs/superpowers/specs/2026-09-04-ai-issue-collaboration-design.md",
  "docs/superpowers/plans/2026-09-04-ai-issue-collaboration.md",
];
const syncManagement = "scripts/github/sync-management.mjs";

const files = [spec, ...plans, ...governance, ...aiGovernance, syncManagement];
const contents = new Map(
  files.map((file) => [file, readFileSync(resolve(root, file), "utf8")]),
);
const forbidden = /\b(?:TODO|TBD|FIXME|XXX)\b|implement later|fill in|QH-XXXX/i;
for (const [file, content] of contents) {
  if (forbidden.test(content))
    throw new Error(`${file} contains an unresolved planning marker`);
}

const taskCount = plans.reduce((count, file) => {
  return count + [...contents.get(file).matchAll(/^## Task \d+:/gm)].length;
}, 0);
if (taskCount !== 34)
  throw new Error(`expected 34 implementation tasks, found ${taskCount}`);

const allPlans = plans.map((file) => contents.get(file)).join("\n");
const requiredTerms = [
  'protocol_version: "1.0"',
  "waiting_approval",
  "submit_task",
  "decide_approval",
  "apply(ctx)",
  "allowed-once",
  "QHB_RTC_ENABLED=false",
];
for (const term of requiredTerms) {
  if (!allPlans.includes(term))
    throw new Error(`planning baseline is missing required contract: ${term}`);
}

const requireGovernanceField = (file, pattern, message) => {
  if (!pattern.test(contents.get(file)))
    throw new Error(`${file} governance gate is missing ${message}`);
};

const requireSourceField = (source, file, pattern, message) => {
  if (!pattern.test(source))
    throw new Error(`${file} governance gate is missing ${message}`);
};

const lifecycleLabels = [
  "status:waiting",
  "status:ready",
  "status:in-progress",
  "status:review",
  "status:blocked",
  "status:done",
];
for (const label of lifecycleLabels) {
  requireGovernanceField(
    ".github/labels.yml",
    new RegExp(`name: "${label}"`),
    label,
  );
}

for (const command of [
  "/ai-claim",
  "/ai-heartbeat",
  "/ai-block",
  "/ai-resume",
  "/ai-release",
]) {
  requireGovernanceField(
    "AGENTS.md",
    new RegExp(command.replace("/", "\\/")),
    command,
  );
}

const lifecycleMigrations = JSON.parse(
  contents.get("docs/github/ai-lifecycle-migrations.json"),
);
if (
  lifecycleMigrations.schema_version !== 2 ||
  !Array.isArray(lifecycleMigrations.entries) ||
  !(
    lifecycleMigrations.mutation_acceptance === null ||
    typeof lifecycleMigrations.mutation_acceptance === "object"
  ) ||
  !(
    lifecycleMigrations.activation_commit === null ||
    /^[0-9a-f]{40}$/u.test(lifecycleMigrations.activation_commit)
  )
) {
  throw new Error("AI lifecycle migration registry has an invalid schema");
}

for (const template of [
  ".github/ISSUE_TEMPLATE/implementation.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
]) {
  for (const [pattern, message] of [
    [/label: Dependencies/, "the Dependencies field"],
    [/Blocked by none/, "the canonical no-dependency value"],
    [/label: Outcome/, "the Outcome field"],
    [/label: Verification/, "the Verification field"],
    [/label: Risk and rollback/, "the Risk and rollback field"],
    [/label: Definition of done/, "the Definition of done field"],
  ]) {
    requireGovernanceField(template, pattern, message);
  }
}

for (const [pattern, message] of [
  [/Primary Issue: #/, "the primary Issue field"],
  [/Claim receipt: https:\/\/github\.com\//, "the claim receipt field"],
  [/Accountable owner: @/, "the accountable owner field"],
  [/Implementer agent class:/, "the implementer agent class field"],
]) {
  requireGovernanceField(".github/pull_request_template.md", pattern, message);
}

for (const [file, pattern, message] of [
  ["README.md", /public GitHub repository/i, "the public repository state"],
  [
    "CHANGELOG.md",
    /Public-repository governance/,
    "the public repository governance entry",
  ],
  [
    "README.md",
    /branch protection is enabled on `main`/i,
    "the enabled main-branch protection state",
  ],
  [
    spec,
    /Manage source, product progress, milestones, versions, release notes, and decisions in a public GitHub repository/,
    "the public repository V1 goal",
  ],
  [
    spec,
    /Public repository named `qwen-harness-bridge`/,
    "the public repository workflow decision",
  ],
  [
    spec,
    /Public GitHub monorepo with unified versioning, milestones, protected main/,
    "the approved public repository design decision",
  ],
])
  requireGovernanceField(file, pattern, message);

for (const [file, pattern] of [
  [
    "README.md",
    /after the private GitHub repository exists|private-repository branch-protection limitation/i,
  ],
  ["CHANGELOG.md", /Private-repository governance/i],
  [
    spec,
    /in a private GitHub repository|Private repository named `qwen-harness-bridge`|Private GitHub monorepo/i,
  ],
  [
    syncManagement,
    /private-repository|private repository|make this repository public/i,
  ],
]) {
  if (pattern.test(contents.get(file))) {
    throw new Error(`${file} contradicts the current public protected state`);
  }
}

const prTemplate = ".github/pull_request_template.md";
for (const [pattern, message] of [
  [/Do not check both boxes/, "the prohibition on selecting both review modes"],
  [
    /Review mode \(check exactly one\)/,
    "an explicit mutually-exclusive review mode selector",
  ],
  [/Formal GitHub review/, "the formal GitHub review mode"],
  [/Solo-maintainer fallback/, "the solo-maintainer fallback mode"],
  [
    /no distinct eligible direct GitHub collaborator/i,
    "visibility-independent solo eligibility",
  ],
  [
    /regardless of repository visibility/i,
    "repository-visibility-independent review mode",
  ],
  [
    /Formal GitHub review URL \(required for formal mode\)/,
    "the formal GitHub review URL field",
  ],
  [
    /Formal reviewer GitHub identity \(required for formal mode\)/,
    "the formal reviewer identity field",
  ],
  [
    /Solo eligibility evidence URL or repository-status reference \(required for solo mode\)/,
    "the solo eligibility evidence field",
  ],
  [/Implementer agent ID:/, "the implementer agent ID field"],
  [/Reviewer agent ID:/, "the reviewer agent ID field"],
  [/Fresh review of this exact commit range:/, "the fresh-review declaration"],
  [
    /Independent review \(no author self-approval or fabricated evidence\):/,
    "the independent-review declaration",
  ],
  [
    /Commit range reviewed \(base\.\.head; use the exact event base\.sha\.\.head\.sha\):/,
    "the event-matched reviewed commit-range field",
  ],
  [/Findings:/, "the findings field"],
  [/Fix rounds:/, "the fix-rounds field"],
  [/Final verdict: PASS \/ FAIL/, "the final-verdict field"],
  [
    /CI run URL\(s\) \/ PR checks URL\(s\) and required-check results/,
    "the CI or PR checks URL field",
  ],
  [
    /Exactly one review mode is selected/,
    "the exactly-one-mode checklist gate",
  ],
])
  requireGovernanceField(prTemplate, pattern, message);

for (const [pattern, message] of [
  [/formal GitHub Approve/i, "formal GitHub approval priority"],
  [
    /no distinct eligible direct GitHub collaborator/i,
    "the strict solo-fallback eligibility condition",
  ],
  [
    /regardless of repository visibility/i,
    "the visibility-independent solo-fallback condition",
  ],
  [
    /fresh independent subagent reviewer plus success of all required GitHub checks/i,
    "the solo reviewer and CI requirements",
  ],
  [/different from the implementer/i, "reviewer/implementer separation"],
  [/must not self-approve/i, "the no-self-approval rule"],
])
  requireGovernanceField("CONTRIBUTING.md", pattern, message);

for (const [pattern, message] of [
  [
    /collaborators\?affiliation=direct&per_page=100/,
    "the direct-collaborator query",
  ],
  [/page <= 100/, "bounded GitHub API pagination"],
  [/100-page safety cap/, "fail-closed pagination cap"],
  [
    /eligibleCollaborators\(directCollaborators, owner\)/,
    "shared strict collaborator eligibility and owner exclusion",
  ],
  [/eligibleReviewers\.length > 0/, "distinct eligible reviewer detection"],
  [
    /const reviewMode = eligibleReviewers\.length > 0 \? "formal" : "solo";/,
    "conditional formal/solo mode selection",
  ],
  [
    /const requiredPullRequestReviews =\s*reviewMode === "formal" \? formalReviewRequirements : null;/,
    "conditional formal review payload",
  ],
  [
    /required_pull_request_reviews: requiredPullRequestReviews/,
    "the conditional required_pull_request_reviews payload",
  ],
  [/dismiss_stale_reviews:\s*true/, "dismiss_stale_reviews=true"],
  [/require_last_push_approval:\s*true/, "require_last_push_approval=true"],
  [/enforce_admins:\s*true/, "enforce_admins=true"],
  [
    /required_approving_review_count:\s*1/,
    "required_approving_review_count=1 in formal mode",
  ],
  [/Review mode selected: \$\{reviewMode\}/, "the selected review-mode log"],
])
  requireGovernanceField(syncManagement, pattern, message);
const approvalCount = contents
  .get(syncManagement)
  .match(/required_approving_review_count:\s*(\d+)/);
if (!approvalCount || Number(approvalCount[1]) < 1) {
  throw new Error(
    `${syncManagement} governance gate must require at least one approving review`,
  );
}

const repositoryStatus = "docs/github/repository-status.md";
for (const [pattern, message] of [
  [
    /Verified on 2026-09-04/,
    "the current collaborator evidence verification date",
  ],
  [/EthanSMC\/qwen-harness-bridge/, "the repository identity"],
  [
    /GET \/repos\/EthanSMC\/qwen-harness-bridge\/collaborators/,
    "the collaborator API endpoint",
  ],
  [/returned only `EthanSMC`/, "the only-EthanSMC collaborator result"],
  [/PR `#36`/, "the PR #36 reference"],
  [
    /github\.com\/EthanSMC\/qwen-harness-bridge\/pull\/36/,
    "the PR #36 URL reference",
  ],
  [/author=EthanSMC/, "the PR #36 author evidence"],
  [/reviewRequests=\[\]/, "the empty reviewRequests state"],
  [/latestReviews=\[\]/, "the empty latestReviews state"],
  [/reviewDecision=""/, "the empty reviewDecision state"],
  [
    /Re-run the collaborator and PR review-state checks immediately before changing or relying on the selected mode|Any collaborator membership, role, or permission change is a mandatory re-verification trigger/,
    "the collaborator-change re-verification rule",
  ],
  [
    /before relying on the solo fallback/,
    "the pre-fallback re-verification rule",
  ],
  [
    /controller.*GitHub checks API|GitHub checks API.*before merge/i,
    "the controller-side checks API boundary",
  ],
])
  requireGovernanceField(repositoryStatus, pattern, message);

const workflow = ".github/workflows/governance.yml";
for (const [pattern, message] of [
  [/pull_request:[\s\S]*?types:/, "the explicit pull-request event types"],
  [/contents: read/, "contents read permission"],
  [/pull-requests: read/, "pull requests read permission"],
  [/checks: read/, "checks read permission"],
  [/actions: read/, "actions read permission for the current run"],
  [/\n\s*- opened\b/, "the opened pull-request trigger"],
  [/\n\s*- synchronize\b/, "the synchronize pull-request trigger"],
  [/\n\s*- reopened\b/, "the reopened pull-request trigger"],
  [/\n\s*- edited\b/, "the edited pull-request trigger"],
  [
    /node scripts\/github\/verify-pr-review-evidence\.mjs/,
    "the actual pull-request body validator command",
  ],
  [
    /node scripts\/github\/verify-ai-lifecycle\.mjs/,
    "the live PR-to-claim lifecycle validator command",
  ],
  [/node --test/, "the repository governance node:test command"],
  [/ai-issue-policy\.test\.mjs/, "the AI lifecycle policy tests"],
  [/github-api\.test\.mjs/, "the strict GitHub API tests"],
  [/ai-issue-controller\.test\.mjs/, "the lifecycle controller tests"],
  [/ai-lifecycle-registry\.test\.mjs/, "the lifecycle rollout registry tests"],
  [/verify-ai-lifecycle\.test\.mjs/, "the PR-to-claim lifecycle tests"],
  [/verify-pr-review-evidence\.test\.mjs/, "the review evidence tests"],
  [/verify-pr-review-state\.test\.mjs/, "the live review-state tests"],
  [/sync-management\.test\.mjs/, "the management synchronization tests"],
  [/needs: static/, "the final gate dependency on static"],
  [/name: governance/, "the final governance job name"],
  [/if: always\(\)/, "the always-running final gate"],
  [
    /GITHUB_STATIC_RESULT:\s*\$\{\{\s*needs\.static\.result\s*\}\}/,
    "the static result passed to the live validator",
  ],
  [
    /vars\.AI_LIFECYCLE_VALIDATION_MODE\s*\|\|\s*'report'/,
    "report-only validation rollout",
  ],
  [
    /if: github\.event_name == 'pull_request'/,
    "the PR-only live state gate condition",
  ],
])
  requireGovernanceField(workflow, pattern, message);

const lifecycleWorkflow = ".github/workflows/ai-issue-lifecycle.yml";
for (const [pattern, message] of [
  [/issue_comment:/, "the Issue comment trigger"],
  [/pull_request_target:/, "the trusted pull-request target trigger"],
  [/issues:[\s\S]*?opened[\s\S]*?edited/, "new and edited Issue triggers"],
  [/issues:\s*write/, "Issue write permission"],
  [/pull-requests:\s*read/, "pull-request read permission"],
  [/github\.event\.issue\.number/, "per-Issue lifecycle queue"],
  [/cancel-in-progress:\s*false/, "non-cancelling lifecycle queue"],
  [
    /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
    "explicit default-branch checkout",
  ],
  [/persist-credentials:\s*false/, "disabled checkout credentials"],
  [
    /vars\.AI_LIFECYCLE_MUTATION_MODE\s*\|\|\s*'report'/,
    "report-only mutation rollout",
  ],
  [
    /node scripts\/github\/ai-issue-controller\.mjs/,
    "the trusted lifecycle controller command",
  ],
]) {
  requireGovernanceField(lifecycleWorkflow, pattern, message);
}

const lifecycleController = readFileSync(
  resolve(root, "scripts/github/ai-issue-controller.mjs"),
  "utf8",
);
for (const [pattern, message] of [
  [/reconcileLifecycleCommands/, "durable lifecycle command draining"],
  [/Number\(left\.id\) - Number\(right\.id\)/, "immutable comment-ID ordering"],
  [/reconcileRepositoryState/, "scheduled repository state reconciliation"],
  [/MAX_COMMANDS_PER_DRAIN = 1_000/, "bounded command draining"],
  [/stableSystemEventId/, "deterministic system event identities"],
]) {
  requireSourceField(
    lifecycleController,
    "scripts/github/ai-issue-controller.mjs",
    pattern,
    message,
  );
}

for (const [pattern, message] of [
  [
    /Branch protection: enabled/,
    "the explicit enabled branch-protection state",
  ],
  [
    /required status check.*`governance`/i,
    "the required governance status check",
  ],
  [
    /force pushes and branch deletions are disabled/i,
    "force-push and deletion protection",
  ],
])
  requireGovernanceField(repositoryStatus, pattern, message);

const reviewEvidenceScript = readFileSync(
  resolve(root, "scripts/github/verify-pr-review-evidence.mjs"),
  "utf8",
);
const githubApiScript = readFileSync(
  resolve(root, "scripts/github/github-api.mjs"),
  "utf8",
);
for (const [pattern, message] of [
  [/DEFAULT_MAX_PAGES = 100/, "a bounded GitHub pagination default"],
  [/maxPages > 100/, "a hard GitHub pagination safety cap"],
  [/page <= maxPages/, "explicit GitHub API page traversal"],
  [
    /pagination reached.*safety cap without a short page/,
    "fail-closed pagination cap handling",
  ],
]) {
  requireSourceField(
    githubApiScript,
    "scripts/github/github-api.mjs",
    pattern,
    message,
  );
}
for (const [pattern, message] of [
  [
    /needs\.static\.result must be exactly success/,
    "strict success validation for needs.static.result",
  ],
  [
    /\/commits\/\$\{eventPullRequest\.head\.sha\}\/check-runs/,
    "current-head Checks API query",
  ],
  [/status !== "completed"/, "completed check-run validation"],
  [/conclusion !== "success"/, "successful check-run conclusion validation"],
  [/currentPullRequest\.body/, "current PR body authority"],
  [
    /repository visibility is irrelevant to direct-collaborator eligibility/i,
    "visibility-independent direct-collaborator eligibility",
  ],
  [/github\.getAll\(/, "shared paginated GitHub API reads"],
  [/direct collaborator \$\{index \+ 1\}/, "indexed collaborator validation"],
  [/collaborator\.role_name/, "collaborator role validation"],
  [
    /typeof permissions\[permission\] !== "boolean"/,
    "strict collaborator permission validation",
  ],
  [
    /pulls\/\$\{eventPullRequest\.number\}\/reviews/,
    "paginated pull-request review traversal",
  ],
  [
    /const reviewMode = eligible\.length > 0 \? "formal" : "solo";/,
    "collaborator-derived review mode",
  ],
])
  requireSourceField(
    reviewEvidenceScript,
    "scripts/github/verify-pr-review-evidence.mjs",
    pattern,
    message,
  );

console.log(
  `Planning baseline verified: ${files.length} files, ${taskCount} implementation tasks.`,
);
