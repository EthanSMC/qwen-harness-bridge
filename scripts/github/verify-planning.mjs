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
  ".github/pull_request_template.md",
  ".github/labels.yml",
  ".github/milestones.yml",
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

const prTemplate = ".github/pull_request_template.md";
for (const [pattern, message] of [
  [/Do not check both boxes/, "the prohibition on selecting both review modes"],
  [/Review mode \(check exactly one\)/, "an explicit mutually-exclusive review mode selector"],
  [/Formal GitHub review/, "the formal GitHub review mode"],
  [/Solo-maintainer fallback/, "the solo-maintainer fallback mode"],
  [/Formal review URL \(required for formal mode\)/, "the formal review URL field"],
  [/Formal reviewer GitHub identity \(required for formal mode\)/, "the formal reviewer identity field"],
  [/Solo eligibility evidence URL or repository-status reference \(required for solo mode\)/, "the solo eligibility evidence field"],
  [/Implementer agent ID:/, "the implementer agent ID field"],
  [/Reviewer agent ID:/, "the reviewer agent ID field"],
  [/Fresh review of this exact commit range:/, "the fresh-review declaration"],
  [/Independent review \(no author self-approval or fabricated evidence\):/, "the independent-review declaration"],
  [/Commit range reviewed \(base\.\.head\):/, "the reviewed commit-range field"],
  [/Findings:/, "the findings field"],
  [/Fix rounds:/, "the fix-rounds field"],
  [/Final verdict: PASS \/ FAIL/, "the final-verdict field"],
  [/CI run URL\(s\) and required-check results:/, "the CI run URL field"],
  [/Exactly one review mode is selected/, "the exactly-one-mode checklist gate"],
]) requireGovernanceField(prTemplate, pattern, message);

for (const [pattern, message] of [
  [/formal GitHub Approve/i, "formal GitHub approval priority"],
  [/private single-maintainer repository with no second eligible GitHub account/i, "the strict solo-fallback eligibility condition"],
  [/fresh independent subagent reviewer plus success of all required GitHub checks/i, "the solo reviewer and CI requirements"],
  [/different from the implementer/i, "reviewer/implementer separation"],
  [/must not self-approve/i, "the no-self-approval rule"],
]) requireGovernanceField("CONTRIBUTING.md", pattern, message);

for (const [pattern, message] of [
  [/required_pull_request_reviews:\s*\{/, "a non-null required_pull_request_reviews object"],
  [/dismiss_stale_reviews:\s*true/, "dismiss_stale_reviews=true"],
  [/require_last_push_approval:\s*true/, "require_last_push_approval=true"],
  [/enforce_admins:\s*true/, "enforce_admins=true"],
]) requireGovernanceField(syncManagement, pattern, message);
if (/required_pull_request_reviews:\s*null/.test(contents.get(syncManagement))) {
  throw new Error(`${syncManagement} governance gate must not set required_pull_request_reviews to null`);
}
const approvalCount = contents.get(syncManagement).match(/required_approving_review_count:\s*(\d+)/);
if (!approvalCount || Number(approvalCount[1]) < 1) {
  throw new Error(`${syncManagement} governance gate must require at least one approving review`);
}

console.log(`Planning baseline verified: ${files.length} files, ${taskCount} implementation tasks.`);
