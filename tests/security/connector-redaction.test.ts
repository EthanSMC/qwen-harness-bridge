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
  it.each([
    "export BUILD_ENDPOINT=$(printf syntheticprivatevalue)",
    "export build_endpoint=$(printf syntheticprivatevalue)",
    "export Build_Endpoint=$'synthetic\\' privatevalue'",
    "export BUILD_ENDPOINT=$'synthetic\\' privatevalue'",
    "Before x=`printf syntheticprivatevalue` after",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: synthetic shell syntax must remain literal data.
    "Before x=${synthetic:-private value} after",
    "Before x=$((synthetic + 1)) after",
    "Before x=(synthetic privatevalue) after",
    'Before x="synthetic privatevalue',
    "Before x='synthetic privatevalue",
    "Before x=synthetic\\",
  ])(
    "N3 falls back for unsupported or unclosed assignment values in both fields: %s",
    (value) => {
      const output = redactEvent(
        {
          summary: value,
          artifacts: [
            {
              name: value,
              media_type: "text/plain",
              url: "https://example.test/report",
            },
          ],
        },
        { ...options, secrets: [] },
      );
      expect(output.summary).toBe("[redacted]");
      expect(output.artifacts?.[0].name).toBe("[redacted]");
    },
  );
  it("N3 preserves supported complete words and sanitized removed URL components", () => {
    const value = "Before x='synthetic'private\\ value after";
    const url = "https://example.test/report?x=$(synthetic)#x=$'synthetic'";
    const output = redactEvent(
      {
        summary: value,
        artifacts: [{ name: value, media_type: "text/plain", url }],
      },
      options,
    );
    expect(output.summary).toBe("Before [redacted] after");
    expect(output.artifacts?.[0].name).toBe("Before [redacted] after");
    expect(output.artifacts?.[0].url).toBe("https://example.test/report");
    expect(redactEvent({ summary: `See ${url}` }, options).summary).toBe(
      "See https://example.test/report",
    );
  });
  it("N3 validates retained URL syntax and inspects complex suffixes before truncation", () => {
    for (const url of [
      "https://example.test/x=$(synthetic)",
      "https://example.test/%24%7Bsynthetic%7D",
      "https://example.test/`synthetic`",
    ]) {
      rejected({
        summary: "Done",
        artifacts: [{ name: "Report", media_type: "text/plain", url }],
      });
      expect(redactEvent({ summary: `See ${url}` }, options).summary).toBe(
        "See [redacted]",
      );
    }
    const value = `${"Safe prose ".repeat(60)}x=$(printf syntheticprivatevalue)`;
    const output = redactEvent(
      {
        summary: value,
        artifacts: [
          {
            name: value,
            media_type: "text/plain",
            url: "https://example.test/report",
          },
        ],
      },
      options,
    );
    expect(output.summary).toBe("[redacted]");
    expect(output.artifacts?.[0].name).toBe("[redacted]");
  });
  it("N3 strips encoded complex URL components without inspecting them as assignments", () => {
    const url =
      "https://x%3D%24%28synthetic%29@example.test/report?x=%24%7Bsynthetic%7D#x=%60synthetic%60";
    const output = redactEvent(
      {
        summary: `See ${url}`,
        artifacts: [{ name: `See ${url}`, media_type: "text/plain", url }],
      },
      options,
    );
    expect(output.summary).toBe("See https://example.test/report");
    expect(output.artifacts?.[0].name).toBe("See https://example.test/report");
    expect(output.artifacts?.[0].url).toBe("https://example.test/report");
  });
  it.each([
    ["export build_endpoint=syntheticprivatevalue", "[redacted]"],
    ["export Build_Endpoint='synthetic private value'", "[redacted]"],
    ["Updated x=syntheticvalue safely", "Updated [redacted] safely"],
    ["Updated _=syntheticvalue safely", "Updated [redacted] safely"],
    ["Updated _Build=syntheticvalue safely", "Updated [redacted] safely"],
    [
      "Updated build_endpoint='synthetic'private safely",
      "Updated [redacted] safely",
    ],
    ["Updated x=synthetic\\ private safely", "Updated [redacted] safely"],
    ["Failed token=syntheticcredential", "Failed [redacted]"],
    ["export BUILD_ENDPOINT=syntheticprivatevalue", "[redacted]"],
  ])(
    "N1 removes case-independent assignments in both human fields: %s",
    (value, expected) => {
      const output = redactEvent(
        {
          summary: value,
          artifacts: [
            {
              name: value,
              media_type: "text/plain",
              url: "https://example.test/report",
            },
          ],
        },
        { ...options, secrets: [] },
      );
      expect(output.summary).toBe(expected);
      expect(output.artifacts?.[0].name).toBe(expected);
    },
  );
  it("N1 preserves sanitized URLs with assignments only in stripped components", () => {
    const url =
      "https://example.test/report?BUILD_ENDPOINT=syntheticprivatevalue&home=synthetic#x=synthetic";
    const output = redactEvent(
      {
        summary: `See ${url}`,
        artifacts: [{ name: `See ${url}`, media_type: "text/plain", url }],
      },
      options,
    );
    expect(output.summary).toBe("See https://example.test/report");
    expect(output.artifacts?.[0].name).toBe("See https://example.test/report");
    expect(output.artifacts?.[0].url).toBe("https://example.test/report");
  });
  it.each([
    ["abcdef", ["abc", "bcdef"], "[redacted]"],
    ["abcdef", ["bcdef", "abc"], "[redacted]"],
    ["abcdefgh", ["abc", "cde", "efgh"], "[redacted]"],
    ["abcdef", ["abc", "def"], "[redacted][redacted]"],
    ["abcdef", ["ab", "abc"], "[redacted]def"],
    ["Useful ordinary prose", ["abc", "bcdef"], "Useful ordinary prose"],
  ] as const)(
    "N2 unions overlapping original secrets in both human fields: %s / %j",
    (value, secrets, expected) => {
      const output = redactEvent(
        {
          summary: value,
          artifacts: [
            {
              name: value,
              media_type: "text/plain",
              url: "https://example.test/report",
            },
          ],
        },
        { ...options, secrets },
      );
      expect(output.summary).toBe(expected);
      expect(output.artifacts?.[0].name).toBe(expected);
    },
  );
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
  it.each([
    'Request failed: {"token":"syntheticcredential"}',
    'Report {"password":"syntheticcredential"}',
    'Result: {"synthetic":"body"}',
    'Result: ["synthetic", "body"]',
  ])("F1 redacts embedded bodies in summary and artifact name: %s", (value) => {
    const output = redactEvent(
      {
        summary: value,
        artifacts: [
          {
            name: value,
            media_type: "text/plain",
            url: "https://example.test/report",
          },
        ],
      },
      options,
    );
    expect(output.summary).toBe("[redacted]");
    expect(output.artifacts?.[0].name).toBe("[redacted]");
  });
  it.each([
    ["Failed token=syntheticcredential", "token", "Failed [redacted]"],
    ["Failed Bearer syntheticcredential", "Bearer", "Failed [redacted]"],
    ["first\nsecond", "\n", "[redacted]"],
  ])(
    "F2 detects original private constructs in both human fields: %s",
    (value, secret, expected) => {
      const output = redactEvent(
        {
          summary: value,
          artifacts: [
            {
              name: value,
              media_type: "text/plain",
              url: "https://example.test/report",
            },
          ],
        },
        { ...options, secrets: [secret] },
      );
      expect(output.summary).toBe(expected);
      expect(output.artifacts?.[0].name).toBe(expected);
    },
  );
  it.each(["dir\\name", "line\u2028name", "line\u2029name"])(
    "F3 rejects canonical symlink filename characters: %s",
    (name) => {
      mkdirSync(join(root, name));
      symlinkSync(join(root, name), join(root, "slash-alias"));
      rejected({ summary: "Done", changed_files: ["slash-alias/deleted.ts"] });
    },
  );
  it("F4 rejects secrets in original retained URL components before normalization", () => {
    rejected(
      {
        summary: "Done",
        artifacts: [
          {
            name: "Report",
            media_type: "text/plain",
            url: "https://SYNTHETICSECRET.example.test/report",
          },
        ],
      },
      { ...options, secrets: ["SYNTHETICSECRET"] },
    );
  });
  it("F4 keeps useful URLs when secrets occur only in removed components", () => {
    const url =
      "https://SYNTHETICSECRET:SYNTHETICSECRET@example.test/report?q=SYNTHETICSECRET#SYNTHETICSECRET";
    const output = redactEvent(
      {
        summary: `See ${url}`,
        artifacts: [{ name: "Report", media_type: "text/plain", url }],
      },
      { ...options, secrets: ["SYNTHETICSECRET"] },
    );
    expect(output.summary).toBe("See https://example.test/report");
    expect(output.artifacts?.[0].url).toBe("https://example.test/report");
  });
  it("F5 gives canonical repository paths precedence over their home prefix", () => {
    const repositoryRoot = join(root, "repository");
    mkdirSync(repositoryRoot);
    mkdirSync(join(repositoryRoot, "src"));
    writeFileSync(join(repositoryRoot, "src/file.ts"), "");
    symlinkSync(join(repositoryRoot, "src"), join(repositoryRoot, "alias"));
    expect(
      redactEvent(
        { summary: `Updated ${repositoryRoot}/alias/file.ts` },
        { repositoryRoot, homeDirectory: root },
      ).summary,
    ).toBe("Updated src/file.ts");
  });
  it("F6 never rescans generated markers with sixteen duplicate short secrets", () => {
    expect(
      redactEvent(
        { summary: "Done" },
        { ...options, secrets: Array(16).fill("e") },
      ).summary,
    ).toBe("Don[redacted]");
  });
  it("F6 handles all sixty-four duplicate and overlapping secrets within the text bound", () => {
    expect(
      redactEvent(
        { summary: "Done" },
        { ...options, secrets: Array(64).fill("e") },
      ).summary,
    ).toBe("Don[redacted]");
    expect(
      redactEvent(
        { summary: "abc Done" },
        {
          ...options,
          secrets: ["a", "ab", "abc", "[redacted]", ...Array(60).fill("e")],
        },
      ).summary,
    ).toBe("[redacted] Don[redacted]");
    expect(
      redactEvent(
        { summary: "e".repeat(65536) },
        { ...options, secrets: Array(64).fill("e") },
      ).summary,
    ).toBe("[redacted]".repeat(50));
  });
  it("F1 removes quoted credential assignments without discarding safe prose", () => {
    const value = 'Failed "token":"syntheticcredential"';
    const output = redactEvent(
      {
        summary: value,
        artifacts: [
          {
            name: value,
            media_type: "text/plain",
            url: "https://example.test/report",
          },
        ],
      },
      options,
    );
    expect(output.summary).toBe("Failed [redacted]");
    expect(output.artifacts?.[0].name).toBe("Failed [redacted]");
  });
  it("F4 inspects retained paths before dot-segment and percent normalization", () => {
    for (const url of [
      "https://example.test/SYNTHETICSECRET/../report",
      "https://example.test/%53YNTHETICSECRET",
    ]) {
      rejected(
        {
          summary: "Done",
          artifacts: [{ name: "Report", media_type: "text/plain", url }],
        },
        { ...options, secrets: ["SYNTHETICSECRET"] },
      );
      expect(
        redactEvent(
          { summary: `See ${url}` },
          { ...options, secrets: ["SYNTHETICSECRET"] },
        ).summary,
      ).toBe("See [redacted]");
    }
  });
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
