import { JobSummarySchema } from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import {
  presentJobDetail,
  presentJobList,
  presentPendingApprovals,
  presentTaskResult,
  truncateUnicode,
} from "./presenters.js";

const now = "2026-09-01T00:00:00.000Z";
const repository = {
  displayName: "Novelty Studio",
  canonicalPath: "/Users/alice/Repositories/novelty-studio",
};

const job = (overrides: Record<string, unknown> = {}) => ({
  jobId: "11111111-1111-4111-8111-111111111111",
  shortId: "QH-7M2P",
  ownerId: "owner-a",
  repositoryId: "novelty-studio",
  status: "running" as const,
  currentStage: "running",
  revision: 4,
  title: "修复登录流程",
  unreadTerminal: false,
  updatedAt: new Date(now),
  connectorHealth: "fresh" as const,
  harnessAgentId: "internal-agent-id-must-not-leak",
  databaseId: "database-id-must-not-leak",
  ...overrides,
});

const events = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index + 1}-must-not-leak`,
    sequence: index + 1,
    type: "progress",
    payload: {
      stage: `阶段 ${index + 1}`,
      changed_files: [
        "/Users/alice/Repositories/novelty-studio/src/index.ts",
        "/private/other-owner/secret.env",
      ],
      log: "raw connector log must not become public detail text",
    },
    createdAt: new Date(Date.parse(now) + index * 1000),
  }));

const assertNoUnpairedSurrogates = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
      expect(value.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
      index += 1;
    } else {
      expect(code < 0xdc00 || code > 0xdfff).toBe(true);
    }
  }
};

describe("presenters", () => {
  it("bounds lists to five public summaries and strips internal identifiers", () => {
    const output = presentJobList(
      Array.from({ length: 8 }, (_, index) =>
        job({
          shortId: `QH-${String(index).padStart(4, "0")}`,
          title: `任务 ${index}`,
          currentStage: `阶段 ${index}`,
          updatedAt: new Date(Date.parse(now) + index * 1000),
        }),
      ),
    );

    expect(output).toHaveLength(5);
    for (const item of output) {
      expect(JobSummarySchema.parse(item)).toEqual(item);
      expect(item).not.toHaveProperty("harness_agent_id");
      expect(item).not.toHaveProperty("database_id");
    }
    expect(JSON.stringify(output)).not.toContain(
      "internal-agent-id-must-not-leak",
    );
  });

  it("truncates titles and stages by Unicode code point without splitting emoji", () => {
    const output = presentJobList([
      job({
        title: "😀界".repeat(30),
        currentStage: "🚦准备".repeat(30),
      }),
    ])[0];

    expect(Array.from(output.title).length).toBeLessThanOrEqual(40);
    expect(Array.from(output.current_stage).length).toBeLessThanOrEqual(36);
    assertNoUnpairedSurrogates(output.title);
    assertNoUnpairedSurrogates(output.current_stage);
  });

  it("keeps only the recent five events in chronological order and redacts absolute paths", () => {
    const detail = presentJobDetail({
      job: job({ currentStage: "正在执行" }),
      repository,
      events: events(8),
      pendingApproval: null,
      terminalSummary: null,
    });

    expect(detail.recent_events).toHaveLength(5);
    expect(
      detail.recent_events.map((event: { sequence: number }) => event.sequence),
    ).toEqual([4, 5, 6, 7, 8]);
    expect(JSON.stringify(detail)).toContain("src/index.ts");
    expect(JSON.stringify(detail)).not.toContain(repository.canonicalPath);
    expect(JSON.stringify(detail)).not.toContain(
      "/private/other-owner/secret.env",
    );
    expect(JSON.stringify(detail)).not.toContain(
      "raw connector log must not become public detail text",
    );
  });

  it("bounds detail text to 600 code points and preserves surrogate pairs", () => {
    const detail = presentJobDetail({
      job: job({
        title: "😀".repeat(50),
        currentStage: "🚦".repeat(50),
      }),
      repository,
      events: Array.from({ length: 8 }, (_, index) => ({
        sequence: index + 1,
        type: "progress",
        payload: { detail: "进度😀".repeat(200) },
        createdAt: new Date(now),
      })),
      pendingApproval: null,
      terminalSummary: { summary: "结果😀".repeat(200) },
    });

    expect(Array.from(detail.text).length).toBeLessThanOrEqual(600);
    assertNoUnpairedSurrogates(detail.text);
  });

  it("keeps approval and result presenters bounded and path-relative", () => {
    const approvals = presentPendingApprovals(
      Array.from({ length: 8 }, (_, index) => ({
        approvalId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
        jobShortId: "QH-7M2P",
        jobRevision: 3,
        actionSummary: "安装 /private/other-owner/package.tgz",
        impactSummary:
          "修改 /Users/alice/Repositories/novelty-studio/package.json",
        riskClass: "approval_required",
        expiresAt: new Date("2026-09-01T00:05:00.000Z"),
      })),
    );
    const result = presentTaskResult(
      {
        summary: "完成😀".repeat(100),
        changedFiles: [
          "/Users/alice/Repositories/novelty-studio/src/index.ts",
          "/private/other-owner/private.key",
        ],
        tests: { passed: 12, failed: 0, summary: "12 passed" },
        artifacts: [
          {
            name: "report.html",
            mediaType: "text/html",
            url: "https://example.test/report",
          },
        ],
        acknowledgedAt: new Date(now),
      },
      repository,
    );

    expect(approvals).toHaveLength(5);
    expect(JSON.stringify(approvals)).not.toContain("/private/other-owner");
    expect(JSON.stringify(approvals)).not.toContain("/Users/alice");
    expect(Array.from(result.summary).length).toBeLessThanOrEqual(120);
    expect(result.changed_files).toContain("src/index.ts");
    expect(JSON.stringify(result)).not.toContain(repository.canonicalPath);
    expect(JSON.stringify(result)).not.toContain(
      "/private/other-owner/private.key",
    );
    assertNoUnpairedSurrogates(result.summary);
  });

  it("publishes only bounded HTTPS artifact URLs without credentials or URL metadata", () => {
    const result = presentTaskResult({
      summary: "Report ready",
      changedFiles: [],
      tests: { passed: 1, failed: 0, summary: "1 passed" },
      artifacts: [
        {
          name: "HTTP report",
          mediaType: "text/html",
          url: "http://example.test/report",
        },
        {
          name: "Local report",
          mediaType: "text/html",
          url: "file:///private/reports/result.html",
        },
        {
          name: "Inline report",
          mediaType: "text/html",
          url: "data:text/html,secret",
        },
        {
          name: "Credential report",
          mediaType: "text/html",
          url: "https://reader:password@example.test/report",
        },
        {
          name: "Signed report",
          mediaType: "text/html",
          url: "https://example.test/report?X-Amz-Credential=credential&X-Amz-Signature=secret",
        },
        {
          name: "Fragment report",
          mediaType: "text/html",
          url: "https://example.test/report#token",
        },
        {
          name: "Absolute local report",
          mediaType: "text/html",
          url: "/private/reports/result.html",
        },
        {
          name: "Malformed report",
          mediaType: "text/html",
          url: "not a URL",
        },
        {
          name: "Malformed percent report",
          mediaType: "text/html",
          url: "https://example.test/%ZZ",
        },
        {
          name: "Oversized report",
          mediaType: "text/html",
          url: `https://example.test/${"a".repeat(2050)}`,
        },
        {
          name: "Public report",
          mediaType: "text/html",
          url: "https://example.test/report",
        },
      ],
      acknowledgedAt: new Date(now),
    });

    expect(result.artifacts).toEqual([
      {
        name: "Public report",
        media_type: "text/html",
        url: "https://example.test/report",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /reader|password|X-Amz|credential|secret|file:|data:|\/private/,
    );
  });

  it("redacts secrets and raw logs from every public free-text field", () => {
    const detail = presentJobDetail({
      job: job(),
      repository,
      events: [
        {
          sequence: 1,
          type: "progress",
          payload: {
            detail:
              "Deploying token=event-token credential=event-credential Authorization: Bearer auth-token",
            log: "raw log: password=ignored-log-password",
            request: "secret=ignored-request-secret",
          },
          createdAt: new Date(now),
        },
        {
          sequence: 2,
          type: "progress",
          payload: {
            detail:
              "RAW-LOG: credential=raw-log-credential internal stack trace",
          },
          createdAt: new Date(now),
        },
      ],
      pendingApproval: null,
      terminalSummary:
        "Completed password=terminal-password secret=terminal-secret Bearer terminal-bearer",
    });
    const approvals = presentPendingApprovals([
      {
        approvalId: "22222222-2222-4222-8222-222222222222",
        jobShortId: "QH-7M2P",
        jobRevision: 3,
        actionSummary:
          "Install dependency api-key=approval-api-key credential=approval-credential",
        impactSummary:
          "raw log: password=approval-log-password internal details",
        riskClass: "approval_required",
        expiresAt: new Date("2026-09-01T00:05:00.000Z"),
      },
    ]);
    const result = presentTaskResult({
      summary: "Ordinary success token=result-token",
      changedFiles: [],
      tests: {
        passed: 12,
        failed: 0,
        summary: "12 passed Authorization=Bearer test-bearer",
      },
      artifacts: [
        {
          name: "Public report credential=artifact-credential",
          mediaType: "credential=artifact-media-secret",
          url: "https://example.test/report",
        },
      ],
      acknowledgedAt: new Date(now),
    });

    const serialized = JSON.stringify({ detail, approvals, result });
    expect(serialized).not.toMatch(
      /event-token|event-credential|auth-token|ignored-log-password|ignored-request-secret|raw-log-credential|terminal-password|terminal-secret|terminal-bearer|approval-api-key|approval-credential|approval-log-password|result-token|test-bearer|artifact-credential|artifact-media-secret/,
    );
    expect(result.artifacts[0]?.media_type).toBe("application/octet-stream");
    expect(serialized).not.toContain("internal stack trace");
    expect(serialized).not.toContain("internal details");
    expect(serialized).toContain("Ordinary success");
    expect(serialized).toContain("12 passed");
    expect(serialized).toContain("Install dependency");
    expect(serialized).toContain("[redacted");
  });

  it("fails closed for Unicode, spaced, quoted, and Windows absolute paths", () => {
    const detail = presentJobDetail({
      job: job(),
      repository,
      events: [
        {
          sequence: 1,
          type: "progress",
          payload: {
            detail: '读取 "/Users/张三/Novelty Studio/秘密 文件.txt" 后继续',
          },
          createdAt: new Date(now),
        },
        {
          sequence: 2,
          type: "progress",
          payload: {
            detail: "打开 C:\\Users\\张三\\Novelty Studio\\密钥 文件.txt",
          },
          createdAt: new Date(now),
        },
      ],
      pendingApproval: null,
      terminalSummary: "Copied /Volumes/团队 资料/秘密 文件.txt",
    });
    const approvals = presentPendingApprovals([
      {
        approvalId: "22222222-2222-4222-8222-222222222222",
        jobShortId: "QH-7M2P",
        jobRevision: 3,
        actionSummary:
          "Review '/private/项目 空间/隐藏 配置.env' before approval",
        impactSummary: "Writes \\\\server\\团队 资料\\机密 文件.txt",
        riskClass: "approval_required",
        expiresAt: new Date("2026-09-01T00:05:00.000Z"),
      },
    ]);
    const result = presentTaskResult(
      {
        summary: "Finished at /tmp/构建 输出/报告 文件.txt",
        changedFiles: [
          "/Users/alice/Repositories/novelty-studio/文档/设计 稿.md",
          "/Users/alice/Repositories/novelty-studio/../other/secret.txt",
          "/private/其他 用户/秘密 文件.txt",
          "C:\\Users\\张三\\private.key",
        ],
        tests: {
          passed: 1,
          failed: 0,
          summary: 'Read "D:\\Build Output\\测试 日志.txt"',
        },
        artifacts: [
          {
            name: "Report /private/构建 输出/报告.html",
            mediaType: "text/html",
            url: "https://example.test/report",
          },
        ],
        acknowledgedAt: new Date(now),
      },
      repository,
    );

    const serialized = JSON.stringify({ detail, approvals, result });
    expect(result.changed_files).toEqual(["文档/设计 稿.md"]);
    expect(serialized).not.toMatch(
      /\/Users\/张三|\/Volumes\/团队|\/private\/项目|\\\\server|C:\\\\Users|D:\\\\Build|\/tmp\/构建|\/private\/构建|秘密 文件|密钥 文件|机密 文件|测试 日志/,
    );
    expect(serialized).toContain("读取");
    expect(serialized).toContain("后继续");
    expect(serialized).toContain("[redacted path]");
  });

  it("truncates arbitrary Unicode text without producing lone surrogates", () => {
    const value = truncateUnicode("😀中文🚦".repeat(100), 40);

    expect(Array.from(value).length).toBeLessThanOrEqual(40);
    assertNoUnpairedSurrogates(value);
  });
});
