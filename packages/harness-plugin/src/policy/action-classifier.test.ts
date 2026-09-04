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
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalActionJson,
  canonicalizeAction,
  classifyAction,
  fingerprintAction,
} from "./action-classifier.js";
import type { CanonicalAction, RepositoryPolicy } from "./types.js";

const temporaryDirectories: string[] = [];

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-policy-classifier-"));
  const repositoryPath = join(directory, "repository");
  const outsidePath = join(directory, "outside");
  mkdirSync(repositoryPath);
  mkdirSync(join(repositoryPath, "src"));
  mkdirSync(outsidePath);
  writeFileSync(join(repositoryPath, "src", "index.ts"), "export {};\n");
  writeFileSync(join(outsidePath, "secret.txt"), "not for the repository\n");
  temporaryDirectories.push(directory);

  const repository: RepositoryPolicy = {
    id: "repo-one",
    canonicalPath: realpathSync(repositoryPath),
  };
  return {
    directory,
    repository,
    outsidePath: realpathSync(outsidePath),
    sourcePath: join(repository.canonicalPath, "src", "index.ts"),
  };
};

const makeAction = (
  fixture: ReturnType<typeof makeFixture>,
  overrides: Partial<CanonicalAction> = {},
): CanonicalAction => ({
  toolName: "read_file",
  argv: [fixture.sourcePath],
  cwd: fixture.repository.canonicalPath,
  repositoryId: fixture.repository.id,
  touchedPaths: [fixture.sourcePath],
  environmentRead: "none",
  networkIntent: "none",
  fileChange: "none",
  externalSideEffect: "none",
  ...overrides,
});

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      recursive: true,
      force: true,
    });
  }
});

describe("classifyAction", () => {
  it.each([
    ["file read", { toolName: "read_file" }],
    ["search", { toolName: "search" }],
    ["tests", { toolName: "test", executable: "pnpm", argv: ["test"] }],
    ["builds", { toolName: "build", executable: "pnpm", argv: ["build"] }],
    [
      "bounded edits",
      { toolName: "edit_file", fileChange: "bounded" as const },
    ],
  ])("classifies %s as automatic", (_label, overrides) => {
    const fixture = makeFixture();

    const decision = classifyAction(makeAction(fixture, overrides), [
      fixture.repository,
    ]);

    expect(decision.classification).toBe("automatic");
  });

  it.each([
    ["package install", { executable: "pnpm", argv: ["install"] }],
    ["git push", { executable: "git", argv: ["push", "origin", "main"] }],
    [
      "absolute git push",
      { executable: "/usr/bin/git", argv: ["push", "origin", "main"] },
    ],
    ["deploy", { externalSideEffect: "deploy" as const }],
    ["network write", { networkIntent: "write" as const }],
    ["external message", { externalSideEffect: "message" as const }],
    ["destructive edit", { fileChange: "destructive" as const }],
  ])("classifies %s as approval_required", (_label, overrides) => {
    const fixture = makeFixture();

    const decision = classifyAction(makeAction(fixture, overrides), [
      fixture.repository,
    ]);

    expect(decision.classification).toBe("approval_required");
  });

  it.each([
    [
      "arbitrary cloud command",
      { toolName: "shell", commandSource: "cloud" as const },
    ],
    ["arbitrary shell interpreter", { toolName: "run", executable: "bash" }],
    ["Keychain access", { toolName: "keychain" }],
    [
      "absolute Keychain executable",
      { executable: "/usr/bin/security", argv: ["find-generic-password"] },
    ],
    [
      "absolute system-settings executable",
      { executable: "/usr/bin/defaults", argv: ["write", "x", "y"] },
    ],
    [
      "secret/environment dump",
      { toolName: "env", argv: ["printenv", "SECRET_TOKEN"] },
    ],
    ["system settings", { executable: "defaults", argv: ["write", "x", "y"] }],
    [
      "absolute path outside root",
      { touchedPaths: ["/tmp/not-a-repository-file"] },
    ],
    ["dot-dot traversal", { toolName: "traversal_fixture" }],
  ])("classifies %s as denied", (_label, overrides) => {
    const fixture = makeFixture();
    const resolvedOverrides =
      _label === "dot-dot traversal"
        ? {
            ...overrides,
            touchedPaths: [
              `${fixture.repository.canonicalPath}/src/../secret.txt`,
            ],
          }
        : overrides;

    const decision = classifyAction(makeAction(fixture, resolvedOverrides), [
      fixture.repository,
    ]);

    expect(decision.classification).toBe("denied");
  });

  it("denies a symlink escape even when the lexical path is inside", () => {
    const fixture = makeFixture();
    const linkPath = join(
      fixture.repository.canonicalPath,
      "src",
      "linked.txt",
    );
    symlinkSync(join(fixture.outsidePath, "secret.txt"), linkPath);

    const decision = classifyAction(
      makeAction(fixture, { touchedPaths: [linkPath] }),
      [fixture.repository],
    );

    expect(decision.classification).toBe("denied");
  });

  it("canonicalizes equivalent paths before fingerprinting", () => {
    const fixture = makeFixture();
    const first = canonicalizeAction(
      makeAction(fixture, { cwd: fixture.repository.canonicalPath }),
      [fixture.repository],
    );
    const second = canonicalizeAction(
      makeAction(fixture, {
        cwd: `${fixture.repository.canonicalPath}/./`,
        touchedPaths: [`${fixture.repository.canonicalPath}/src/./index.ts`],
      }),
      [fixture.repository],
    );

    expect(fingerprintAction(first.action)).toBe(
      fingerprintAction(second.action),
    );
    expect(canonicalActionJson(first.action)).toBe(
      canonicalActionJson(second.action),
    );
  });

  it("changes the fingerprint when material arguments change", () => {
    const fixture = makeFixture();
    const first = makeAction(fixture, { executable: "pnpm", argv: ["test"] });
    const second = makeAction(fixture, { executable: "pnpm", argv: ["build"] });

    expect(fingerprintAction(first)).not.toBe(fingerprintAction(second));
  });

  it("changes the fingerprint when command provenance changes", () => {
    const fixture = makeFixture();
    const local = makeAction(fixture, { commandSource: "local" });
    const cloud = makeAction(fixture, { commandSource: "cloud" });

    expect(fingerprintAction(local)).not.toBe(fingerprintAction(cloud));
  });

  it("does not include human summaries in the canonical fingerprint", () => {
    const fixture = makeFixture();
    const first = makeAction(fixture);
    const second = {
      ...makeAction(fixture),
      actionSummary: "different wording",
    };

    expect(fingerprintAction(first)).toBe(fingerprintAction(second));
  });

  it("fails closed for a non-structured action at the classifier boundary", () => {
    const fixture = makeFixture();

    expect(
      classifyAction(null, { repositories: [fixture.repository] }),
    ).toMatchObject({
      classification: "denied",
      reasonCode: "UNSTRUCTURED_ACTION",
    });
  });
});
