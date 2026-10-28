import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LIST_ITEMS,
  MAX_TTS_TEXT_LENGTH,
  MAX_VISIBLE_TEXT_LENGTH,
  MCP_TOOL_NAMES,
  MUTATION_TOOL_NAMES,
  PROTOCOL_TOOL_SCHEMA_SOURCES,
  parseMcpImport,
  parseSkillMetadata,
  parseTranscriptFixture,
  UI_TOOL_NAMES,
} from "./transcript-schema.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, relative), "utf8"));

const skillMetadata = () => readJson("skill.json");
const mcpImport = () => readJson("mcp.import.example.json");

const requestId = "3f2b6c8e-1d4a-4c9b-9f0e-2a7d5b3c1e8f";
const otherRequestId = "7a1c9e2d-5b3f-4a8c-8d1e-6c4b2a9f7e3d";

type LooseStep = Record<string, unknown>;
type LooseTurn = { request_id: string; steps: LooseStep[] };

const validTurn = (): LooseTurn => ({
  request_id: requestId,
  steps: [
    { kind: "user", text: "在眼镜任务台创建一个任务" },
    {
      kind: "mcp_call",
      tool: "submit_task",
      request_id: requestId,
      arguments: { repository_id: "demo-repo", request: "汇总今天的提交" },
    },
    {
      kind: "mcp_result",
      tool: "submit_task",
      request_id: requestId,
      ok: true,
      text: "任务 QH-7M2P 已创建。",
    },
    {
      kind: "ui_call",
      tool: "UiTool.list",
      request_id: otherRequestId,
      payload: {},
    },
    { kind: "tts", text: "任务 QH-7M2P 已创建。" },
    { kind: "assistant", text: "已完成提交，稍后用查看任务台跟进。" },
  ],
});

describe("skill package metadata", () => {
  it("declares the approved private zh-CN stable package contract", () => {
    const metadata = parseSkillMetadata(skillMetadata());
    expect(metadata).toEqual({
      name: "qwen-harness-bridge",
      display_name: "眼镜任务台",
      version: "0.3.0",
      visibility: "private",
      language: "zh-CN",
      stable_mode: true,
      rtc_mode: false,
      mcp_import: "mcp.import.example.json",
      transcript_schema: "src/transcript-schema.ts",
    });
  });

  it("keeps the skill SemVer synchronized with the pnpm package version", () => {
    const metadata = parseSkillMetadata(skillMetadata());
    const pkg = readJson("package.json") as {
      name?: unknown;
      version?: unknown;
    };
    expect(pkg.name).toBe("@qhb/qwen-skill");
    expect(pkg.version).toBe(metadata.version);
  });

  it("rejects a metadata document that enables RTC or leaves private visibility", () => {
    expect(() =>
      parseSkillMetadata({ ...(skillMetadata() as object), rtc_mode: true }),
    ).toThrow(/rtc_mode/i);
    expect(() =>
      parseSkillMetadata({
        ...(skillMetadata() as object),
        visibility: "public",
      }),
    ).toThrow(/visibility/i);
  });

  it("rejects a metadata document whose version is not synchronized SemVer", () => {
    expect(() =>
      parseSkillMetadata({ ...(skillMetadata() as object), version: "0.3" }),
    ).toThrow(/version/i);
  });
});

describe("seven-tool MCP import template", () => {
  it("declares exactly the seven approved tools on one remote HTTPS server", () => {
    const parsed = parseMcpImport(mcpImport());
    expect(parsed.servers).toHaveLength(1);
    const [server] = parsed.servers;
    expect(server.name).toBe("qwen-harness-bridge");
    expect(server.url).toBe("https://control-plane.example.com/mcp");
    expect(server.auth.type).toBe("bearer");
    expect(server.tools).toEqual([...MCP_TOOL_NAMES]);
    expect([...MCP_TOOL_NAMES]).toEqual([
      "submit_task",
      "list_tasks",
      "get_task",
      "cancel_task",
      "list_pending_approvals",
      "decide_approval",
      "get_task_result",
    ]);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(7);
  });

  it("keeps the seven tools aligned with the protocol input schemas", () => {
    expect(Object.keys(PROTOCOL_TOOL_SCHEMA_SOURCES)).toEqual([
      ...MCP_TOOL_NAMES,
    ]);
    for (const source of Object.values(PROTOCOL_TOOL_SCHEMA_SOURCES)) {
      const text = readFileSync(join(repositoryRoot, source.file), "utf8");
      expect(
        text.includes(`export const ${source.schema} =`),
        `${source.file} must export ${source.schema}`,
      ).toBe(true);
    }
  });

  it("keeps the seven tools aligned with the Control Plane MCP registration", () => {
    const toolsSource = readFileSync(
      join(repositoryRoot, "apps/control-plane/src/mcp/tools.ts"),
      "utf8",
    );
    const registered = [...toolsSource.matchAll(/server,\s*"([a-z_]+)"/gu)].map(
      (match) => match[1],
    );
    expect([...registered].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it("references the Bearer token through an environment secret, never a literal", () => {
    const raw = mcpImport() as {
      servers: { auth: { token_secret_ref: string } }[];
    };
    const parsed = parseMcpImport(raw);
    expect(raw.servers[0].auth.token_secret_ref).toMatch(
      /^\$\{QWEN_MCP_BEARER_TOKEN\}$/u,
    );
    expect(parsed.servers[0].auth.token_secret_ref).toBe(
      raw.servers[0].auth.token_secret_ref,
    );
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/u);
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]{32,}/u);
  });

  it("rejects an additional tool, a plaintext HTTP endpoint, or a literal token", () => {
    const extra = structuredClone(mcpImport()) as {
      servers: { tools: string[] }[];
    };
    extra.servers[0].tools.push("run_shell");
    expect(() => parseMcpImport(extra)).toThrow(/tool/i);

    const insecure = structuredClone(mcpImport()) as {
      servers: { url: string }[];
    };
    insecure.servers[0].url = "http://control-plane.example.com/mcp";
    expect(() => parseMcpImport(insecure)).toThrow(/https/i);

    const literal = structuredClone(mcpImport()) as {
      servers: { auth: { token_secret_ref: string } }[];
    };
    literal.servers[0].auth.token_secret_ref = "literal-token-not-a-reference";
    expect(() => parseMcpImport(literal)).toThrow(/secret/i);
  });
});

