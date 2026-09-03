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
  ".github/workflows/governance.yml",
  ".github/pull_request_template.md",
  ".github/labels.yml",
  ".github/milestones.yml",
  "docs/github/repository-status.md",
];
const syncManagement = "scripts/github/sync-management.mjs";

const files = [spec, ...plans, ...governance, syncManagement];
const contents = new Map(files.map((file) => [file, readFileSync(resolve(root, file), "utf8")]));
const forbidden = /\b(?:TODO|TBD|FIXME|XXX)\b|implement later|fill in|QH-XXXX/i;
for (const [file, content] of contents) {
  if (forbidden.test(content)) throw new Error(`${file} contains an unresolved planning marker`);
}

const taskCount = plans.reduce((count, file) => {
  return count + [...contents.get(file).matchAll(/^## Task \d+:/gm)].length;
}, 0);
if (taskCount !== 34) throw new Error(`expected 34 implementation tasks, found ${taskCount}`);

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
  if (!allPlans.includes(term)) throw new Error(`planning baseline is missing required contract: ${term}`);
}

const requireGovernanceField = (file, pattern, message) => {
  if (!pattern.test(contents.get(file))) throw new Error(`${file} governance gate is missing ${message}`);
};

const requireSourceField = (source, file, pattern, message) => {
  if (!pattern.test(source)) throw new Error(`${file} governance gate is missing ${message}`);
};

const prTemplate = ".github/pull_request_template.md";
for (const [pattern, message] of [
  [/Do not check both boxes/, "the prohibition on selecting both review modes"],
  [/Review mode \(check exactly one\)/, "an explicit mutually-exclusive review mode selector"],
  [/Formal GitHub review/, "the formal GitHub review mode"],
  [/Solo-maintainer fallback/, "the solo-maintainer fallback mode"],
  [/no distinct eligible direct GitHub collaborator/i, "visibility-independent solo eligibility"],
  [/regardless of repository visibility/i, "repository-visibility-independent review mode"],
  [/Formal GitHub review URL \(required for formal mode\)/, "the formal GitHub review URL field"],
  [/Formal reviewer GitHub identity \(required for formal mode\)/, "the formal reviewer identity field"],
  [/Solo eligibility evidence URL or repository-status reference \(required for solo mode\)/, "the solo eligibility evidence field"],
  [/Implementer agent ID:/, "the implementer agent ID field"],
  [/Reviewer agent ID:/, "the reviewer agent ID field"],
  [/Fresh review of this exact commit range:/, "the fresh-review declaration"],
  [/Independent review \(no author self-approval or fabricated evidence\):/, "the independent-review declaration"],
  [/Commit range reviewed \(base\.\.head; use the exact event base\.sha\.\.head\.sha\):/, "the event-matched reviewed commit-range field"],
  [/Findings:/, "the findings field"],
  [/Fix rounds:/, "the fix-rounds field"],
  [/Final verdict: PASS \/ FAIL/, "the final-verdict field"],
  [/CI run URL\(s\) \/ PR checks URL\(s\) and required-check results/, "the CI or PR checks URL field"],
  [/Exactly one review mode is selected/, "the exactly-one-mode checklist gate"],
]) requireGovernanceField(prTemplate, pattern, message);

for (const [pattern, message] of [
  [/formal GitHub Approve/i, "formal GitHub approval priority"],
  [/no distinct eligible direct GitHub collaborator/i, "the strict solo-fallback eligibility condition"],
  [/regardless of repository visibility/i, "the visibility-independent solo-fallback condition"],
  [/fresh independent subagent reviewer plus success of all required GitHub checks/i, "the solo reviewer and CI requirements"],
  [/different from the implementer/i, "reviewer/implementer separation"],
  [/must not self-approve/i, "the no-self-approval rule"],
]) requireGovernanceField("CONTRIBUTING.md", pattern, message);

for (const [pattern, message] of [
  [/collaborators\?affiliation=direct&per_page=100/, "the direct-collaborator query"],
  [/role_name/, "collaborator role eligibility"],
  [/permissions\.(?:admin|maintain|push)/, "collaborator permission eligibility"],
  [/login\.toLowerCase\(\) !== ownerLogin/, "exclusion of the repository owner"],
  [/eligibleReviewers\.length > 0/, "distinct eligible reviewer detection"],
  [/const reviewMode = eligibleReviewers\.length > 0 \? "formal" : "solo";/, "conditional formal/solo mode selection"],
  [/const requiredPullRequestReviews = reviewMode === "formal" \? formalReviewRequirements : null;/, "conditional formal review payload"],
  [/required_pull_request_reviews: requiredPullRequestReviews/, "the conditional required_pull_request_reviews payload"],
  [/dismiss_stale_reviews:\s*true/, "dismiss_stale_reviews=true"],
  [/require_last_push_approval:\s*true/, "require_last_push_approval=true"],
  [/enforce_admins:\s*true/, "enforce_admins=true"],
  [/required_approving_review_count:\s*1/, "required_approving_review_count=1 in formal mode"],
  [/Review mode selected: \$\{reviewMode\}/, "the selected review-mode log"],
]) requireGovernanceField(syncManagement, pattern, message);
const approvalCount = contents.get(syncManagement).match(/required_approving_review_count:\s*(\d+)/);
if (!approvalCount || Number(approvalCount[1]) < 1) {
  throw new Error(`${syncManagement} governance gate must require at least one approving review`);
}

const repositoryStatus = "docs/github/repository-status.md";
for (const [pattern, message] of [
  [/Verified on 2026-09-01/, "the collaborator evidence verification date"],
  [/EthanSMC\/qwen-harness-bridge/, "the repository identity"],
  [/GET \/repos\/EthanSMC\/qwen-harness-bridge\/collaborators/, "the collaborator API endpoint"],
  [/returned only `EthanSMC`/, "the only-EthanSMC collaborator result"],
  [/PR `#36`/, "the PR #36 reference"],
  [/github\.com\/EthanSMC\/qwen-harness-bridge\/pull\/36/, "the PR #36 URL reference"],
  [/author=EthanSMC/, "the PR #36 author evidence"],
  [/reviewRequests=\[\]/, "the empty reviewRequests state"],
  [/latestReviews=\[\]/, "the empty latestReviews state"],
  [/reviewDecision=""/, "the empty reviewDecision state"],
  [/Re-run the collaborator and PR review-state checks immediately before changing or relying on the selected mode|Any collaborator membership, role, or permission change is a mandatory re-verification trigger/, "the collaborator-change re-verification rule"],
  [/before relying on the solo fallback/, "the pre-fallback re-verification rule"],
  [/controller.*GitHub checks API|GitHub checks API.*before merge/i, "the controller-side checks API boundary"],
]) requireGovernanceField(repositoryStatus, pattern, message);

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
  [/node scripts\/github\/verify-pr-review-evidence\.mjs/, "the actual pull-request body validator command"],
  [/node --test scripts\/github\/verify-pr-review-evidence\.test\.mjs scripts\/github\/verify-pr-review-state\.test\.mjs/, "the review evidence node:test commands"],
  [/needs: static/, "the final gate dependency on static"],
  [/name: governance/, "the final governance job name"],
  [/if: always\(\)/, "the always-running final gate"],
  [/GITHUB_STATIC_RESULT:\s*\$\{\{\s*needs\.static\.result\s*\}\}/, "the static result passed to the live validator"],
  [/if: github\.event_name == 'pull_request'/, "the PR-only live state gate condition"],
]) requireGovernanceField(workflow, pattern, message);

