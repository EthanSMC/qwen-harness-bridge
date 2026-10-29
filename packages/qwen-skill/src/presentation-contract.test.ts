import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMPTY_EVENTS_TEXT,
  FRESHNESS_TEXT,
  MAX_DETAIL_CHARACTERS,
  MAX_EVENT_SUMMARIES,
  MAX_TTS_CHARACTERS,
  renderDetail,
  renderEventSummaries,
  renderListRows,
  renderResult,
  renderTts,
  resolveOrdinal,
  STATUS_TEXT,
  TASK_LIST_LIMIT,
} from "./presentation.js";
import {
  parseTranscriptFixture,
  type TranscriptFixture,
} from "./transcript-schema.js";

const fixturesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
);
const load = (name: string): TranscriptFixture =>
  parseTranscriptFixture(
    JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")),
  );

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
const NOW = "2026-10-29T10:00:00.000Z";

const fixtureStems = [
  "list-tasks",
  "inspect-running",
  "inspect-offline",
  "result-text",
  "result-image",
];

describe("status and freshness mappings", () => {
  it("maps every domain value to the documented glasses text", () => {
    expect(STATUS_TEXT).toEqual({
      queued: "等待 Mac 接单",
      dispatched: "Mac 已接单",
      running: "正在执行",
      waiting_approval: "等待你的批准",
      cancelling: "正在取消",
      succeeded: "已完成",
      failed: "执行失败",
      cancelled: "已取消",
      expired: "已过期",
    });
    expect(FRESHNESS_TEXT).toEqual({
      fresh: "连接正常",
      stale: "连接不稳定",
      offline: "连接中断，正在协调",
    });
  });
});

