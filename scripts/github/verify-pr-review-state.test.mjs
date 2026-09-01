import assert from "node:assert/strict";
import test from "node:test";

import { validatePullRequestState } from "./verify-pr-review-evidence.mjs";

const REPOSITORY = "EthanSMC/qwen-harness-bridge";
const TOKEN = "test-token";
const RUN_ID = "9001";
const PR_NUMBER = 37;
const AUTHOR = "EthanSMC";
const BASE_SHA = "base-sha-37";
const HEAD_SHA = "head-sha-37";

const bodyFor = ({
  mode = "solo",
  formalIdentity = "",
  formalUrl = "",
  soloRef = "docs/github/repository-status.md#review-gate-status",
  soloDate = "2026-09-01",
  commitRange = `${BASE_SHA}..${HEAD_SHA}`,
  ciEvidence = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}/checks`,
} = {}) => [
  "## Review evidence",
  `- [${mode === "formal" ? "x" : " "}] Formal GitHub review — a distinct eligible GitHub reviewer gave an Approve.`,
  `- [${mode === "solo" ? "x" : " "}] Solo-maintainer fallback — eligibility evidence shows no distinct eligible GitHub reviewer.`,
  `- Formal GitHub review URL (required for formal mode): ${formalUrl}`,
  `- Formal reviewer GitHub identity (required for formal mode): ${formalIdentity}`,
  `- Solo eligibility evidence URL or repository-status reference (required for solo mode): ${soloRef}`,
  `- Solo eligibility verification date (required for solo mode): ${soloDate}`,
  "- Implementer agent ID: agent-implementer-37",
  "- Reviewer agent ID: agent-reviewer-37",
  "- Reviewer identity (agent/account): reviewer-agent-37",
  "- Reviewer is distinct from implementer: [x] Yes",
  "- Fresh review of this exact commit range: [x] Yes",
  "- Independent review (no author self-approval or fabricated evidence): [x] Yes",
  `- Commit range reviewed (base..head; use the exact event base.sha..head.sha): ${commitRange}`,
  "- Findings: None",
  "- Fix rounds: Round 1: addressed all findings",
  "- Final verdict: PASS",
  `- CI run URL(s) / PR checks URL(s) and required-check results: ${ciEvidence}`,
].join("\n");

const eventFor = (overrides = {}) => ({
  repository: { full_name: REPOSITORY },
  pull_request: {
    number: PR_NUMBER,
    user: { login: AUTHOR },
    base: { ref: "main", sha: BASE_SHA, repo: { full_name: REPOSITORY } },
    head: { ref: "feature/37", sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
    body: bodyFor(),
    ...overrides,
  },
});

const pullRequestFor = (overrides = {}) => ({
  number: PR_NUMBER,
  state: "open",
  user: { login: AUTHOR },
  base: { ref: "main", sha: BASE_SHA, repo: { full_name: REPOSITORY } },
  head: { ref: "feature/37", sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
  body: bodyFor(),
  ...overrides,
});

const runFor = (overrides = {}) => ({
  id: Number(RUN_ID),
  repository: { full_name: REPOSITORY },
  head_sha: HEAD_SHA,
  pull_requests: [{ number: PR_NUMBER }],
  ...overrides,
});

const collaboratorsFor = ({ secondReviewer = false } = {}) => [
  { login: AUTHOR, role_name: "admin", permissions: { admin: true, maintain: true, push: true, pull: true } },
  ...(secondReviewer ? [{ login: "eligible-reviewer", role_name: "push", permissions: { push: true, pull: true } }] : []),
];

const reviewsFor = ({ reviewer = "eligible-reviewer", state = "APPROVED", commitId = HEAD_SHA } = {}) => [{
  user: { login: reviewer },
  state,
  commit_id: commitId,
  submitted_at: "2026-09-01T01:00:00Z",
}];

const checkRunsFor = ({ status = "completed", conclusion = "success", includeStatic = true } = {}) => ({
  total_count: includeStatic ? 2 : 1,
  check_runs: [
    ...(includeStatic ? [{ name: "static", head_sha: HEAD_SHA, status, conclusion, app: { slug: "github-actions" } }] : []),
    { name: "governance", head_sha: HEAD_SHA, status: "in_progress", conclusion: null, app: { slug: "github-actions" } },
  ],
});

const fixtureFetch = (fixtures, calls = []) => async (url, options) => {
  const parsed = new URL(url);
  const key = `${parsed.pathname}${parsed.search}`;
  calls.push({ key, options });
  const fixture = fixtures[key];
  if (fixture instanceof Error) throw fixture;
  if (fixture === undefined) throw new Error(`missing fixture: ${key}`);
  if (fixture?.failure) return { ok: false, status: fixture.status ?? 500, json: async () => fixture.body ?? {} };
  return { ok: true, status: 200, json: async () => fixture };
};

const fixturesFor = ({ secondReviewer = false, reviews, pullRequest, checkRuns = checkRunsFor() } = {}) => ({
  [`/repos/${REPOSITORY}/pulls/${PR_NUMBER}`]: pullRequest ?? pullRequestFor(),
  [`/repos/${REPOSITORY}/actions/runs/${RUN_ID}`]: runFor(),
  [`/repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs?per_page=100`]: checkRuns,
  [`/repos/${REPOSITORY}/collaborators?affiliation=direct&per_page=100`]: collaboratorsFor({ secondReviewer }),
  ...(reviews === undefined ? {} : { [`/repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews?per_page=100`]: reviews }),
});

const stateFor = (event, fixtures, { staticResult = "success" } = {}) => validatePullRequestState({
  event,
  token: TOKEN,
  repository: REPOSITORY,
  runId: RUN_ID,
  staticResult,
  fetchImpl: fixtureFetch(fixtures),
});

test("accepts solo mode when current PR state and checks URL match", async () => {
  const result = await stateFor(eventFor(), fixturesFor());

  assert.equal(result.mode, "solo");
});

test("accepts formal mode with a current-head approval from the specified eligible reviewer", async () => {
  const event = eventFor({
    body: bodyFor({
      mode: "formal",
      formalIdentity: "eligible-reviewer",
      formalUrl: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#pullrequestreview-123`,
      soloRef: "",
      soloDate: "",
    }),
  });

  const result = await stateFor(event, fixturesFor({
    secondReviewer: true,
    reviews: reviewsFor(),
    pullRequest: pullRequestFor({ body: event.pull_request.body }),
  }));

  assert.equal(result.mode, "formal");
});

