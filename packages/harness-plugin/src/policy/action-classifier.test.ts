import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const executableDirectory = join(directory, "bin");
  mkdirSync(repositoryPath);
  mkdirSync(join(repositoryPath, "src"));
  mkdirSync(outsidePath);
  mkdirSync(executableDirectory);
  for (const executable of [
    "bash",
    "curl",
    "defaults",
    "find",
    "git",
    "grep",
    "npm",
    "npm-cli.js",
    "npx",
    "npx-cli.js",
    "pnpm",
    "pnpm.mjs",
    "python3",
    "rg",
    "rm",
    "security",
    "tsc",
    "vercel",
    "vitest",
  ]) {
    writeFileSync(join(executableDirectory, executable), "test executable\n", {
      mode: 0o755,
    });
  }
  writeFileSync(join(repositoryPath, "src", "index.ts"), "export {};\n");
  writeFileSync(join(outsidePath, "secret.txt"), "not for the repository\n");
  writeFileSync(join(outsidePath, "ordinary.txt"), "outside data\n");
  temporaryDirectories.push(directory);
  vi.stubEnv("PATH", executableDirectory);

  const repository: RepositoryPolicy = {
    id: "repo-one",
    canonicalPath: realpathSync(repositoryPath),
  };
  return {
    directory,
    executableDirectory,
    repository,
    outsidePath: realpathSync(outsidePath),
    outsideDataPath: join(realpathSync(outsidePath), "ordinary.txt"),
    sourcePath: join(repository.canonicalPath, "src", "index.ts"),
  };
};

const trustedOptions = (fixture: ReturnType<typeof makeFixture>) => ({
  repositories: [fixture.repository],
  trustedExecutables: Object.fromEntries(
    readdirSync(fixture.executableDirectory).map((name) => [
      name,
      realpathSync(join(fixture.executableDirectory, name)),
    ]),
  ),
});

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

const makeExecutableAlias = (
  fixture: ReturnType<typeof makeFixture>,
  targetName: string,
): { aliasPath: string; targetPath: string } => {
  const executableDirectory = join(fixture.directory, `bin-${targetName}`);
  mkdirSync(executableDirectory);
  const targetPath = join(executableDirectory, targetName);
  const aliasPath = join(executableDirectory, `alias-${targetName}`);
  writeFileSync(targetPath, "test executable\n");
  symlinkSync(targetPath, aliasPath);
  return { aliasPath, targetPath };
};

const makeBareExecutableAlias = (
  fixture: ReturnType<typeof makeFixture>,
  aliasName: string,
  targetName: string,
): void => {
  rmSync(join(fixture.executableDirectory, aliasName), { force: true });
  symlinkSync(
    join(fixture.executableDirectory, targetName),
    join(fixture.executableDirectory, aliasName),
  );
};

