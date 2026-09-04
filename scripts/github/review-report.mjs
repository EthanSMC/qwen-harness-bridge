import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safePublicText } from "./ai-issue-policy.mjs";

export const MAX_REPORT_BYTES = 16_384;
const keys = [
  "schema_version",
  "repository",
  "issue_number",
  "base_sha",
  "head_sha",
  "implementer_id",
  "reviewer_id",
  "reviewer_identity",
  "verdict",
  "findings",
  "fix_rounds",
  "verification",
];
const exactKeys = (value, expected) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  )
    throw new Error("Review report has missing or unknown fields");
};
const positive = (value) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Review report requires positive numeric references");
  return value;
};
const identity = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/i.test(value) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
  )
    throw new Error("Review report requires safe public identity slugs");
};
const summary = (value) => {
  if (safePublicText(value, 240) !== value || /[`\r\n]/.test(value))
    throw new Error("Review report requires canonical single-line summaries");
};
const validate = (report) => {
  exactKeys(report, keys);
  if (report.schema_version !== 1)
    throw new Error("Unsupported review report schema_version");
  if (
    typeof report.repository !== "string" ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(report.repository)
  )
    throw new Error("Invalid report repository");
  positive(report.issue_number);
  for (const key of ["base_sha", "head_sha"])
    if (!/^[0-9a-f]{40}$/.test(report[key]))
      throw new Error("Review report requires exact lowercase commit SHAs");
  for (const key of ["implementer_id", "reviewer_id", "reviewer_identity"])
    identity(report[key]);
  if (report.implementer_id.toLowerCase() === report.reviewer_id.toLowerCase())
    throw new Error("Review report identities must be distinct");
  if (!["PASS", "FAIL"].includes(report.verdict))
    throw new Error("Review report verdict must be PASS or FAIL");
  if (
    !Number.isSafeInteger(report.fix_rounds) ||
    report.fix_rounds < 0 ||
    report.fix_rounds > 100
  )
    throw new Error("Invalid review fix_rounds");
  if (!Array.isArray(report.findings) || report.findings.length > 20)
    throw new Error("Review report findings exceed bounds");
  for (const finding of report.findings) {
    exactKeys(finding, ["severity", "status", "summary"]);
    if (
      !["blocker", "non-blocker"].includes(finding.severity) ||
      !["open", "resolved"].includes(finding.status)
    )
      throw new Error("Invalid finding severity/status");
    summary(finding.summary);
    if (
      report.verdict === "PASS" &&
      finding.severity === "blocker" &&
      finding.status === "open"
    )
      throw new Error("PASS report has unresolved blockers");
  }
  if (
    !Array.isArray(report.verification) ||
    report.verification.length < 1 ||
    report.verification.length > 20
  )
    throw new Error("Review verification summaries exceed bounds");
  report.verification.forEach(summary);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      key === "findings"
        ? report.findings.map((f) => ({
            severity: f.severity,
            status: f.status,
            summary: f.summary,
          }))
        : report[key],
    ]),
  );
};
const digest = (json) => createHash("sha256").update(json).digest("hex");
export const formatReviewReport = (report) => {
  const json = JSON.stringify(validate(report), null, 2);
  const body = `<!-- qhb-independent-review:v1 sha256:${digest(json)} -->\n\`\`\`json\n${json}\n\`\`\``;
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES)
    throw new Error("Review report exceeds byte bound");
  return body;
};
export const parseReviewReport = (body) => {
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_REPORT_BYTES)
    throw new Error("Review report exceeds byte bound");
  const match =
    /^<!-- qhb-independent-review:v1 sha256:([a-f0-9]{64}) -->\n```json\n([\s\S]+)\n```$/.exec(
      body,
    );
  if (!match) throw new Error("Invalid canonical review report comment");
  let report;
  try {
    report = JSON.parse(match[2]);
  } catch {
    throw new Error("Invalid review report JSON");
  }
  if (digest(match[2]) !== match[1] || formatReviewReport(report) !== body)
    throw new Error("Review report digest or canonical content mismatch");
  return report;
};
export const reviewCommentId = (url, repository, pullRequestNumber) => {
  const expected = `https://github.com/${repository}/pull/${positive(pullRequestNumber)}#issuecomment-`;
  if (
    typeof url !== "string" ||
    !url.startsWith(expected) ||
    !/^[1-9][0-9]*$/.test(url.slice(expected.length))
  )
    throw new Error(
      "Independent review report URL must identify one comment on this same PR",
    );
  return positive(Number(url.slice(expected.length)));
};
export const verifyReviewReportComment = ({
  url,
  comment,
  repository,
  pullRequestNumber,
  issueNumber,
  authorLogin,
  baseSha,
  headSha,
  implementer,
  reviewer,
  reviewerIdentity,
}) => {
  const id = reviewCommentId(url, repository, pullRequestNumber);
  if (
    comment?.id !== id ||
    comment.html_url !== url ||
    comment.issue_url !==
      `https://api.github.com/repos/${repository}/issues/${pullRequestNumber}`
  )
    throw new Error("Review comment repository/PR association mismatch");
  if (
    comment.user?.type !== "User" ||
    comment.user?.login?.toLowerCase() !== authorLogin.toLowerCase()
  )
    throw new Error("Review comment must be posted by accountable PR author");
  if (
    typeof comment.created_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(comment.created_at) ||
    !Number.isFinite(Date.parse(comment.created_at)) ||
    new Date(comment.created_at).toISOString() !==
      comment.created_at.replace("Z", ".000Z") ||
    comment.updated_at !== comment.created_at
  )
    throw new Error("Review comment must have valid unedited timestamps");
  const report = parseReviewReport(comment.body);
  const expected = {
    repository,
    issue_number: issueNumber,
    base_sha: baseSha,
    head_sha: headSha,
    implementer_id: implementer,
    reviewer_id: reviewer,
    reviewer_identity: reviewerIdentity,
    verdict: "PASS",
  };
  for (const [key, value] of Object.entries(expected))
    if (report[key] !== value) throw new Error(`Review report ${key} mismatch`);
  return report;
};
export const main = (args = process.argv.slice(2)) => {
  if (args.length !== 2)
    throw new Error(
      "Usage: node scripts/github/review-report.mjs INPUT.json OUTPUT.md",
    );
  if (statSync(args[0]).size > MAX_REPORT_BYTES)
    throw new Error("Review report input exceeds byte bound");
  let report;
  try {
    report = JSON.parse(readFileSync(args[0], "utf8"));
  } catch {
    throw new Error("Invalid local review report JSON");
  }
  writeFileSync(args[1], formatReviewReport(report));
};
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error(
      "Review report formatting failed; check input schema, bounds and safe public summaries.",
    );
    process.exitCode = 1;
  }
}
