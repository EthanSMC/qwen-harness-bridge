import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient, GitHubApiError } from "./github-api.mjs";

const REPOSITORY = "octo/example";
const TOKEN = "github-token-that-must-not-leak";

const response = (
  value,
  { ok = true, status = 200, date = "Fri, 04 Sep 2026 12:34:56 GMT" } = {},
) => ({
  ok,
  status,
  headers: { get: (name) => (name.toLowerCase() === "date" ? date : null) },
  json: async () => value,
});

test("sets strict headers and validates object responses", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ id: 46, state: "open" });
    },
    repository: REPOSITORY,
    token: TOKEN,
  });

  assert.deepEqual(await client.get("/issues/46"), { id: 46, state: "open" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers["X-GitHub-Idempotency-Key"], undefined);
});

test("accepts Git object IDs without weakening numeric object ID checks", async () => {
  const clientFor = (value) =>
    createGitHubClient({
      fetchImpl: async () => response(value),
      repository: REPOSITORY,
      token: TOKEN,
    });
  const oid = "ee7d4742ac18067bb502fe8c1c9fd4c315d6a98d";

  assert.deepEqual(await clientFor({ head_commit: { id: oid } }).get("/run"), {
    head_commit: { id: oid },
  });
  await assert.rejects(
    () => clientFor({ head_commit: { id: "not-a-git-object" } }).get("/run"),
    /id.*positive|Git object/i,
  );
  await assert.rejects(
    () => clientFor({ id: oid }).get("/issues/46"),
    /id.*positive|positive.*id/i,
  );
  await assert.rejects(
    () => clientFor({ head_commit: [{ id: oid }] }).get("/run"),
    /id.*positive|positive.*id/i,
  );
});

test("uses the GitHub response Date as the server clock", async () => {
  let requestedUrl;
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response([]);
    },
    repository: REPOSITORY,
    token: TOKEN,
  });
  assert.equal(await client.serverTime(), "2026-09-04T12:34:56.000Z");
  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/octo/example/issues?state=open&per_page=1",
  );
});

test("aborts requests at the configured deadline", async () => {
  const client = createGitHubClient({
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    repository: REPOSITORY,
    token: TOKEN,
    timeoutMs: 10,
  });
  await assert.rejects(() => client.get("/issues/46"), /network boundary/i);
});

test("rejects unsafe paths, invalid response shapes, and invalid IDs", async () => {
  const clientFor = (value) =>
    createGitHubClient({
      fetchImpl: async () => response(value),
      repository: REPOSITORY,
      token: TOKEN,
    });
  await assert.rejects(
    () => clientFor("text").get("/issues/46"),
    /object or array/i,
  );
  await assert.rejects(
    () => clientFor({ id: 0 }).get("/issues/46"),
    /id.*positive|positive.*id/i,
  );
  await assert.rejects(
    () => clientFor({}).get("https://evil.example"),
    /relative.*path/i,
  );
  await assert.rejects(
    () => clientFor({}).get("/issues/../user"),
    /relative.*path/i,
  );
  await assert.rejects(
    () => clientFor(["not-an-object"]).get("/issues"),
    /array items.*objects/i,
  );
  assert.throws(
    () =>
      createGitHubClient({
        fetchImpl: async () => response({}),
        repository: REPOSITORY,
        token: TOKEN,
        maxPages: 101,
      }),
    /safety cap/i,
  );
});

test("paginates until a short page", async () => {
  const pages = [[{ id: 1 }], [{ id: 2 }], []];
  const seen = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      seen.push(page);
      return response(pages[page - 1]);
    },
    repository: REPOSITORY,
    token: TOKEN,
    pageSize: 1,
    maxPages: 4,
  });

  assert.deepEqual(await client.getAll("/issues/46/comments", "comments"), [
    { id: 1 },
    { id: 2 },
  ]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("fails closed at the pagination cap and on oversized pages", async () => {
  const capped = createGitHubClient({
    fetchImpl: async () => response([{ id: 1 }]),
    repository: REPOSITORY,
    token: TOKEN,
    pageSize: 1,
    maxPages: 3,
  });
  await assert.rejects(
    () => capped.getAll("/issues", "issues"),
    /issues.*safety cap/i,
  );

  const oversized = createGitHubClient({
    fetchImpl: async () => response([{ id: 1 }, { id: 2 }]),
    repository: REPOSITORY,
    token: TOKEN,
    pageSize: 1,
  });
  await assert.rejects(
    () => oversized.getAll("/issues", "issues"),
    /exceeded.*page size/i,
  );
});

test("HTTP and JSON errors never expose credentials or response bodies", async () => {
  const httpClient = createGitHubClient({
    fetchImpl: async () =>
      response({ secret: "response-secret" }, { ok: false, status: 403 }),
    repository: REPOSITORY,
    token: TOKEN,
  });
  await assert.rejects(
    () => httpClient.get("/issues/46"),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.method, "GET");
      assert.equal(error.path, "/issues/46");
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.message, /response-secret/);
      return true;
    },
  );

  const jsonClient = createGitHubClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error(`bad JSON containing ${TOKEN}`);
      },
    }),
    repository: REPOSITORY,
    token: TOKEN,
  });
  await assert.rejects(
    () => jsonClient.get("/issues/46"),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );
});

