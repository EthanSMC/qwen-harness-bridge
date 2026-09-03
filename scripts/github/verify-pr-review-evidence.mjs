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
  commitRange: "Commit range reviewed (base..head; use the exact event base.sha..head.sha)",
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

const normalizeRepository = (value) => value.trim().toLowerCase();

const requiredPositiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
};

const apiJson = async (fetchImpl, repository, path, token) => {
  if (typeof fetchImpl !== "function") throw new Error("GitHub API fetch implementation is unavailable; failing closed");
  const url = `https://api.github.com/repos/${repository}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new Error(`GitHub API request failed for ${path}: ${error.message}`);
  }
  if (!response || response.ok !== true) {
    throw new Error(`GitHub API request failed for ${path}: HTTP ${response?.status ?? "unknown"}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GitHub API response was not valid JSON for ${path}: ${error.message}`);
  }
};

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const requireArray = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};

const requireEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual ?? "missing"}`);
};

const eligibleCollaborators = (collaborators, authorLogin) => {
  // Repository visibility is irrelevant to direct-collaborator eligibility.
  const eligibleRoles = new Set(["admin", "maintain", "push"]);
  return collaborators.filter((collaborator) => {
    const login = typeof collaborator.login === "string" ? collaborator.login : "";
    const role = typeof collaborator.role_name === "string" ? collaborator.role_name.toLowerCase() : "";
    const permissions = collaborator.permissions ?? {};
    const hasEligibleRole = eligibleRoles.has(role);
    const hasEligiblePermission = permissions.admin === true || permissions.maintain === true || permissions.push === true;
    return login && normalizedIdentity(login) !== normalizedIdentity(authorLogin) && (hasEligibleRole || hasEligiblePermission);
  });
};

const evidenceUrls = (value) => [...value.matchAll(/https:\/\/github\.com\/[^\s)>,]+/gi)]
  .map((match) => match[0].replace(/[.,;]+$/, ""));

const validateCurrentChecksUrl = (value, repository, number) => {
  const urls = evidenceUrls(value);
  if (urls.length !== 1) throw new Error("CI evidence must contain exactly one current PR checks URL");
  const url = githubUrl(urls[0], "CI evidence");
  const expectedPath = `/${repository}/pull/${number}/checks`.toLowerCase();
  if (url.pathname.toLowerCase() !== expectedPath || url.search || url.hash) {
    throw new Error(`CI evidence must be the current PR checks URL: https://github.com/${repository}/pull/${number}/checks`);
  }
};

const pullRequestFromEvent = (event, repository) => {
  if (!event || !event.pull_request) throw new Error("GitHub event must contain pull_request");
  if (normalizeRepository(event.repository?.full_name ?? "") !== normalizeRepository(repository)) {
    throw new Error("event repository does not match GITHUB_REPOSITORY");
  }
  const pullRequest = event.pull_request;
  const number = requiredPositiveNumber(pullRequest.number, "event pull request number");
  const authorLogin = requiredValue(pullRequest.user?.login, "event pull request author");
  const base = requireObject(pullRequest.base, "event pull request base");
  const head = requireObject(pullRequest.head, "event pull request head");
  const baseRepo = requiredValue(base.repo?.full_name, "event pull request base repository");
  const headRepo = requiredValue(head.repo?.full_name, "event pull request head repository");
  return {
    number,
    authorLogin,
    base: {
      ref: requiredValue(base.ref, "event pull request base ref"),
      sha: requiredValue(base.sha, "event pull request base sha"),
      repository: baseRepo,
    },
    head: {
      ref: requiredValue(head.ref, "event pull request head ref"),
      sha: requiredValue(head.sha, "event pull request head sha"),
      repository: headRepo,
    },
  };
};

const verifyPullRequestApiState = (eventPullRequest, currentPullRequest, repository) => {
  requireObject(currentPullRequest, "current pull request API response");
  requireEqual(requiredPositiveNumber(currentPullRequest.number, "current pull request number"), eventPullRequest.number, "pull request number");
  requireEqual(currentPullRequest.state, "open", "pull request state");
  requireEqual(normalizedIdentity(requiredValue(currentPullRequest.user?.login, "current pull request author")), normalizedIdentity(eventPullRequest.authorLogin), "pull request author");
  const currentBase = requireObject(currentPullRequest.base, "current pull request base");
  const currentHead = requireObject(currentPullRequest.head, "current pull request head");
  requireEqual(currentBase.ref, eventPullRequest.base.ref, "pull request base ref");
  requireEqual(currentBase.sha, eventPullRequest.base.sha, "pull request base sha");
  requireEqual(currentHead.ref, eventPullRequest.head.ref, "pull request head ref");
  requireEqual(currentHead.sha, eventPullRequest.head.sha, "pull request head sha");
  requireEqual(normalizeRepository(requiredValue(currentBase.repo?.full_name, "current pull request base repository")), normalizeRepository(eventPullRequest.base.repository), "pull request base repository");
  requireEqual(normalizeRepository(requiredValue(currentHead.repo?.full_name, "current pull request head repository")), normalizeRepository(eventPullRequest.head.repository), "pull request head repository");
  requireEqual(normalizeRepository(requiredValue(currentBase.repo?.full_name, "current pull request repository")), normalizeRepository(repository), "current pull request repository");
};

const verifyWorkflowRun = (run, runId, repository, pullRequest) => {
  requireObject(run, "current workflow run API response");
  requireEqual(String(run.id), String(runId), "workflow run id");
  requireEqual(normalizeRepository(requiredValue(run.repository?.full_name, "workflow run repository")), normalizeRepository(repository), "workflow run repository");
  requireEqual(run.head_sha, pullRequest.head.sha, "workflow run head sha");
  const runPullRequests = requireArray(run.pull_requests, "workflow run pull requests");
  if (!runPullRequests.some((item) => Number(item.number) === pullRequest.number)) {
    throw new Error("workflow run is not associated with the current PR");
  }
};