describe("task list presentation", () => {
  it("lists tasks with limit five before the list UI and maps ordinals to that list", () => {
    const fixture = load("list-tasks.json");
    const steps = fixture.turns[0]?.steps ?? [];
    const listCall = steps.findIndex(
      (step) => step.kind === "mcp_call" && step.tool === "list_tasks",
    );
    const listUi = steps.findIndex(
      (step) => step.kind === "ui_call" && step.tool === "UiTool.list",
    );
    expect(listCall).toBeGreaterThanOrEqual(0);
    expect(listUi).toBeGreaterThan(listCall);
    const call = steps[listCall];
    expect(call?.kind).toBe("mcp_call");
    if (call?.kind === "mcp_call") {
      expect(call.arguments.limit).toBe(TASK_LIST_LIMIT);
    }
    const uiStep = steps[listUi];
    expect(uiStep?.kind).toBe("ui_call");
    const linesOf =
      uiStep?.kind === "ui_call" ? (uiStep.payload.lines ?? []) : [];
    expect(linesOf.length).toBeLessThanOrEqual(TASK_LIST_LIMIT);
    expect(linesOf.map((line) => Number.parseInt(line, 10))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("renders at most five rows, newest first, with localized text and no raw ids", () => {
    const rows = renderListRows(
      [
        {
          shortId: "QH-AAAA",
          title: "最早的",
          status: "queued",
          freshness: "fresh",
          updatedAt: "2026-10-29T08:00:00.000Z",
        },
        {
          shortId: "QH-BBBB",
          title: "最新的",
          status: "running",
          stage: "运行测试",
          freshness: "offline",
          unread: true,
          updatedAt: "2026-10-29T09:55:00.000Z",
        },
        {
          shortId: "QH-CCCC",
          title: "中间的",
          status: "succeeded",
          freshness: "stale",
          updatedAt: "2026-10-29T09:00:00.000Z",
        },
        {
          shortId: "QH-DDDD",
          title: "第四",
          status: "failed",
          freshness: "fresh",
          updatedAt: "2026-10-29T08:30:00.000Z",
        },
        {
          shortId: "QH-EEEE",
          title: "第五",
          status: "cancelled",
          freshness: "fresh",
          updatedAt: "2026-10-29T08:15:00.000Z",
        },
        {
          shortId: "QH-FFFF",
          title: "第六",
          status: "expired",
          freshness: "fresh",
          updatedAt: "2026-10-29T07:00:00.000Z",
        },
      ],
      { now: NOW },
    );
    expect(rows).toHaveLength(TASK_LIST_LIMIT);
    expect(rows.map((row) => row.shortId)).toEqual([
      "QH-BBBB",
      "QH-CCCC",
      "QH-DDDD",
      "QH-EEEE",
      "QH-AAAA",
    ]);
    expect(rows[0]).toMatchObject({
      ordinal: 1,
      statusText: "正在执行",
      stageText: "运行测试",
      freshnessText: "连接中断，正在协调",
      unreadMarker: true,
    });
    expect(JSON.stringify(rows)).not.toMatch(UUID);
    expect(resolveOrdinal(rows, 2)?.shortId).toBe("QH-CCCC");
    expect(resolveOrdinal(rows, 6)).toBeNull();
  });
});

describe("task detail presentation", () => {
  it("inspects through get_task and keeps the body within 600 characters", () => {
    const fixture = load("inspect-running.json");
    const steps = fixture.turns[0]?.steps ?? [];
    expect(
      steps.some(
        (step) => step.kind === "mcp_call" && step.tool === "get_task",
      ),
    ).toBe(true);
    const detail = steps.find(
      (step) => step.kind === "ui_call" && step.tool === "UiTool.all_text",
    );
    const linesOf =
      detail?.kind === "ui_call" ? (detail.payload.lines ?? []) : [];
    const body = linesOf.join("\n");
    expect([...body].length).toBeLessThanOrEqual(MAX_DETAIL_CHARACTERS);
    expect(body).toContain("状态：正在执行");
    expect(body).not.toMatch(UUID);
    expect(body).not.toMatch(/[%％]/u);
  });

  it("renders the offline and empty-event fallbacks without fabricated progress", () => {
    const detail = renderDetail(
      {
        repositoryDisplayName: "Novelty API",
        shortId: "QH-6C1F",
        status: "running",
        freshness: "offline",
        updatedAt: "2026-10-29T09:48:00.000Z",
        events: [],
      },
      { now: NOW },
    );
    expect(detail).toContain(FRESHNESS_TEXT.offline);
    expect(detail).toContain(EMPTY_EVENTS_TEXT);
    expect(detail).not.toMatch(/正在进行|运行中|已完成 5/u);
  });

  it("keeps at most five redacted event summaries and drops the oldest first", () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      summary:
        "步骤 " +
        (index + 1) +
        " 使用令牌 " +
        ["Bearer", "abcdefgh1234"].join(" ") +
        " 访问 https://internal.example.com/x",
      occurredAt: new Date(
        Date.parse(NOW) - (9 - index) * 60_000,
      ).toISOString(),
      jobId: `123e4567-e89b-42d3-a456-42661417400${index}`,
    }));
    const summaries = renderEventSummaries(events);
    expect(summaries).toHaveLength(MAX_EVENT_SUMMARIES);
    expect(summaries[0]).toContain("步骤 4");
    expect(summaries.at(-1)).toContain("步骤 8");
    for (const summary of summaries) {
      expect(summary).not.toMatch(UUID);
      expect(summary).not.toContain("Bearer");
      expect(summary).not.toContain("https://");
    }
  });
});