describe("transcript fixture schema", () => {
  it("accepts one well-formed turn with the six approved step kinds", () => {
    const fixture = parseTranscriptFixture({
      fixture_id: "submit-online",
      turns: [validTurn()],
    });
    expect(fixture.turns[0].steps.map((step) => step.kind)).toEqual([
      "user",
      "mcp_call",
      "mcp_result",
      "ui_call",
      "tts",
      "assistant",
    ]);
  });

  it("rejects a turn with more than one submit_task mutation", () => {
    const turn = validTurn();
    turn.steps.push({
      kind: "mcp_call",
      tool: "submit_task",
      request_id: otherRequestId,
      arguments: { repository_id: "demo-repo", request: "再建一个任务" },
    });
    expect(() =>
      parseTranscriptFixture({ fixture_id: "double-submit", turns: [turn] }),
    ).toThrow(/mutation/i);
  });

  it("rejects two different mutation targets in the same turn", () => {
    const turn = validTurn();
    turn.steps.push({
      kind: "mcp_call",
      tool: "cancel_task",
      request_id: otherRequestId,
      arguments: { job_id: requestId },
    });
    expect(() =>
      parseTranscriptFixture({ fixture_id: "two-mutations", turns: [turn] }),
    ).toThrow(/mutation/i);
  });

  it("rejects unknown MCP tools, unknown UI tools and non-UUID request ids", () => {
    expect(MUTATION_TOOL_NAMES.has("submit_task")).toBe(true);
    const unknownTool = validTurn();
    unknownTool.steps[1] = {
      kind: "mcp_call",
      tool: "run_shell",
      request_id: requestId,
      arguments: {},
    };
    expect(() =>
      parseTranscriptFixture({
        fixture_id: "unknown-tool",
        turns: [unknownTool],
      }),
    ).toThrow(/tool/i);

    const unknownUi = validTurn();
    unknownUi.steps[3] = {
      kind: "ui_call",
      tool: "UiTool.camera",
      request_id: otherRequestId,
    };
    expect(() =>
      parseTranscriptFixture({ fixture_id: "unknown-ui", turns: [unknownUi] }),
    ).toThrow(/tool/i);

    const badId = validTurn();
    badId.request_id = "not-a-uuid";
    expect(() =>
      parseTranscriptFixture({ fixture_id: "bad-id", turns: [badId] }),
    ).toThrow(/request_id/i);
  });

  it("bounds detail text, spoken TTS text and list rows", () => {
    const longDetail = validTurn();
    longDetail.steps[0] = {
      kind: "user",
      text: "长".repeat(MAX_VISIBLE_TEXT_LENGTH + 1),
    };
    expect(() =>
      parseTranscriptFixture({
        fixture_id: "long-detail",
        turns: [longDetail],
      }),
    ).toThrow(/text/i);

    const longSpeech = validTurn();
    longSpeech.steps[4] = {
      kind: "tts",
      text: "话".repeat(MAX_TTS_TEXT_LENGTH + 1),
    };
    expect(() =>
      parseTranscriptFixture({
        fixture_id: "long-speech",
        turns: [longSpeech],
      }),
    ).toThrow(/tts/i);

    const longList = validTurn();
    longList.steps[3] = {
      kind: "ui_call",
      tool: "UiTool.list",
      request_id: otherRequestId,
      payload: {
        lines: Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "行"),
      },
    };
    expect(() =>
      parseTranscriptFixture({ fixture_id: "long-list", turns: [longList] }),
    ).toThrow(/bound/i);

    const unknownKind = validTurn();
    unknownKind.steps.push({ kind: "camera", text: "look" });
    expect(() =>
      parseTranscriptFixture({
        fixture_id: "unknown-kind",
        turns: [unknownKind],
      }),
    ).toThrow();
  });

  it("keeps the approved UI tool names bounded to the documented three", () => {
    expect([...UI_TOOL_NAMES]).toEqual([
      "UiTool.list",
      "UiTool.all_text",
      "UiTool.pic_and_text",
    ]);
  });
});