afterEach(() => {
  vi.unstubAllEnvs();
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

    const decision = classifyAction(
      makeAction(fixture, overrides),
      trustedOptions(fixture),
    );

    expect(decision.classification).toBe("automatic");
  });

  it.each([
    ["matched ripgrep search", "search", "rg", ["needle", "src"]],
    ["matched grep search", "grep", "grep", ["needle", "src"]],
    ["pnpm test", "test", "pnpm", ["test", "--runInBand"]],
    ["npm test", "test", "npm", ["test", "--", "unit"]],
    ["pnpm build", "build", "pnpm", ["build"]],
    ["npm run build", "build", "npm", ["run", "build"]],
    ["direct Vitest", "test", "vitest", ["run"]],
    ["direct TypeScript build", "build", "tsc", ["--noEmit"]],
  ])(
    "classifies coherent %s identity and argv as automatic",
    (_label, toolName, executable, argv) => {
      const fixture = makeFixture();

      const decision = classifyAction(
        makeAction(fixture, { toolName, executable, argv }),
        trustedOptions(fixture),
      );

      expect(decision.classification).toBe("automatic");
    },
  );

  it.each([
    ["read_file with /bin/rm", "read_file", "/bin/rm", []],
    ["read_file with /usr/bin/curl", "read_file", "/usr/bin/curl", []],
    ["read_file with bare npx", "read_file", "npx", ["vitest"]],
    ["read_file with npm exec", "read_file", "npm", ["exec", "vitest"]],
    ["search with a package manager", "search", "pnpm", ["build"]],
    ["test with a search executable", "test", "rg", ["needle"]],
    ["test with an arbitrary script", "test", "pnpm", ["run", "postinstall"]],
    ["test runner shell escape", "test", "pnpm", ["test", "&&", "rm"]],
    ["build with npm exec", "build", "npm", ["exec", "tsc"]],
    ["ripgrep preprocessor", "search", "rg", ["--pre=cat", "needle"]],
    ["find exec form", "find", "find", [".", "-exec", "rm", "{}", "+"]],
    ["unresolved bare executable", "read_file", "not-on-path", []],
  ])(
    "denies incoherent or unresolved executable: %s",
    (_label, toolName, executable, argv) => {
      const fixture = makeFixture();

      const decision = classifyAction(
        makeAction(fixture, { toolName, executable, argv }),
        trustedOptions(fixture),
      );

      expect(decision.classification).toBe("denied");
    },
  );

  it("resolves a bare allowlisted spelling before matching its identity", () => {
    const fixture = makeFixture();
    const options = trustedOptions(fixture);
    makeBareExecutableAlias(fixture, "rg", "rm");

    const decision = classifyAction(
      makeAction(fixture, {
        toolName: "search",
        executable: "rg",
        argv: ["needle", "src"],
      }),
      options,
    );

    expect(decision.classification).toBe("denied");
  });

  it.each([
    ["test", ["test"]],
    ["build", ["build"]],
  ])("denies %s without a resolved runner identity", (toolName, argv) => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { toolName, executable: undefined, argv }),
      trustedOptions(fixture),
    );

    expect(decision.classification).toBe("denied");
  });

  it.each([
    ["pnpm wrapper", "pnpm", "pnpm.mjs", "test", ["test"], "automatic"],
    [
      "npm wrapper",
      "npm",
      "npm-cli.js",
      "read_file",
      ["ci"],
      "approval_required",
    ],
    [
      "npx wrapper",
      "npx",
      "npx-cli.js",
      "read_file",
      ["vercel", "deploy"],
      "approval_required",
    ],
  ])(
    "classifies canonical package-manager implementation identity: %s",
    (_label, alias, target, toolName, argv, expected) => {
      const fixture = makeFixture();
      makeBareExecutableAlias(fixture, alias, target);

      const decision = classifyAction(
        makeAction(fixture, { toolName, executable: alias, argv }),
        trustedOptions(fixture),
      );

      expect(decision.classification).toBe(expected);
    },
  );

  it.each([
    ["package install", { executable: "pnpm", argv: ["install"] }],
    ["npm ci", { executable: "npm", argv: ["ci"] }],
    ["git push", { executable: "git", argv: ["push", "origin", "main"] }],
    [
      "absolute git push",
      { executable: "/usr/bin/git", argv: ["push", "origin", "main"] },
    ],
    ["Vercel deploy", { executable: "vercel", argv: ["deploy"] }],
    ["deploy", { externalSideEffect: "deploy" as const }],
    ["network write", { networkIntent: "write" as const }],
    ["external message", { externalSideEffect: "message" as const }],
    ["destructive edit", { fileChange: "destructive" as const }],
  ])("classifies %s as approval_required", (_label, overrides) => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, overrides),
      trustedOptions(fixture),
    );

    expect(decision.classification).toBe("approval_required");
  });

  it.each([
    ["arbitrary shell interpreter", { toolName: "run", executable: "bash" }],
    ["unknown tool", { toolName: "reviewer_unknown_tool" }],
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
    [
      "Python environment dump",
      {
        executable: "python3",
        argv: ["-c", "import os; print(os.environ)"],
      },
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

    const decision = classifyAction(
      makeAction(fixture, resolvedOverrides),
      trustedOptions(fixture),
    );

    expect(decision.classification).toBe("denied");
  });

  it("denies a command whose trusted provenance is cloud supplied", () => {
    const fixture = makeFixture();

    const decision = classifyAction(makeAction(fixture), [fixture.repository], {
      provenance: "cloud_command",
    });

    expect(decision).toMatchObject({
      classification: "denied",
      reasonCode: "ARBITRARY_COMMAND",
    });
  });

  it("denies incomplete action metadata instead of defaulting side effects", () => {
    const fixture = makeFixture();
    const { externalSideEffect: _omitted, ...incomplete } = makeAction(fixture);

    const decision = classifyAction(incomplete, [fixture.repository]);

    expect(decision).toMatchObject({
      classification: "denied",
      reasonCode: "UNSTRUCTURED_ACTION",
    });
  });

  it("denies an outside repository path carried only in argv", () => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { argv: [fixture.outsideDataPath] }),
      [fixture.repository],
    );

    expect(decision.classification).toBe("denied");
  });

  it("denies an outside repository file URL carried only in argv", () => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { argv: [`file://${fixture.outsideDataPath}`] }),
      [fixture.repository],
    );

    expect(decision.classification).toBe("denied");
  });

  it.each([
    [
      "absolute outside path",
      (fixture: ReturnType<typeof makeFixture>) => `-C${fixture.outsidePath}`,
      "PATH_OUTSIDE_REPOSITORY",
    ],
    ["relative traversal", () => "-C../outside", "PATH_TRAVERSAL"],
    ["missing attached value", () => "-C", "PATH_UNAVAILABLE"],
    ["equals-prefixed value", () => "-C=../outside", "PATH_UNAVAILABLE"],
    ["network URL", () => "-Chttps://example.com/archive", "PATH_UNAVAILABLE"],
    [
      "other short option with outside path",
      (fixture: ReturnType<typeof makeFixture>) => `-I${fixture.outsidePath}`,
      "PATH_OUTSIDE_REPOSITORY",
    ],
    [
      "other short option with traversal",
      () => "-o../outside",
      "PATH_TRAVERSAL",
    ],
    [
      "outside file URL",
      (fixture: ReturnType<typeof makeFixture>) =>
        `-Cfile://${fixture.outsidePath}`,
      "PATH_OUTSIDE_REPOSITORY",
    ],
  ])(
    "denies malformed or outside BSD tar attached -C form: %s",
    (_label, argumentFor, reasonCode) => {
      const fixture = makeFixture();

      const decision = classifyAction(
        makeAction(fixture, { argv: [argumentFor(fixture)] }),
        trustedOptions(fixture),
      );

      expect(decision).toMatchObject({ classification: "denied", reasonCode });
    },
  );

  it("canonicalizes a safe attached -C path without changing its option spelling", () => {
    const fixture = makeFixture();

    const canonical = canonicalizeAction(
      makeAction(fixture, {
        argv: [`-C${fixture.repository.canonicalPath}/src/./`],
      }),
      trustedOptions(fixture),
    );

    expect(canonical).toMatchObject({
      action: { argv: [`-C${join(fixture.repository.canonicalPath, "src")}`] },
      violations: [],
    });
  });

  it("canonicalizes a visibly path-bearing attached short option", () => {
    const fixture = makeFixture();

    const canonical = canonicalizeAction(
      makeAction(fixture, {
        argv: [`-I${fixture.repository.canonicalPath}/src/./`],
      }),
      trustedOptions(fixture),
    );

    expect(canonical).toMatchObject({
      action: { argv: [`-I${join(fixture.repository.canonicalPath, "src")}`] },
      violations: [],
    });
  });

  it("denies an outside path in the split -C form", () => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { argv: ["-C", fixture.outsidePath] }),
      trustedOptions(fixture),
    );

    expect(decision).toMatchObject({
      classification: "denied",
      reasonCode: "PATH_OUTSIDE_REPOSITORY",
    });
  });

  it.each([
    ["pnpm install", "pnpm", ["install"], "approval_required"],
    ["Keychain", "security", ["find-generic-password"], "denied"],
    ["system settings", "defaults", ["write", "x", "y"], "denied"],
  ])(
    "resolves a symlinked executable alias for %s",
    (_label, targetName, argv, expected) => {
      const fixture = makeFixture();
      const { aliasPath } = makeExecutableAlias(fixture, targetName);

      const decision = classifyAction(
        makeAction(fixture, { executable: aliasPath, argv }),
        [fixture.repository],
      );

      expect(decision.classification).toBe(expected);
    },
  );

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

  it("canonicalizes path-bearing argv before fingerprinting", () => {
    const fixture = makeFixture();
    const first = classifyAction(
      makeAction(fixture, { argv: [fixture.sourcePath] }),
      [fixture.repository],
    );
    const second = classifyAction(
      makeAction(fixture, {
        argv: [`${fixture.repository.canonicalPath}/src/./index.ts`],
      }),
      [fixture.repository],
    );

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("changes the fingerprint when material arguments change", () => {
    const fixture = makeFixture();
    const first = makeAction(fixture, { executable: "pnpm", argv: ["test"] });
    const second = makeAction(fixture, { executable: "pnpm", argv: ["build"] });

    expect(fingerprintAction(first)).not.toBe(fingerprintAction(second));
  });

  it("changes the fingerprint when command provenance changes", () => {
    const fixture = makeFixture();
    const action = makeAction(fixture);
    const local = classifyAction(action, [fixture.repository], {
      provenance: "local_tool",
    });
    const cloud = classifyAction(action, [fixture.repository], {
      provenance: "cloud_command",
    });

    expect(local.fingerprint).not.toBe(cloud.fingerprint);
  });

  it("fails closed for malformed trusted provenance", () => {
    const fixture = makeFixture();
    let decision: ReturnType<typeof classifyAction> | undefined;

    expect(
      () =>
        (decision = classifyAction(
          makeAction(fixture),
          [fixture.repository],
          null as never,
        )),
    ).not.toThrow();
    expect(decision).toMatchObject({
      classification: "denied",
      reasonCode: "UNTRUSTED_ACTION",
    });
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
