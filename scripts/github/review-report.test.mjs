import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatReviewReport,
  main,
  parseReviewReport,
  verifyReviewReportComment,
} from "./review-report.mjs";

const report = () => ({
  schema_version: 1,
  repository: "Owner/repo",
  issue_number: 62,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  implementer_id: "codex-implementer",
  reviewer_id: "codex-reviewer",
  reviewer_identity: "independent-reviewer",
  verdict: "PASS",
  findings: [],
  fix_rounds: 1,
  verification: ["Governance tests passed"],
});
const context = () => ({
  repository: "Owner/repo",
  pullRequestNumber: 63,
  issueNumber: 62,
  authorLogin: "Owner",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  implementer: "codex-implementer",
  reviewer: "codex-reviewer",
  reviewerIdentity: "independent-reviewer",
});
const url = "https://github.com/Owner/repo/pull/63#issuecomment-123";
const comment = () => ({
  id: 123,
  html_url: url,
  issue_url: "https://api.github.com/repos/Owner/repo/issues/63",
  user: { login: "Owner", type: "User" },
  created_at: "2026-09-05T01:00:00Z",
  updated_at: "2026-09-05T01:00:00Z",
  body: formatReviewReport(report()),
});
test("canonical report round trips independently of input key order", () => {
  const value = report();
  assert.deepEqual(parseReviewReport(formatReviewReport(value)), value);
  assert.equal(
    formatReviewReport(Object.fromEntries(Object.entries(value).reverse())),
    formatReviewReport(value),
  );
});
test("report rejects unsupported schema, unknown fields, unsafe IDs, private summaries and unresolved blockers", () => {
  for (const patch of [
    { schema_version: 2 },
    { extra: true },
    { reviewer_id: "codex-implementer" },
    { reviewer_id: "https://private.example/thread" },
    { verification: ["token=private"] },
    { verification: ["/Users/private/log"] },
    {
      findings: [
        { severity: "blocker", status: "open", summary: "Broken gate" },
      ],
    },
    { verification: Array(21).fill("passed") },
    { head_sha: "HEAD" },
  ])
    assert.throws(() => formatReviewReport({ ...report(), ...patch }));
});
test("FAIL evidence is representable without fabricating PASS", () => {
  const value = {
    ...report(),
    verdict: "FAIL",
    findings: [{ severity: "blocker", status: "open", summary: "Broken gate" }],
  };
  assert.equal(parseReviewReport(formatReviewReport(value)).verdict, "FAIL");
});
test("rejects digest drift and noncanonical content", () => {
  const body = formatReviewReport(report());
  for (const edited of [
    `${body}\n`,
    body.replace("Governance tests passed", "Tests passed"),
    body.replace('  "schema_version"', ' "schema_version"'),
  ])
    assert.throws(() => parseReviewReport(edited));
});
test("same PR accountable original report verifies", () => {
  assert.equal(
    verifyReviewReportComment({ url, comment: comment(), ...context() })
      .verdict,
    "PASS",
  );
});
test("rejects edited, foreign, unauthored, stale or mismatched evidence", () => {
  for (const patch of [
    { updated_at: "2026-09-05T02:00:00Z" },
    { user: { login: "other", type: "User" } },
    { issue_url: "https://api.github.com/repos/Owner/repo/issues/64" },
    { html_url: url.replace("/63#", "/64#") },
    { id: 124 },
    { created_at: "invalid", updated_at: "invalid" },
  ])
    assert.throws(() =>
      verifyReviewReportComment({
        url,
        comment: { ...comment(), ...patch },
        ...context(),
      }),
    );
  for (const patch of [
    { headSha: "c".repeat(40) },
    { issueNumber: 64 },
    { reviewer: "other" },
    { reviewerIdentity: "other" },
    { repository: "Other/repo" },
  ])
    assert.throws(() =>
      verifyReviewReportComment({
        url,
        comment: comment(),
        ...context(),
        ...patch,
      }),
    );
});

test("formatter CLI preserves supplied facts and rejects oversized input", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-test-"));
  try {
    const input = join(dir, "input.json"),
      output = join(dir, "output.md");
    writeFileSync(input, JSON.stringify(report()));
    main([input, output]);
    assert.deepEqual(parseReviewReport(readFileSync(output, "utf8")), report());
    writeFileSync(input, " ".repeat(16385));
    assert.throws(() => main([input, output]), /bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