describe("static skill lint", () => {
  const temporaryRoots: string[] = [];

  const lintScript = join(packageRoot, "scripts", "lint-skill.mjs");

  const copyPackage = (): string => {
    const root = mkdtempSync(join(tmpdir(), "qhb-skill-lint-"));
    temporaryRoots.push(root);
    for (const file of [
      "skill.json",
      "package.json",
      "mcp.import.example.json",
      "src/transcript-schema.ts",
    ]) {
      cpSync(join(packageRoot, file), join(root, file));
    }
    return root;
  };

  const runLint = (root: string) =>
    spawnSync(process.execPath, [lintScript], {
      encoding: "utf8",
      env: { ...process.env, QHB_SKILL_LINT_ROOT: root },
    });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the shipped package and reports the planned references as not yet present", () => {
    const result = runLint(copyPackage());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/SKILL\.md is not yet present/u);
    expect(result.stdout).toMatch(
      /references\/speech-contract\.md is not yet present/u,
    );
    expect(result.stdout).toMatch(/fixtures\/transcripts is not yet present/u);
  });

  it("fails when the metadata enables RTC", () => {
    const root = copyPackage();
    const path = join(root, "skill.json");
    const skill = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(path, JSON.stringify({ ...skill, rtc_mode: true }, null, 2));
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/rtc_mode/u);
  });

  it("fails when an eighth tool is imported", () => {
    const root = copyPackage();
    const path = join(root, "mcp.import.example.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      servers: { tools: string[] }[];
    };
    document.servers[0].tools.push("run_shell");
    writeFileSync(path, JSON.stringify(document, null, 2));
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not approved/u);
  });

  it("fails when a literal credential replaces the secret reference", () => {
    const root = copyPackage();
    const path = join(root, "mcp.import.example.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      servers: { auth: { token_secret_ref: string } }[];
    };
    document.servers[0].auth.token_secret_ref = "literal-token-not-a-reference";
    writeFileSync(path, JSON.stringify(document, null, 2));
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/secret/u);
  });

  it("fails for Windows and POSIX absolute local paths", () => {
    const paths = [
      ["C:", "Users", "someone", "project"].join("\\"),
      ["C:", "Users", "someone", "project"].join("/"),
      ["", "Users", "someone", "project"].join("/"),
      ["", "home", "someone", "project"].join("/"),
      ["", "root", "project"].join("/"),
    ];
    for (const localPath of paths) {
      const root = copyPackage();
      writeFileSync(
        join(root, "notes.md"),
        `local checkout lives at ${localPath}\n`,
      );
      const result = runLint(root);
      expect(result.status, localPath).toBe(1);
      expect(result.stderr, localPath).toMatch(/absolute local path/u);
    }
  });

  it("fails for Markdown- and CJK-wrapped or UNC absolute paths", () => {
    const backtick = String.fromCharCode(96);
    const backslash = String.fromCharCode(92);
    const fullWidthColon = String.fromCharCode(0xff1a);
    const posix = ["", "Users", "alice", "project"].join("/");
    const windowsBackslash = ["C:", "Users", "alice", "project"].join(
      backslash,
    );
    const cases = [
      backtick + posix + backtick,
      backtick + windowsBackslash + backtick,
      fullWidthColon + posix,
      backslash + backslash + ["server", "share", "file"].join(backslash),
      ["", "", "server", "share", "file"].join("/"),
      ["file:", "//", posix].join(""),
    ];
    for (const value of cases) {
      const root = copyPackage();
      writeFileSync(join(root, "notes.md"), `${value}\n`);
      const result = runLint(root);
      expect(result.status, value).toBe(1);
      expect(result.stderr, value).toMatch(/absolute local path/u);
    }
  });

  it("does not flag an ordinary https endpoint as an absolute path", () => {
    const root = copyPackage();
    writeFileSync(
      join(root, "notes.md"),
      "endpoint: https://control-plane.example.com/mcp\n",
    );
    const result = runLint(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails when a credential literal appears in the package", () => {
    const root = copyPackage();
    writeFileSync(
      join(root, "notes.md"),
      `authorization: ${["Bearer", "abcdefgh12345678"].join(" ")}\n`,
    );
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/credential literal/u);
  });

  it("fails when the package claims an unsupported push route", () => {
    const root = copyPackage();
    writeFileSync(join(root, "notes.md"), `${["后台", "推送"].join("")}\n`);
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/push route/u);
  });

  it("fails when an RTC route appears while rtc_mode is false", () => {
    const root = copyPackage();
    writeFileSync(
      join(root, "notes.md"),
      `${["rtc", "url: wss://example.com/rtc"].join("_")}\n`,
    );
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RTC route/u);
  });

  it("activates the SKILL.md front-matter rule as soon as the file lands", () => {
    const root = copyPackage();
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: qwen-harness-bridge\n---\n",
    );
    const result = runLint(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/front matter is missing/u);
  });
});