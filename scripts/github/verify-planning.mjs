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

const files = [spec, ...plans, ...governance];
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

console.log(`Planning baseline verified: ${files.length} files, ${taskCount} implementation tasks.`);