test("rejects a CI evidence URL for another PR", async () => {
  const event = eventFor({ body: bodyFor({ ciEvidence: `https://github.com/${REPOSITORY}/pull/99/checks` }) });

  await assert.rejects(stateFor(event, fixturesFor({ pullRequest: pullRequestFor({ body: event.pull_request.body }) })), /current PR checks URL|PR checks URL/i);
});

test("rejects a stale event body when the current PR body differs", async () => {
  const event = eventFor({ body: bodyFor().replace("- Findings: None", "- Findings: stale event snapshot") });

  await assert.rejects(stateFor(event, fixturesFor()), /event.*body.*stale|body.*mismatch/i);
});

test("rejects an invalid current PR body even when the event body was valid", async () => {
  const invalidBody = bodyFor().replace(
    "- [ ] Formal GitHub review",
    "- [x] Formal GitHub review",
  );

  await assert.rejects(
    stateFor(eventFor({ body: invalidBody }), fixturesFor({ pullRequest: pullRequestFor({ body: invalidBody }) })),
    /exactly one review mode/i,
  );
});

test("rejects static failure, cancellation, or skip before live state can pass", async (t) => {
  for (const staticResult of ["failure", "cancelled", "skipped"]) {
    await t.test(staticResult, async () => {
      await assert.rejects(stateFor(eventFor(), fixturesFor(), { staticResult }), /static.*success/i);
    });
  }
});