describe("result and artifact presentation", () => {
  it("uses all_text for a text result with changed files and test summary", () => {
    const fixture = load("result-text.json");
    const steps = fixture.turns[0]?.steps ?? [];
    const ui = steps.find(
      (step) => step.kind === "ui_call" && step.tool === "UiTool.all_text",
    );
    const body =
      ui?.kind === "ui_call" ? (ui.payload.lines ?? []).join("\n") : "";
    expect(body).toContain("改动文件");
    expect(body).toContain("测试：42 项通过");
    expect(body).not.toMatch(/https:\/\//u);
  });

  it("renders one allowed HTTPS image and falls back to text otherwise", () => {
    const now = "2026-10-29T10:00:00.000Z";
    const image = {
      summary: "构建完成",
      changedFiles: ["src/app.ts"],
      images: [
        {
          url: "https://artifacts.example.com/run/1.png",
          mediaType: "image/png",
          expiresAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    };
    expect(renderResult(image, { now })).toMatchObject({
      kind: "image",
      url: "https://artifacts.example.com/run/1.png",
    });

    const fallbacks = [
      {
        ...image,
        images: [
          ...(image.images ?? []),
          {
            ...(image.images?.[0] ?? {}),
            url: "https://artifacts.example.com/run/2.png",
          },
        ],
      },
      {
        ...image,
        images: [
          {
            url: [
              "file:",
              "///",
              ["", "Users", "alice", "run.png"].join("/"),
            ].join(""),
            mediaType: "image/png",
            expiresAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
      {
        ...image,
        images: [
          {
            url: "http://artifacts.example.com/run/1.png",
            mediaType: "image/png",
            expiresAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
      {
        ...image,
        images: [
          {
            url: "https://artifacts.example.com/run/1.png",
            mediaType: "image/png",
            expiresAt: "2026-10-29T09:00:00.000Z",
          },
        ],
      },
      {
        ...image,
        images: [
          {
            url: "https://artifacts.example.com/run/1.bin",
            mediaType: "application/zip",
            expiresAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
    ];
    for (const candidate of fallbacks) {
      const rendered = renderResult(candidate, { now });
      expect(rendered.kind).toBe("text");
      if (rendered.kind === "text") {
        expect(rendered.fallbackReason).toBeTruthy();
        expect(rendered.lines.join("\n")).not.toContain(
          "artifacts.example.com",
        );
      }
    }
  });

  it("keeps the image fixture and its fallback turn in the documented order", () => {
    const fixture = load("result-image.json");
    const tools = fixture.turns.map((turn) =>
      turn.steps
        .filter((step) => step.kind === "ui_call")
        .map((step) => (step.kind === "ui_call" ? step.tool : "")),
    );
    expect(tools[0]).toEqual(["UiTool.pic_and_text"]);
    expect(tools[1]).toEqual(["UiTool.all_text"]);
  });
});

describe("speech presentation", () => {
  it("keeps every fixture TTS within 120 characters and free of file lists or URLs", () => {
    for (const stem of fixtureStems) {
      const fixture = load(`${stem}.json`);
      for (const turn of fixture.turns) {
        for (const step of turn.steps) {
          if (step.kind !== "tts") continue;
          expect([...step.text].length).toBeLessThanOrEqual(MAX_TTS_CHARACTERS);
          expect(step.text).not.toMatch(/\.ts\b|\.json\b|https:\/\//u);
          expect(step.text).not.toMatch(/[%％]/u);
        }
      }
    }
  });

  it("uses deterministic templates instead of free-form paraphrases", () => {
    expect(renderTts({ shortId: "QH-7M2P", status: "queued" })).toBe(
      "任务 QH-7M2P 已创建，等待 Mac 接单",
    );
    expect(
      renderTts({ shortId: "QH-7M2P", status: "running", stage: "运行测试" }),
    ).toBe("任务 QH-7M2P 正在执行，阶段：运行测试");
    expect(renderTts({ shortId: "QH-7M2P", status: "succeeded" })).toBe(
      "任务 QH-7M2P 已完成，结果已显示",
    );
    for (const status of Object.keys(STATUS_TEXT) as Array<
      keyof typeof STATUS_TEXT
    >) {
      const speech = renderTts({ shortId: "QH-7M2P", status });
      expect([...speech].length).toBeLessThanOrEqual(MAX_TTS_CHARACTERS);
    }
  });
});