for (const [pattern, message] of [
  [/branch protection is not enabled/, "the explicit disabled branch-protection state"],
  [/review paths above are documented process controls only/, "the documented-process-only review-path boundary"],
  [/must not be represented as enabled/, "the prohibition on claiming branch protection is enabled"],
]) requireGovernanceField(repositoryStatus, pattern, message);

const reviewEvidenceScript = readFileSync(resolve(root, "scripts/github/verify-pr-review-evidence.mjs"), "utf8");
for (const [pattern, message] of [
  [/needs\.static\.result must be exactly success/, "strict success validation for needs.static.result"],
  [/\/commits\/\$\{eventPullRequest\.head\.sha\}\/check-runs/, "current-head Checks API query"],
  [/status !== "completed"/, "completed check-run validation"],
  [/conclusion !== "success"/, "successful check-run conclusion validation"],
  [/currentPullRequest\.body/, "current PR body authority"],
  [/repository visibility is irrelevant to direct-collaborator eligibility/i, "visibility-independent direct-collaborator eligibility"],
  [/const reviewMode = eligible\.length > 0 \? "formal" : "solo";/, "collaborator-derived review mode"],
]) requireSourceField(reviewEvidenceScript, "scripts/github/verify-pr-review-evidence.mjs", pattern, message);

console.log(`Planning baseline verified: ${files.length} files, ${taskCount} implementation tasks.`);