test("reconciles an uncertain mutation without replay when already applied", async () => {
  let issue = { id: 46, labels: [] };
  let patches = 0;
  const client = createGitHubClient({
    fetchImpl: async (_url, options) => {
      if (options.method === "PATCH") {
        patches += 1;
        issue = { id: 46, labels: [{ name: "status:in-progress" }] };
        throw new TypeError("socket closed after write");
      }
      return response(issue);
    },
    repository: REPOSITORY,
    token: TOKEN,
  });

  const result = await client.mutateAndVerify({
    mutation: {
      method: "PATCH",
      path: "/issues/46",
      body: { labels: ["status:in-progress"] },
    },
    read: () => client.get("/issues/46"),
    verify: (current) =>
      current.labels.some(({ name }) => name === "status:in-progress"),
  });
  assert.equal(result.verified, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.retried, false);
  assert.equal(patches, 1);
});

test("retries an idempotent uncertain mutation only after failed verification", async () => {
  let issue = { id: 46, labels: [] };
  let patches = 0;
  const client = createGitHubClient({
    fetchImpl: async (_url, options) => {
      if (options.method === "PATCH") {
        patches += 1;
        if (patches === 1) throw new TypeError("connect reset");
        issue = { id: 46, labels: [{ name: "status:in-progress" }] };
        return response(issue);
      }
      return response(issue);
    },
    repository: REPOSITORY,
    token: TOKEN,
  });

  const result = await client.mutateAndVerify({
    mutation: {
      method: "PATCH",
      path: "/issues/46",
      body: { labels: ["status:in-progress"] },
    },
    read: () => client.get("/issues/46"),
    verify: (current) => current.labels.length === 1,
  });
  assert.equal(result.verified, true);
  assert.equal(result.retried, true);
  assert.equal(patches, 2);
});

for (const method of ["POST", "PATCH"]) {
  for (const failure of ["body timeout", "invalid JSON", "invalid shape"]) {
    test(`${method} reconciles a committed mutation after ${failure}`, async () => {
      let applied = false;
      let mutationCalls = 0;
      let reads = 0;
      const client = createGitHubClient({
        fetchImpl: async (_url, options) => {
          if (options.method === method) {
            applied = true;
            mutationCalls += 1;
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => {
                if (failure === "invalid JSON") {
                  throw new SyntaxError("truncated response");
                }
                if (failure === "invalid shape") return "not-an-object";
                return new Promise((_resolve, reject) => {
                  options.signal.addEventListener(
                    "abort",
                    () => reject(new Error("body aborted")),
                    { once: true },
                  );
                });
              },
            };
          }
          reads += 1;
          return response({ id: 46, applied });
        },
        repository: REPOSITORY,
        token: TOKEN,
        timeoutMs: 10,
      });

      const result = await client.mutateAndVerify({
        mutation: {
          method,
          path: method === "POST" ? "/issues/46/comments" : "/issues/46",
          body: { applied: true },
        },
        read: () => client.get("/issues/46"),
        verify: (current) => current.applied === true,
      });
      assert.equal(result.reconciled, true);
      assert.equal(result.retried, false);
      assert.equal(mutationCalls, 1);
      assert.equal(reads, 1);
    });
  }
}

test("never replays an uncertain POST, even when given a stable intent key", async () => {
  let posts = 0;
  let reads = 0;
  const client = createGitHubClient({
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        posts += 1;
        throw new TypeError("connect reset");
      }
      reads += 1;
      return response({ id: 46, comments: [] });
    },
    repository: REPOSITORY,
    token: TOKEN,
  });

  await assert.rejects(
    () =>
      client.mutateAndVerify({
        mutation: {
          method: "POST",
          path: "/issues/46/comments",
          body: { body: "hello" },
          idempotencyKey: "comment-intent:46",
        },
        read: () => client.get("/issues/46"),
        verify: () => false,
      }),
    /cannot safely replay/i,
  );
  assert.equal(posts, 1);
  assert.equal(reads, 3);
});