test("rejects a missing or non-success current-head static check", async (t) => {
  const cases = [
    ["missing", checkRunsFor({ includeStatic: false })],
    ["pending", checkRunsFor({ status: "in_progress", conclusion: null })],
    ["failure", checkRunsFor({ status: "completed", conclusion: "failure" })],
    ["cancelled", checkRunsFor({ status: "completed", conclusion: "cancelled" })],
  ];
  for (const [name, checkRuns] of cases) {
    await t.test(name, async () => {
      await assert.rejects(stateFor(eventFor(), fixturesFor({ checkRuns })), /static.*check|completed.*success/i);
    });
  }
});

test("rejects an event/API head mismatch", async () => {
  const event = eventFor({ head: { ref: "feature/37", sha: "wrong-head", repo: { full_name: REPOSITORY } } });

  await assert.rejects(stateFor(event, fixturesFor()), /head.*mismatch|head.*does not match|commit range mismatch/i);
});

test("rejects a run associated with another PR or head", async () => {
  const fixtures = fixturesFor();
  fixtures[`/repos/${REPOSITORY}/actions/runs/${RUN_ID}`] = runFor({ head_sha: "other-head", pull_requests: [{ number: 99 }] });

  await assert.rejects(stateFor(eventFor(), fixtures), /workflow run.*current PR|run.*head|run.*PR/i);
});

test("rejects solo mode when a second eligible collaborator exists", async () => {
  await assert.rejects(stateFor(eventFor(), fixturesFor({ secondReviewer: true })), /solo mode.*eligible reviewer|eligible reviewer.*solo/i);
});

test("rejects formal mode with a stale approval", async () => {
  const event = eventFor({
    body: bodyFor({
      mode: "formal",
      formalIdentity: "eligible-reviewer",
      formalUrl: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#pullrequestreview-123`,
      soloRef: "",
      soloDate: "",
    }),
  });

  await assert.rejects(
    stateFor(event, fixturesFor({
      secondReviewer: true,
      reviews: reviewsFor({ commitId: "old-head" }),
      pullRequest: pullRequestFor({ body: event.pull_request.body }),
    })),
    /current head|APPROVED.*current/i,
  );
});

test("rejects formal mode when the approval belongs to another reviewer", async () => {
  const event = eventFor({
    body: bodyFor({
      mode: "formal",
      formalIdentity: "eligible-reviewer",
      formalUrl: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#pullrequestreview-123`,
      soloRef: "",
      soloDate: "",
    }),
  });

  await assert.rejects(
    stateFor(event, fixturesFor({
      secondReviewer: true,
      reviews: reviewsFor({ reviewer: "other-reviewer" }),
      pullRequest: pullRequestFor({ body: event.pull_request.body }),
    })),
    /specified reviewer|reviewer.*eligible|APPROVED/i,
  );
});

test("rejects formal mode without an approval", async () => {
  const event = eventFor({
    body: bodyFor({
      mode: "formal",
      formalIdentity: "eligible-reviewer",
      formalUrl: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#pullrequestreview-123`,
      soloRef: "",
      soloDate: "",
    }),
  });

  await assert.rejects(
    stateFor(event, fixturesFor({
      secondReviewer: true,
      reviews: reviewsFor({ state: "COMMENTED" }),
      pullRequest: pullRequestFor({ body: event.pull_request.body }),
    })),
    /APPROVED.*current head|current-head.*approval/i,
  );
});

test("fails closed on a GitHub API error", async () => {
  const fixtures = fixturesFor();
  fixtures[`/repos/${REPOSITORY}/pulls/${PR_NUMBER}`] = { failure: true, status: 503 };

  await assert.rejects(stateFor(eventFor(), fixtures), /GitHub API request failed|fail closed/i);
});
