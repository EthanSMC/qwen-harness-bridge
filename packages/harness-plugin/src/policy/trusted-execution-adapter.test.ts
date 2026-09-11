import { describe, expect, it } from "vitest";
import {
  createTrustedExecutionAdapter,
  DECLARED_TOOL_ROLES,
} from "./trusted-execution-adapter.js";

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

  it("maps a simple command to executable, argv and composition identity", () => {
    const resolved = adapter()({
      name: "bash",
      arguments: { command: "git status --short" },
    });
    expect(resolved?.provenance).toBe("local_tool");
    expect(resolved?.action.executable).toBe("git");
    expect(resolved?.action.argv).toEqual(["status", "--short"]);
    expect(resolved?.action.cwd).toBe("/repo/example");
    expect(resolved?.action.repositoryId).toBe("example");
    expect(resolved?.action.touchedPaths).toEqual([]);
  });

  it("ignores repository identity supplied in tool arguments", () => {
    const resolved = adapter()({
      name: "bash",
      arguments: { command: "git status", repositoryId: "other" },
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
      touchedPaths: ["src/a.ts"],
      fileChange: "none",
    });
    expect(
      a({ name: "write", arguments: { path: "src/a.ts" } })?.action.fileChange,
    ).toBe("bounded");
    expect(
      a({
        name: "edit",
        arguments: { path: "src/a.ts", old_string: "a", new_string: "b" },
      })?.action.fileChange,
    ).toBe("bounded");
    expect(
      a({ name: "grep", arguments: { pattern: "x", path: "src" } })?.action,
    ).toMatchObject({
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
