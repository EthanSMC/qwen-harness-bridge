import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAction } from "./action-classifier.js";
import {
  createTrustedExecutionAdapter,
  DECLARED_TOOL_ROLES,
} from "./trusted-execution-adapter.js";

const fixtureRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const adapter = () =>
  createTrustedExecutionAdapter({
    repositoryId: "example",
    repositoryRoot: "/repo/example",
  });

describe("trusted execution adapter", () => {
  it("declares a minimal explicit tool set", () => {
    expect(Object.keys(DECLARED_TOOL_ROLES).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });

  it("maps a declared command to its canonical policy tool", () => {
    const resolved = adapter()({
      name: "bash",
      arguments: { command: "pnpm test" },
    });
    expect(resolved?.provenance).toBe("local_tool");
    expect(resolved?.action.toolName).toBe("test");
    expect(resolved?.action.executable).toBe("pnpm");
    expect(resolved?.action.argv).toEqual(["test"]);
    expect(resolved?.action.cwd).toBe("/repo/example");
    expect(resolved?.action.repositoryId).toBe("example");
    expect(resolved?.action.touchedPaths).toEqual([]);
  });

  it("maps approval commands and refuses unmappable commands", () => {
    const a = adapter();
    expect(
      a({ name: "bash", arguments: { command: "git push origin main" } })
        ?.action.toolName,
    ).toBe("git_push");
    expect(
      a({ name: "bash", arguments: { command: "pnpm install left-pad" } })
        ?.action.toolName,
    ).toBe("package_install");
    expect(
      a({ name: "bash", arguments: { command: "git status" } }),
    ).toBeUndefined();
  });

  it("ignores repository identity supplied in tool arguments", () => {
    const resolved = adapter()({
      name: "bash",
      arguments: { command: "pnpm test", repositoryId: "other" },
    });
    expect(resolved?.action.repositoryId).toBe("example");
  });

  it.each([
    "echo hi | sh",
    "git status && rm -rf /",
    "FOO=bar git status",
    "cat $(secret)",
    "echo `cmd`",
    "   ",
  ])("fails closed on an ambiguous command: %s", (command) => {
    expect(adapter()({ name: "bash", arguments: { command } })).toBeUndefined();
  });

  it("maps read, write, edit, grep and glob to truthful effects", () => {
    const a = adapter();
    expect(
      a({ name: "read", arguments: { path: "src/a.ts" } })?.action,
    ).toMatchObject({
      toolName: "read",
      touchedPaths: ["src/a.ts"],
      fileChange: "none",
    });
    expect(
      a({ name: "write", arguments: { path: "src/a.ts" } })?.action,
    ).toMatchObject({ toolName: "write_file", fileChange: "bounded" });
    expect(
      a({
        name: "edit",
        arguments: { path: "src/a.ts", old_string: "a", new_string: "b" },
      })?.action,
    ).toMatchObject({ toolName: "edit_file", fileChange: "bounded" });
    expect(
      a({ name: "grep", arguments: { pattern: "x", path: "src" } })?.action,
    ).toMatchObject({
      toolName: "search",
      touchedPaths: ["src"],
      fileChange: "none",
    });
    expect(
      a({ name: "glob", arguments: { pattern: "*.ts" } })?.action.touchedPaths,
    ).toEqual([]);
  });

  it.each([
    ["subagent", { task: "x" }],
    ["bash", null],
    ["bash", []],
    ["bash", { command: 42 }],
    ["read", { path: 7 }],
  ])("fails closed for undeclared or malformed input: %s", (name, args) => {
    expect(adapter()({ name, arguments: args })).toBeUndefined();
  });
});

// The policy engine resolves trusted executables through the platform PATH and
// X_OK semantics; this fixture runs on the Linux required-CI runner.
describe.skipIf(process.platform === "win32")(
  "declared tool classification",
  () => {
    const fixture = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "qhb-adapter-")));
      fixtureRoots.push(root);
      const repository = join(root, "repository");
      const bin = join(root, "bin");
      mkdirSync(repository);
      mkdirSync(join(repository, "src"));
      mkdirSync(bin);
      const trustedExecutables: Record<string, string> = {};
      for (const name of ["pnpm", "git", "npm", "vercel", "vitest", "tsc"]) {
        const file = join(bin, name);
        writeFileSync(file, "fixture\n", { mode: 0o755 });
        trustedExecutables[name] = realpathSync(file);
      }
      vi.stubEnv("PATH", bin);
      const options = {
        repositories: [{ id: "example", canonicalPath: repository }],
        trustedExecutables,
        protectedPaths: { example: ["private-data"] },
      };
      const run = createTrustedExecutionAdapter({
        repositoryId: "example",
        repositoryRoot: repository,
      });
      return (name: string, args: unknown) => {
        const resolved = run({ name, arguments: args });
        if (resolved === undefined) return undefined;
        return classifyAction(resolved.action, options, {
          provenance: resolved.provenance,
        });
      };
    };

    it.each([
      ["read", { path: "src/a.ts" }],
      ["write", { path: "src/a.ts" }],
      ["edit", { path: "src/a.ts", old_string: "a", new_string: "b" }],
      ["grep", { pattern: "x", path: "src" }],
      ["glob", { pattern: "*.ts" }],
      ["bash", { command: "pnpm test" }],
      ["bash", { command: "pnpm build" }],
    ])("classifies %s as automatic", (name, args) => {
      expect(fixture()(name, args)?.classification).toBe("automatic");
    });

    it.each([
      ["bash", { command: "pnpm install left-pad" }],
      ["bash", { command: "git push origin main" }],
    ])("requires approval for %s", (name, args) => {
      expect(fixture()(name, args)?.classification).toBe("approval_required");
    });

    it("fails closed for undeclared tools", () => {
      expect(fixture()("subagent", { task: "x" })).toBeUndefined();
    });

    it("denies traversal outside the repository", () => {
      expect(fixture()("read", { path: "../outside.ts" })?.classification).toBe(
        "denied",
      );
    });
  },
);
