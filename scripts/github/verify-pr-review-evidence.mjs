import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIELD_LABELS = {
  formalUrl: "Formal GitHub review URL (required for formal mode)",
  formalIdentity: "Formal reviewer GitHub identity (required for formal mode)",
  soloRef: "Solo eligibility evidence URL or repository-status reference (required for solo mode)",
  soloDate: "Solo eligibility verification date (required for solo mode)",
  implementer: "Implementer agent ID",
  reviewer: "Reviewer agent ID",
  reviewerIdentity: "Reviewer identity (agent/account)",
  distinct: "Reviewer is distinct from implementer",
  fresh: "Fresh review of this exact commit range",
  independent: "Independent review (no author self-approval or fabricated evidence)",
  commitRange: "Commit range reviewed (base..head)",
  findings: "Findings",
  fixRounds: "Fix rounds",
  verdict: "Final verdict",
  ciEvidence: "CI run URL(s) / PR checks URL(s) and required-check results",
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const linesOf = (body) => body.split(/\r?\n/);

const fieldValue = (body, label) => {
  const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(label)}:\\s*(.*?)\\s*$`);
  const matches = linesOf(body).map((line) => line.match(pattern)).filter(Boolean);
  if (matches.length !== 1) throw new Error(`${label} is required exactly once`);
  return matches[0][1].trim();
};

const requiredValue = (value, label) => {
  if (!value || /^(?:<[^>]+>|tbd|todo|fill in)$/i.test(value)) {
    throw new Error(`${label} requires a non-empty completed value`);
  }
  return value;
};

const normalizedIdentity = (value) => value.trim().replace(/^@/, "").toLowerCase();

const requiredIdentity = (value, label) => {
  requiredValue(value, label);
  if (/^(?:n\/a|none|unknown)$/i.test(value)) {
    throw new Error(`${label} requires a concrete identity`);
  }
  return value;
};

const checkboxAnswer = (body, label) => {
  const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(label)}:\\s*\\[([ xX])\\]\\s*(Yes|No)\\s*$`, "i");
  const matches = linesOf(body).map((line) => line.match(pattern)).filter(Boolean);
  if (matches.length !== 1) throw new Error(`${label} must be answered with [x] Yes or [x] No`);
  if (matches[0][1].toLowerCase() !== "x" || matches[0][2].toLowerCase() !== "yes") {
    throw new Error(`${label} must be checked [x] Yes`);
  }
};

const selectedReviewMode = (body) => {
  const lines = linesOf(body);
  const formal = lines.filter((line) => /^\s*-\s*\[([ xX])\]\s+Formal GitHub review\b/i.test(line));
  const solo = lines.filter((line) => /^\s*-\s*\[([ xX])\]\s+Solo-maintainer fallback\b/i.test(line));
  if (formal.length !== 1 || solo.length !== 1) {
    throw new Error("exactly one review mode must be present: formal or solo");
  }
  const formalChecked = /^\s*-\s*\[x\]/i.test(formal[0]);
  const soloChecked = /^\s*-\s*\[x\]/i.test(solo[0]);
  if (formalChecked === soloChecked) {
    throw new Error("exactly one review mode must be checked; do not select both modes");
  }
  return formalChecked ? "formal" : "solo";
};

const githubUrl = (value, label) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid GitHub URL`);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error(`${label} must use an https://github.com URL`);
  }
  return url;
};

const validateFormalReviewUrl = (value) => {
  const url = githubUrl(value, "Formal GitHub review URL");
  const webReview = /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)
    && /^#pullrequestreview-\d+$/.test(url.hash);
  const apiReview = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/\d+$/.test(url.pathname);
  if (!webReview && !apiReview) {
    throw new Error("Formal GitHub review URL must point to a specific GitHub review");
  }
};

const firstGitHubUrl = (value, label) => {
  const match = value.match(/https:\/\/github\.com\/[^\s)>,]+/i);
  if (!match) throw new Error(`${label} must include a GitHub CI/check evidence URL`);
  return match[0].replace(/[.,;]+$/, "");
};

