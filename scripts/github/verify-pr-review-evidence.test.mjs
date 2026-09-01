import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, validatePullRequestEvent } from "./verify-pr-review-evidence.mjs";

const eventWithBody = (body, author = "EthanSMC") => ({
  action: "opened",
  pull_request: {
    body,
    user: { login: author },
  },
});

const bodyFor = ({
  mode = "solo",
  formalUrl = "",
  formalIdentity = "",
  soloRef = "docs/github/repository-status.md#review-gate-status",
  soloDate = "2026-09-01",
  implementer = "agent-implementer-37",
  reviewer = "agent-reviewer-37",
  reviewerIdentity = "reviewer-agent-37",
  distinct = "[x] Yes",
  fresh = "[x] Yes",
  independent = "[x] Yes",
  commitRange = "8c4bfcd..HEAD",
  findings = "None",
  fixRounds = "Round 1: addressed all findings",
  verdict = "PASS",
  ciEvidence = "https://github.com/EthanSMC/qwen-harness-bridge/actions/runs/123456789",
} = {}) => [
  "## Review evidence",
  "",
  `- [${mode === "formal" ? "x" : " "}] Formal GitHub review — a distinct eligible GitHub reviewer gave an Approve.`,
  `- [${mode === "solo" ? "x" : " "}] Solo-maintainer fallback — eligibility evidence shows no distinct eligible GitHub reviewer.`,
  "",
  `- Formal GitHub review URL (required for formal mode): ${formalUrl}`,
  `- Formal reviewer GitHub identity (required for formal mode): ${formalIdentity}`,
  `- Solo eligibility evidence URL or repository-status reference (required for solo mode): ${soloRef}`,
  `- Solo eligibility verification date (required for solo mode): ${soloDate}`,
  "",
  `- Implementer agent ID: ${implementer}`,
  `- Reviewer agent ID: ${reviewer}`,
  `- Reviewer identity (agent/account): ${reviewerIdentity}`,
  `- Reviewer is distinct from implementer: ${distinct}`,
  `- Fresh review of this exact commit range: ${fresh}`,
  `- Independent review (no author self-approval or fabricated evidence): ${independent}`,
  "",
  `- Commit range reviewed (base..head): ${commitRange}`,
  `- Findings: ${findings}`,
  `- Fix rounds: ${fixRounds}`,
  `- Final verdict: ${verdict}`,
  `- CI run URL(s) / PR checks URL(s) and required-check results: ${ciEvidence}`,
].join("\n");

test("accepts a complete solo-maintainer review body from the PR event", () => {
  const result = validatePullRequestEvent(eventWithBody(bodyFor()));

  assert.equal(result.mode, "solo");
});

test("accepts a complete formal review body with a distinct GitHub reviewer", () => {
  const result = validatePullRequestEvent(eventWithBody(bodyFor({
    mode: "formal",
    formalUrl: "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
    formalIdentity: "eligible-reviewer",
    soloRef: "",
    soloDate: "",
    reviewerIdentity: "eligible-reviewer",
  })));

  assert.equal(result.mode, "formal");
});

test("main parses pull_request.body from the GitHub event file", () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-review-evidence-"));
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, JSON.stringify(eventWithBody(bodyFor())));

  try {
    assert.equal(main(eventPath).mode, "solo");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a PR body that selects both review modes", () => {
  const body = bodyFor({ mode: "solo" }).replace(
    "- [ ] Formal GitHub review",
    "- [x] Formal GitHub review",
  );

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /exactly one review mode/i,
  );
});

test("rejects formal evidence in a solo-mode body", () => {
  const body = bodyFor({ formalUrl: "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /solo mode must not include formal review evidence/i,
  );
});

test("rejects a solo review with an empty reviewer agent ID", () => {
  const body = bodyFor({ reviewer: "" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /Reviewer agent ID requires a non-empty/i,
  );
});

test("rejects a solo review with empty eligibility evidence", () => {
  const body = bodyFor({ soloRef: "" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /Solo eligibility evidence.*requires a non-empty/i,
  );
});

test("rejects a solo review when implementer and reviewer agent IDs match", () => {
  const body = bodyFor({ reviewer: "agent-implementer-37" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /different agent IDs/i,
  );
});

test("rejects a solo review without fresh independent Yes declarations", () => {
  const body = bodyFor({ fresh: "[ ] Yes", independent: "[ ] Yes" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /Fresh review.*checked.*Yes/i,
  );
});

test("rejects a solo review whose final verdict is not PASS", () => {
  const body = bodyFor({ verdict: "FAIL" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /final verdict must be PASS/i,
  );
});

test("rejects formal self-approval by comparing reviewer identity with PR author", () => {
  const body = bodyFor({
    mode: "formal",
    formalUrl: "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
    formalIdentity: "EthanSMC",
    soloRef: "",
    soloDate: "",
    reviewerIdentity: "EthanSMC",
  });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body, "EthanSMC")),
    /self-approve|different from the PR author/i,
  );
});

test("rejects a formal review with a placeholder reviewer identity", () => {
  const body = bodyFor({
    mode: "formal",
    formalUrl: "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
    formalIdentity: "N/A",
    soloRef: "",
    soloDate: "",
    reviewerIdentity: "eligible-reviewer",
  });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /formal reviewer.*concrete identity/i,
  );
});

test("rejects a solo review whose reviewer identity is the PR author", () => {
  const body = bodyFor({ reviewerIdentity: "EthanSMC" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body, "EthanSMC")),
    /self-approve|different from the PR author/i,
  );
});

test("rejects empty CI evidence", () => {
  const body = bodyFor({ ciEvidence: "" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /CI.*requires a non-empty/i,
  );
});

test("rejects non-GitHub CI evidence URLs", () => {
  const body = bodyFor({ ciEvidence: "https://example.com/run/123" });

  assert.throws(
    () => validatePullRequestEvent(eventWithBody(body)),
    /CI.*GitHub.*URL/i,
  );
});

test("accepts a PR checks URL as CI evidence", () => {
  const body = bodyFor({
    ciEvidence: "https://github.com/EthanSMC/qwen-harness-bridge/pull/37/checks",
  });

  assert.equal(validatePullRequestEvent(eventWithBody(body)).mode, "solo");
});