const verifyStaticCheck = (checkRunsPayload, headSha) => {
  const checkRuns = requireArray(requireObject(checkRunsPayload, "current head check-runs API response").check_runs, "current head check runs");
  const staticCheck = checkRuns.find((checkRun) => checkRun.name === "static"
    && checkRun.head_sha === headSha
    && checkRun.app?.slug === "github-actions");
  if (!staticCheck) throw new Error("current head is missing the GitHub Actions static check");
  if (staticCheck.status !== "completed" || staticCheck.conclusion !== "success") {
    throw new Error(`GitHub Actions static check must be completed/success; received ${staticCheck.status ?? "missing"}/${staticCheck.conclusion ?? "missing"}`);
  }
};

const latestReviewFor = (reviews, reviewerLogin) => reviews
  .filter((review) => normalizedIdentity(review.user?.login ?? "") === normalizedIdentity(reviewerLogin))
  .sort((left, right) => {
    const leftTime = Date.parse(left.submitted_at ?? left.created_at ?? "") || 0;
    const rightTime = Date.parse(right.submitted_at ?? right.created_at ?? "") || 0;
    return rightTime - leftTime;
  })[0];

export async function validatePullRequestState({ event, token, repository, runId, staticResult, fetchImpl = globalThis.fetch }) {
  requiredValue(token, "GITHUB_TOKEN");
  requiredValue(repository, "GITHUB_REPOSITORY");
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name");
  requiredPositiveNumber(runId, "GITHUB_RUN_ID");
  if (staticResult !== "success") throw new Error(`needs.static.result must be exactly success; received ${staticResult ?? "missing"}`);
  const eventPullRequest = pullRequestFromEvent(event, repository);
  const currentPullRequest = await apiJson(fetchImpl, repository, `/pulls/${eventPullRequest.number}`, token);
  verifyPullRequestApiState(eventPullRequest, currentPullRequest, repository);
  if (event.pull_request.body !== currentPullRequest.body) throw new Error("event pull_request.body is stale and does not match the current PR body");
  const bodyResult = validatePullRequestBody(currentPullRequest.body, { authorLogin: eventPullRequest.authorLogin });
  const expectedCommitRange = `${eventPullRequest.base.sha}..${eventPullRequest.head.sha}`;
  requireEqual(bodyResult.fields.commitRange, expectedCommitRange, "reviewed commit range");
  validateCurrentChecksUrl(bodyResult.fields.ciEvidence, repository, eventPullRequest.number);
  const currentRun = await apiJson(fetchImpl, repository, `/actions/runs/${runId}`, token);
  verifyWorkflowRun(currentRun, runId, repository, eventPullRequest);
  verifyStaticCheck(await apiJson(fetchImpl, repository, `/commits/${eventPullRequest.head.sha}/check-runs?per_page=100`, token), eventPullRequest.head.sha);
  const collaborators = requireArray(await apiJson(fetchImpl, repository, "/collaborators?affiliation=direct&per_page=100", token), "direct collaborators");
  const eligible = eligibleCollaborators(collaborators, eventPullRequest.authorLogin);
  const reviewMode = eligible.length > 0 ? "formal" : "solo";

  if (bodyResult.mode === "solo") {
    if (reviewMode === "formal") throw new Error("solo mode is invalid while an eligible reviewer exists");
  } else {
    const formalIdentity = bodyResult.fields.formalIdentity;
    if (!eligible.some((collaborator) => normalizedIdentity(collaborator.login) === normalizedIdentity(formalIdentity))) {
      throw new Error("formal reviewer is not a current eligible collaborator");
    }
    const reviews = requireArray(await apiJson(fetchImpl, repository, `/pulls/${eventPullRequest.number}/reviews?per_page=100`, token), "pull request reviews");
    const latestReview = latestReviewFor(reviews, formalIdentity);
    if (!latestReview || String(latestReview.state).toUpperCase() !== "APPROVED" || latestReview.commit_id !== eventPullRequest.head.sha) {
      throw new Error("specified formal reviewer lacks an APPROVED review on the current head");
    }
  }

  return { mode: bodyResult.mode, pullRequestNumber: eventPullRequest.number, headSha: eventPullRequest.head.sha, eligibleReviewerLogins: eligible.map(({ login }) => login) };
}

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

export async function main(options = {}) {
  const config = typeof options === "string" ? { eventPath: options } : options;
  const eventPath = config.eventPath ?? process.env.GITHUB_EVENT_PATH;
  const token = config.token ?? process.env.GITHUB_TOKEN;
  const repository = config.repository ?? process.env.GITHUB_REPOSITORY;
  const runId = config.runId ?? process.env.GITHUB_RUN_ID;
  const staticResult = config.staticResult ?? process.env.GITHUB_STATIC_RESULT;
  requiredValue(eventPath, "GITHUB_EVENT_PATH");
  let event;
  try {
    event = JSON.parse(readFileSync(resolve(eventPath), "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse GITHUB_EVENT_PATH: ${error.message}`);
  }
  const result = await validatePullRequestState({ event, token, repository, runId, staticResult, fetchImpl: config.fetchImpl ?? globalThis.fetch });
  console.log(`Review evidence verified: ${result.mode} mode; PR #${result.pullRequestNumber} head ${result.headSha} matches current GitHub state.`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Review evidence validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
