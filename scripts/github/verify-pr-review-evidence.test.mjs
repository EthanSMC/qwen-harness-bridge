import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  validatePullRequestBody,
  validatePullRequestEvent,
} from "./verify-pr-review-evidence.mjs";

const pullRequestTemplate = resolve(
  import.meta.dirname,
  "../../.github/pull_request_template.md",
);

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
} = {}) =>
  [
    `- Independent review report URL (required for solo mode): ${mode === "solo" ? "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#issuecomment-123" : ""}`,
    "## Review evidence",
    "",
    `- [${mode === "formal" ? "x" : " "}] Formal GitHub review — a distinct eligible direct GitHub collaborator gave an Approve.`,
    `- [${mode === "solo" ? "x" : " "}] Solo-maintainer fallback — eligibility evidence shows no distinct eligible direct GitHub collaborator, regardless of repository visibility.`,
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
    `- Commit range reviewed (base..head; use the exact event base.sha..head.sha): ${commitRange}`,
    `- Findings: ${findings}`,
    `- Fix rounds: ${fixRounds}`,
    `- Final verdict: ${verdict}`,
    `- CI run URL(s) / PR checks URL(s) and required-check results: ${ciEvidence}`,
  ].join("\n");

const completedSoloTemplate = () => {
  const lines = readFileSync(pullRequestTemplate, "utf8").split(/\r?\n/);
  const soloMode = lines.findIndex((line) =>
    line.startsWith("- [ ] Solo-maintainer fallback"),
  );
  assert.notEqual(soloMode, -1, "real template must contain solo mode");
  lines[soloMode] = lines[soloMode].replace("- [ ]", "- [x]");

  const fieldValues = [
    [
      "Independent review report URL (required for solo mode)",
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/42#issuecomment-123",
    ],
    [
      "Solo eligibility evidence URL or repository-status reference (required for solo mode)",
      "docs/github/repository-status.md#review-gate-status",
    ],
    [
      "Solo eligibility verification date (required for solo mode)",
      "2026-09-03",
    ],
    ["Implementer agent ID", "agent-implementer-42"],
    ["Reviewer agent ID", "agent-reviewer-42"],
    ["Reviewer identity (agent/account)", "reviewer-agent-42"],
    ["Reviewer is distinct from implementer", "[x] Yes"],
    ["Fresh review of this exact commit range", "[x] Yes"],
    [
      "Independent review (no author self-approval or fabricated evidence)",
      "[x] Yes",
    ],
    [
      "Commit range reviewed (base..head; use the exact event base.sha..head.sha)",
      "4c2c414..bca3fe6",
    ],
    ["Findings", "None"],
    ["Fix rounds", "Round 1: corrected template label drift"],
    ["Final verdict", "PASS"],
    [
      "CI run URL(s) / PR checks URL(s) and required-check results",
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/42/checks",
    ],
  ];

  for (const [label, value] of fieldValues) {
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith(`- ${label}`));
    assert.equal(
      matches.length,
      1,
      `${label} must occur once in real template`,
    );
    const { line, index } = matches[0];
    const colon = line.lastIndexOf(":");
    assert.notEqual(colon, -1, `${label} must end in a value delimiter`);
    lines[index] = `${line.slice(0, colon + 1)} ${value}`;
  }

  return lines.join("\n");
};

test("parses every required field from the completed real pull-request template", () => {
  const result = validatePullRequestBody(completedSoloTemplate(), {
    authorLogin: "EthanSMC",
  });

  assert.deepEqual(result, {
    mode: "solo",
    fields: {
      reportUrl:
        "https://github.com/EthanSMC/qwen-harness-bridge/pull/42#issuecomment-123",
      formalUrl: "",
      formalIdentity: "",
      soloRef: "docs/github/repository-status.md#review-gate-status",
      soloDate: "2026-09-03",
      implementer: "agent-implementer-42",
      reviewer: "agent-reviewer-42",
      reviewerIdentity: "reviewer-agent-42",
      distinct: "[x] Yes",
      fresh: "[x] Yes",
      independent: "[x] Yes",
      commitRange: "4c2c414..bca3fe6",
      findings: "None",
      fixRounds: "Round 1: corrected template label drift",
      verdict: "PASS",
      ciEvidence:
        "https://github.com/EthanSMC/qwen-harness-bridge/pull/42/checks",
    },
  });
});

test("accepts a complete solo-maintainer review body from the PR event", () => {
  const result = validatePullRequestEvent(eventWithBody(bodyFor()));

  assert.equal(result.mode, "solo");
});

test("accepts a complete formal review body with a distinct GitHub reviewer", () => {
  const result = validatePullRequestEvent(
    eventWithBody(
      bodyFor({
        mode: "formal",
        formalUrl:
          "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
        formalIdentity: "eligible-reviewer",
        soloRef: "",
        soloDate: "",
        reviewerIdentity: "eligible-reviewer",
      }),
    ),
  );

  assert.equal(result.mode, "formal");
});

test("parses pull_request.body from the GitHub event", () => {
  assert.equal(validatePullRequestEvent(eventWithBody(bodyFor())).mode, "solo");
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
  const body = bodyFor({
    formalUrl:
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
  });

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
    formalUrl:
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
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
    formalUrl:
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/37#pullrequestreview-123456789",
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
    ciEvidence:
      "https://github.com/EthanSMC/qwen-harness-bridge/pull/37/checks",
  });

  assert.equal(validatePullRequestEvent(eventWithBody(body)).mode, "solo");
});

test("solo report URL is required exactly once and must identify a PR comment", () => {
  const body = bodyFor();
  const label = "- Independent review report URL (required for solo mode):";
  for (const value of [
    body
      .split("\n")
      .filter((line) => !line.startsWith(label))
      .join("\n"),
    body.replace(/#issuecomment-123/, ""),
    `${body}\n${label} https://github.com/Owner/repo/pull/37#issuecomment-1`,
  ])
    assert.throws(() => validatePullRequestBody(value));
});
