import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyStaleWork,
  collectStaleWork,
  main,
  renderStaleWork,
} from "./stale-work.mjs";

const now = "2026-09-05T12:00:00Z";
const activity = (created_at, bot = false) => ({
  created_at,
  user: {
    login: bot ? "github-actions[bot]" : "owner",
    type: bot ? "Bot" : "User",
  },
});
const item = (state = "review", timestamp = "2026-09-03T12:00:00Z") => ({
  issue_number: 62,
  pr_numbers: [63],
  state,
  activities: [activity(timestamp)],
});
test("threshold edges use verified timestamps inclusively", () => {
  assert.equal(classifyStaleWork([item()], now).total, 1);
  assert.equal(
    classifyStaleWork([item("review", "2026-09-03T12:00:01Z")], now).total,
    0,
  );
  assert.equal(
    classifyStaleWork([item("blocked", "2026-09-04T12:00:00Z")], now).total,
    1,
  );
  assert.equal(
    classifyStaleWork([item("blocked", "2026-09-04T12:00:01Z")], now).total,
    0,
  );
});
test("bot-only housekeeping does not refresh human checkpoint", () => {
  const value = item();
  value.activities.push(activity(now, true));
  assert.equal(classifyStaleWork([value], now).total, 1);
  value.activities.push(activity(now));
  assert.equal(classifyStaleWork([value], now).total, 0);
});
test("malformed, impossible, future times and missing human checkpoints fail closed", () => {
  for (const value of ["bad", "2026-02-30T12:00:00Z", "2026-09-06T12:00:00Z"])
    assert.throws(() => classifyStaleWork([item("review", value)], now));
  assert.throws(() => classifyStaleWork([item()], "bad"));
  const value = item();
  value.activities = [activity(now, true)];
  assert.throws(() => classifyStaleWork([value], now));
});
test("bounded safe output reports total and truncated numeric references", () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    ...item(),
    issue_number: index + 1,
    pr_numbers: [],
    body: "private text",
  }));
  const result = classifyStaleWork(items, now);
  assert.equal(result.total, 60);
  assert.equal(result.truncated, 10);
  assert.equal(result.items.length, 50);
  assert.ok(!renderStaleWork(result).includes("private text"));
  assert.match(renderStaleWork(classifyStaleWork([], now)), /Actionable: 0/);
});
test("only review and blocked states are classified", () => {
  assert.equal(classifyStaleWork([{ state: "in-progress" }], now).total, 0);
});
test("collector uses existing server time and only bounded GET collections", async () => {
  const calls = [];
  const github = {
    serverTime: async () => now,
    getAll: async (path) => {
      calls.push(path);
      if (path.startsWith("/issues?"))
        return path.includes("review")
          ? [
              {
                number: 62,
                state: "open",
                labels: [{ name: "type:bug" }, { name: "status:review" }],
                ...activity("2026-09-01T12:00:00Z"),
              },
            ]
          : [];
      if (path.startsWith("/pulls?"))
        return [
          {
            number: 63,
            body: "Closes #62",
            ...activity("2026-09-03T12:00:00Z"),
          },
        ];
      return [];
    },
  };
  const report = await collectStaleWork(github);
  assert.equal(report.total, 1);
  assert.deepEqual(report.items[0].pr_numbers, [63]);
  assert.ok(calls.includes("/pulls/63/reviews"));
});
test("collector exposes safety-cap failure rather than incomplete counts", async () => {
  const github = {
    serverTime: async () => now,
    getAll: async () =>
      Array.from({ length: 101 }, (_, i) => ({
        number: i + 1,
        state: "open",
        labels: [{ name: "type:bug" }, { name: "status:review" }],
      })),
  };
  await assert.rejects(collectStaleWork(github), /cap/);
});

test("linked PR rows count both numeric references against the output limit", () => {
  const records = Array.from({ length: 30 }, (_, i) => ({
    ...item(),
    issue_number: i + 1,
    pr_numbers: [i + 101],
  }));
  const report = classifyStaleWork(records, now);
  assert.equal(report.items.length, 25);
  assert.equal(report.truncated, 5);
});
test("CLI emits empty and failure summary/artifact without GitHub writes or raw error content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stalled-test-"));
  try {
    const env = {
      GITHUB_REPOSITORY: "Owner/repo",
      GITHUB_TOKEN: "test-token",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      STALE_WORK_REPORT_PATH: join(dir, "report.md"),
    };
    const calls = [];
    await main({
      env,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          headers: { get: () => "Sat, 05 Sep 2026 12:00:00 GMT" },
          json: async () => [],
        };
      },
    });
    assert.match(
      readFileSync(env.STALE_WORK_REPORT_PATH, "utf8"),
      /Actionable: 0/,
    );
    assert.ok(
      calls.every(
        (call) =>
          call.options.method === "GET" &&
          call.options.headers.Authorization === "Bearer test-token",
      ),
    );
    await assert.rejects(
      main({
        env,
        fetchImpl: async () => {
          throw new Error("PRIVATE SOURCE SHOULD NOT APPEAR");
        },
      }),
    );
    const text = readFileSync(env.STALE_WORK_REPORT_PATH, "utf8");
    assert.match(text, /Report unavailable/);
    assert.ok(!text.includes("PRIVATE SOURCE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
