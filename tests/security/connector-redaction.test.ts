import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RedactionError,
  redactEvent,
} from "../../packages/harness-plugin/src/redaction/redact-event.js";

describe("connector public projection", () => {
  it("redacts source expressions and preserves ordinary URL prose", () => {
    for (const summary of [
      "synthetic.call({ value: 1 });",
      "return synthetic;",
      "#include <synthetic.h>",
    ]) {
      expect(redactEvent({ summary }, options).summary).toBe("[redacted]");
    }
    expect(
      redactEvent(
        { summary: "See https://example.test/report?q=synthetic#part" },
        options,
      ).summary,
    ).toBe("See https://example.test/report");
  });
  let root: string;
  let options: {
    repositoryRoot: string;
    homeDirectory: string;
    secrets?: readonly string[];
  };
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "qhb-redaction-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/file.ts"), "");
    options = { repositoryRoot: root, homeDirectory: "/Users/synthetic" };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const rejected = (input: unknown, opts = options) => {
    try {
      redactEvent(input, opts);
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(RedactionError);
      expect(error).toMatchObject({
        message: "CONNECTOR_EVENT_REJECTED",
        code: "CONNECTOR_EVENT_REJECTED",
      });
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
    }
  };
  it("preserves useful public fields and canonical deleted paths with isolated output", () => {
    const input = {
      summary: `Updated ${root}/src/file.ts`,
      stage: "testing",
      changed_files: [join(root, "src/file.ts"), "src/deleted.ts"],
      tests: { passed: 2, failed: 0, total: 3 },
      artifacts: [
        {
          name: "Test report",
          media_type: "text/html",
          url: "https://user:synthetic@example.test/report?q=synthetic#private",
        },
      ],
      tool_arguments: { private: "synthetic" },
    };
    const output = redactEvent(input, options);
    expect(output).toEqual({
      summary: "Updated src/file.ts",
      stage: "testing",
      changed_files: ["src/file.ts", "src/deleted.ts"],
      tests: { passed: 2, failed: 0, total: 3 },
      artifacts: [
        {
          name: "Test report",
          media_type: "text/html",
          url: "https://example.test/report",
        },
      ],
    });
    input.tests.passed = 99;
    input.changed_files[0] = "other";
    input.artifacts[0].name = "other";
    expect(output.tests?.passed).toBe(2);
    expect(output.changed_files?.[0]).toBe("src/file.ts");
    expect(output.artifacts?.[0].name).toBe("Test report");
    expect(() => JSON.stringify(output)).not.toThrow();
  });
  it.each([
    "line one\nline two",
    "const synthetic = 1;",
    "```ts synthetic ```",
    'tool arguments: {"synthetic":true}',
    "-----BEGIN PRIVATE KEY----- synthetic",
    "NODE_ENV=synthetic",
    "export SYNTHETIC_VALUE=sample",
  ])("redacts raw or private text %s", (summary) => {
    expect(redactEvent({ summary }, options).summary).toBe("[redacted]");
  });
  it.each([
    "Bearer syntheticcredential",
    "Basic c3ludGhldGljOnNhbXBsZQ==",
    "api_key=synthetic",
    "token: synthetic",
    "ghp_synthetic123456789",
    "sk-synthetic123456789",
    "eyJsynthetic.abcdefgh.ijklmnop",
  ])("removes complete credentials %s", (summary) => {
    expect(redactEvent({ summary }, options).summary).toBe("[redacted]");
  });
  it("redacts explicit secrets longest first, homes, URLs and private paths", () => {
    expect(
      redactEvent(
        {
          summary:
            "synthetic-long synthetic /Users/synthetic/private /etc/private https://user:pass@example.test/path?q=private#part",
        },
        { ...options, secrets: ["synthetic", "synthetic-long"] },
      ).summary,
    ).not.toMatch(/synthetic|private|user:pass|\?q=/);
    expect(
      redactEvent({ summary: "/Users/synthetic/private" }, options).summary,
    ).toBe("[home]");
  });
  it("inspects suffixes before code-point-safe truncation", () => {
    const summary = redactEvent(
      { summary: "界😀".repeat(100) },
      options,
    ).summary;
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(500);
    expect(summary).not.toContain("�");
    expect(
      redactEvent(
        { summary: `${"x".repeat(600)}\nconst synthetic = 1;` },
        options,
      ).summary,
    ).toBe("[redacted]");
    expect(redactEvent({ summary: "\u0000\u0007 " }, options).summary).toBe(
      "[redacted]",
    );
  });
  it("validates all changed files before keeping fifty", () => {
    const files = Array.from({ length: 51 }, (_, i) => `src/file-${i}.ts`);
    expect(
      redactEvent({ summary: "Done", changed_files: files }, options)
        .changed_files,
    ).toHaveLength(50);
    rejected({ summary: "Done", changed_files: [...files, "../escape"] });
    rejected({ summary: "Done", changed_files: Array(10001).fill("a") });
  });
  it("rejects unsafe and oversized paths without fabricating names", () => {
    writeFileSync(join(root, "synthetic-secret.ts"), "");
    symlinkSync(join(root, "synthetic-secret.ts"), join(root, "safe-link"));
    rejected(
      { summary: "Done", changed_files: ["safe-link"] },
      { ...options, secrets: ["synthetic-secret"] },
    );
    symlinkSync(tmpdir(), join(root, "escape"));
    for (const path of [
      "../escape",
      root,
      "/etc/private",
      "escape/outside",
      "C:\\private",
      "\\\\host\\file",
      "a\nb",
      "token=synthetic",
      "a".repeat(501),
      "",
    ])
      rejected({ summary: "Done", changed_files: [path] });
  });
  it("never invokes accessors and drops unknown values", () => {
    let reads = 0;
    const input = {
      summary: "Done",
      get private() {
        reads++;
        throw new Error("synthetic");
      },
    };
    expect(redactEvent(input, options)).toEqual({ summary: "Done" });
    rejected({
      get summary() {
        reads++;
        return "Done";
      },
    });
    expect(reads).toBe(0);
    rejected(Object.defineProperty({}, "summary", { value: "Done" }));
  });
  it("rejects malformed permitted structures", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const input of [
      null,
      [],
      new Date(),
      Object.assign(Object.create({}), { summary: "Done" }),
      { summary: undefined },
      {
        summary: "Done",
        toJSON() {
          return {};
        },
      },
      { summary: "Done", [Symbol("synthetic")]: true },
      { summary: "Done", changed_files: Array(2) },
      { summary: "Done", changed_files: cyclic },
      { summary: "Done", tests: { passed: 0, failed: 0, extra: true } },
      {
        summary: "Done",
        artifacts: [
          {
            name: "Report",
            media_type: "text/plain",
            url: "https://example.test",
            extra: true,
          },
        ],
      },
    ])
      rejected(input);
    for (const passed of [
      -1,
      0.5,
      Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
    ])
      rejected({ summary: "Done", tests: { passed, failed: 0 } });
    rejected({
      summary: "Done",
      tests: { passed: Number.MAX_SAFE_INTEGER, failed: 1 },
    });
    rejected({ summary: "Done", tests: { passed: 2, failed: 1, total: 2 } });
    for (const stage of ["A", "x".repeat(65), undefined])
      rejected({ summary: "Done", stage });
  });
  it("rejects malformed or private artifact metadata", () => {
    for (const url of [
      "file:///private",
      "not a URL",
      "https://example.test/\nprivate",
      `https://example.test/${"x".repeat(501)}`,
      "https://example.test/sk-synthetic123456789",
    ])
      rejected({
        summary: "Done",
        artifacts: [{ name: "Report", media_type: "text/plain", url }],
      });
    for (const media_type of ["invalid", `text/${"x".repeat(128)}`])
      rejected({
        summary: "Done",
        artifacts: [
          { name: "Report", media_type, url: "https://example.test" },
        ],
      });
    rejected({
      summary: "Done",
      artifacts: Array(33).fill({
        name: "Report",
        media_type: "text/plain",
        url: "https://example.test",
      }),
    });
  });
  it("enforces inspection and secret budgets", () => {
    rejected({ summary: "x".repeat(65537) });
    rejected({
      summary: "Done",
      changed_files: Array(10000).fill("x".repeat(300)),
    });
    for (const secrets of [
      Array(65).fill("synthetic"),
      [""],
      ["x".repeat(4097)],
    ])
      rejected({ summary: "Done" }, { ...options, secrets });
  });
});