const validateCiEvidence = (value) => {
  const url = githubUrl(firstGitHubUrl(value, "CI evidence"), "CI evidence");
  const actionsRun = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(url.pathname);
  const pullChecks = /^\/[^/]+\/[^/]+\/pull\/\d+\/checks$/.test(url.pathname);
  if (!actionsRun && !pullChecks) {
    throw new Error("CI evidence must be a GitHub Actions run URL or PR checks URL");
  }
};

const requiredCommonEvidence = (body, { authorLogin } = {}) => {
  const fields = Object.fromEntries(Object.entries(FIELD_LABELS).map(([key, label]) => [key, fieldValue(body, label)]));
  for (const key of ["commitRange", "findings", "fixRounds", "verdict", "ciEvidence"]) {
    requiredValue(fields[key], FIELD_LABELS[key]);
  }
  for (const key of ["implementer", "reviewer", "reviewerIdentity"]) requiredIdentity(fields[key], FIELD_LABELS[key]);
  if (fields.implementer.toLowerCase() === fields.reviewer.toLowerCase()) {
    throw new Error("implementer and reviewer must use different agent IDs");
  }
  if (authorLogin && normalizedIdentity(fields.reviewerIdentity) === normalizedIdentity(authorLogin)) {
    throw new Error("Reviewer identity must be different from the PR author; self-approve is forbidden");
  }
  for (const key of ["distinct", "fresh", "independent"]) checkboxAnswer(body, FIELD_LABELS[key]);
  if (fields.verdict.toUpperCase() !== "PASS") throw new Error("Final verdict must be PASS");
  if (/^base\.\.head$/i.test(fields.commitRange)) {
    throw new Error("Commit range reviewed (base..head) requires the actual base..head range");
  }
  validateCiEvidence(fields.ciEvidence);
  return fields;
};

export function validatePullRequestBody(body, { authorLogin } = {}) {
  if (typeof body !== "string" || !body.trim()) throw new Error("pull_request.body is required");
  const mode = selectedReviewMode(body);
  const fields = requiredCommonEvidence(body, { authorLogin });
  const formalUrl = fields.formalUrl;
  const formalIdentity = fields.formalIdentity;
  const soloRef = fields.soloRef;
  const soloDate = fields.soloDate;

  if (mode === "formal") {
    requiredValue(formalUrl, FIELD_LABELS.formalUrl);
    requiredIdentity(formalIdentity, FIELD_LABELS.formalIdentity);
    validateFormalReviewUrl(formalUrl);
    if (authorLogin && normalizedIdentity(formalIdentity) === normalizedIdentity(authorLogin)) {
      throw new Error("Formal reviewer identity must be different from the PR author; self-approve is forbidden");
    }
    if (soloRef || soloDate) throw new Error("formal mode must not include solo eligibility evidence");
  } else {
    requiredValue(soloRef, FIELD_LABELS.soloRef);
    requiredValue(soloDate, FIELD_LABELS.soloDate);
    if (!/(repository-status(?:\.md)?|collaborator|repos\/[^/]+\/[^/]+\/collaborators)/i.test(soloRef)) {
      throw new Error("Solo eligibility evidence must reference repository-status or collaborator evidence");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(soloDate)) {
      throw new Error("Solo eligibility verification date must use YYYY-MM-DD");
    }
    if (formalUrl || formalIdentity) throw new Error("solo mode must not include formal review evidence");
  }

  return { mode, fields };
}

export function validatePullRequestEvent(event) {
  if (!event || !event.pull_request) throw new Error("GitHub event must contain pull_request");
  const authorLogin = event.pull_request.user?.login || event.pull_request.author?.login;
  requiredValue(authorLogin, "pull_request.user.login");
  return validatePullRequestBody(event.pull_request.body, { authorLogin });
}

export function main(eventPath = process.env.GITHUB_EVENT_PATH) {
  requiredValue(eventPath, "GITHUB_EVENT_PATH");
  let event;
  try {
    event = JSON.parse(readFileSync(resolve(eventPath), "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse GITHUB_EVENT_PATH: ${error.message}`);
  }
  const result = validatePullRequestEvent(event);
  console.log(`Review evidence verified: ${result.mode} mode; pull_request.body is structurally complete.`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Review evidence validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
