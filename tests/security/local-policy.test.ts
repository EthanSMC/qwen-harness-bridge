import childProcess, { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "../../packages/harness-plugin/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  createScope,
  scopeTarget,
} from "../../packages/harness-plugin/node_modules/@deepseek-ai/dsh-scope/lib/index.js";
import {
  type ToolExecution,
  ToolRuntime,
} from "../../packages/harness-plugin/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
import { ApprovalService } from "../../packages/harness-plugin/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js";
import {
  type ActionPolicyOptions,
  canonicalizeAction,
  classifyAction,
} from "../../packages/harness-plugin/src/policy/action-classifier.js";
import {
  canonicalizePath,
  recheckCanonicalPath,
} from "../../packages/harness-plugin/src/policy/canonical-path.js";
import {
  createPolicyAgentSetup,
  type PolicyGuardRegistrationOptions,
  registerPolicyGuard,
  type TrustedPolicyAction,
} from "../../packages/harness-plugin/src/policy/register-guard.js";
import type {
  CanonicalAction,
  RepositoryPolicy,
} from "../../packages/harness-plugin/src/policy/types.js";

const temporaryDirectories: string[] = [];
// Mandatory interoperability prerequisite: fail visibly if the real rg is absent.
const actualRipgrep = realpathSync(
  execFileSync("which", ["rg"], { encoding: "utf8" }).trim(),
);

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-local-policy-"));
  const repositoryPath = join(directory, "repository");
  const outsidePath = join(directory, "outside");
  const executableDirectory = join(directory, "bin");
  mkdirSync(repositoryPath);
  mkdirSync(outsidePath);
  mkdirSync(executableDirectory);
  for (const executable of [
    "pnpm",
    "npm",
    "git",
    "vercel",
    "grep",
    "rg",
    "rm",
    "python",
    "python3",
    "python3.12",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
  ]) {
    writeFileSync(join(executableDirectory, executable), "test executable\n", {
      mode: 0o755,
    });
  }
  copyFileSync(actualRipgrep, join(executableDirectory, "rg"));
  chmodSync(join(executableDirectory, "rg"), 0o755);
  writeFileSync(join(repositoryPath, "source.txt"), "nonsecret fixture\n");
  temporaryDirectories.push(directory);
  vi.stubEnv("PATH", executableDirectory);
  return {
    directory,
    executableDirectory,
    repositoryPath,
    outsidePath,
    repository: {
      id: "repo-one",
      canonicalPath: realpathSync(repositoryPath),
    } satisfies RepositoryPolicy,
  };
};

const makeAction = (
  fixture: ReturnType<typeof makeFixture>,
  overrides: Partial<CanonicalAction> = {},
): CanonicalAction => ({
  toolName: "read_file",
  argv: [],
  cwd: fixture.repository.canonicalPath,
  repositoryId: fixture.repository.id,
  touchedPaths: [],
  environmentRead: "none",
  networkIntent: "none",
  fileChange: "none",
  externalSideEffect: "none",
  ...overrides,
});

describe("accepted complete-range findings", () => {
  const commandFixture = () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.repositoryPath, "src"));
    writeFileSync(
      join(fixture.repositoryPath, "src", "keychain.ts"),
      "export const token = 'example';\n",
    );
    for (const name of [
      ".env",
      ".npmrc",
      "id_rsa",
      ".env.example",
      "credential.ts",
      "password.txt",
      "private-data",
    ]) {
      writeFileSync(
        join(fixture.repositoryPath, name),
        "nonsecret test fixture\n",
      );
    }
    symlinkSync(fixture.outsidePath, join(fixture.repositoryPath, "linked"));
    const trustedExecutables: Record<string, string> = {};
    for (const name of ["rg", "grep", "tsc", "vitest", "pnpm"]) {
      const file = join(fixture.executableDirectory, name);
      writeFileSync(file, "fixture\n", { mode: 0o755 });
      if (name === "rg") copyFileSync(actualRipgrep, file);
      trustedExecutables[name] = realpathSync(file);
    }
    return {
      ...fixture,
      options: {
        repositories: [fixture.repository],
        trustedExecutables,
        protectedPaths: { "repo-one": ["private-data"] },
      },
    };
  };

  it.each([
    ["--", "--files", "src"],
    ["-e", "--files", "src"],
    ["-e/api/v1", "src"],
    ["--regexp=.", "src"],
  ])("preserves option-like and attached regex data %j", (...argv) => {
    const f = commandFixture();
    const action = makeAction(f, {
      toolName: "search",
      executable: "rg",
      argv,
    });
    expect(classifyAction(action, f.options).classification).toBe("automatic");
    expect(canonicalizeAction(action, f.options).action.argv).toEqual([
      ...argv.slice(0, -1),
      join(f.repository.canonicalPath, "src"),
    ]);
  });

  it("rejects an outside custom test reporter entrypoint", () => {
    const f = commandFixture();
    expect(
      classifyAction(
        makeAction(f, {
          toolName: "test",
          executable: "vitest",
          argv: ["run", "--reporter", join(f.outsidePath, "reporter.js")],
        }),
        f.options,
      ).classification,
    ).toBe("denied");
  });

  it.each(["rg", "grep"])(
    "does not read protected files through a %s directory search",
    (executable) => {
      const f = commandFixture();
      const argv =
        executable === "rg"
          ? ["--hidden", "needle", "."]
          : ["-r", "needle", "."];
      expect(
        classifyAction(
          makeAction(f, { toolName: "search", executable, argv }),
          f.options,
        ).classification,
      ).toBe("denied");
    },
  );

  it("matches configured protected paths through an alias and retains a registration snapshot", async () => {
    const f = commandFixture();
    symlinkSync(
      join(f.repositoryPath, "private-data"),
      join(f.repositoryPath, "alias"),
    );
    expect(
      classifyAction(makeAction(f, { argv: ["alias"] }), f.options)
        .classification,
    ).toBe("denied");
    const { agentContext, guards } = makeAgentScope();
    const trusted = new WeakMap<object, TrustedPolicyAction>();
    installPolicy(agentContext, {
      ...f.options,
      resolveAction: (exec) => trusted.get(exec),
    });
    f.options.protectedPaths["repo-one"].splice(0);
    const action = makeAction(f, { argv: ["private-data"] });
    const execution = makeExecution(action);
    trustExecution(trusted, execution, action, f);
    expect(guards[0]?.(execution)).toMatch(/PROTECTED_RESOURCE/u);
  });

  it("protects the canonical target of a registered protected alias", () => {
    const f = commandFixture();
    symlinkSync(
      join(f.repositoryPath, "password.txt"),
      join(f.repositoryPath, "protected-alias"),
    );
    const options = {
      ...f.options,
      protectedPaths: { "repo-one": ["protected-alias"] },
    };
    expect(
      classifyAction(makeAction(f, { argv: ["password.txt"] }), options)
        .classification,
    ).toBe("denied");
  });

  it.each([
    ["rg", "search", ["needle", "linked"]],
    ["grep", "search", ["needle", "linked"]],
    ["grep", "search", ["-f", "linked"]],
    ["rg", "search", ["--file=linked"]],
    ["tsc", "build", ["--outDir", "linked"]],
    ["tsc", "build", ["--outDir=linked"]],
    ["tsc", "build", ["--project", "linked"]],
    ["rg", "search", ["-L", "--files", "."]],
    ["rg", "search", ["--follow", "needle", "."]],
    ["grep", "search", ["-R", "needle", "."]],
    ["grep", "search", ["--dereference-recursive", "needle", "."]],
    ["rg", "search", ["--unknown-path-option", "src"]],
  ])("F2/F3 reject %s %s %j", (executable, toolName, argv) => {
    const f = commandFixture();
    expect(
      classifyAction(makeAction(f, { executable, toolName, argv }), f.options)
        .classification,
    ).toBe("denied");
  });

  it.each([
    "/api/v1",
    ".",
    "credential",
    "token",
    "password",
    "$(example)",
    "`literal`",
  ])("F2/F6 preserve search data %s", (pattern) => {
    const f = commandFixture();
    const action = makeAction(f, {
      toolName: "search",
      executable: "rg",
      argv: [pattern, "src"],
    });
    const canonical = canonicalizeAction(action, f.options);
    expect(canonical.action.argv).toEqual([
      pattern,
      join(f.repository.canonicalPath, "src"),
    ]);
    expect(classifyAction(action, f.options).classification).toBe("automatic");
    expect(classifyAction(action, f.options).fingerprint).not.toBe(
      classifyAction(
        { ...action, argv: [f.repository.canonicalPath, "src"] },
        f.options,
      ).fingerprint,
    );
  });

  it.each([".env", ".npmrc", "id_rsa", "private-data"])(
    "F4 denies protected resource %s even with approval effects",
    (path) => {
      const f = commandFixture();
      for (const fileChange of ["none", "destructive"] as const) {
        expect(
          classifyAction(
            makeAction(f, { argv: [path], touchedPaths: [path], fileChange }),
            f.options,
          ).classification,
        ).toBe("denied");
      }
    },
  );

  it.each(["src/keychain.ts", ".env.example", "credential.ts", "password.txt"])(
    "F6 permits nonsecret source/example %s",
    (path) => {
      const f = commandFixture();
      expect(
        classifyAction(
          makeAction(f, { argv: [path], touchedPaths: [path] }),
          f.options,
        ).classification,
      ).toBe("automatic");
    },
  );

  it("F5 requires approval for compiler clean", () => {
    const f = commandFixture();
    expect(
      classifyAction(
        makeAction(f, {
          toolName: "build",
          executable: "tsc",
          argv: ["--build", "--clean"],
        }),
        f.options,
      ),
    ).toMatchObject({ classification: "approval_required" });
  });

  it.each([
    ["tsc", "build", ["--outDir", "dist"]],
    [
      "vitest",
      "test",
      ["run", "--coverage", "--coverage.reportsDirectory=coverage"],
    ],
    ["pnpm", "test", ["test", "--", "--coverage"]],
  ])("F7 allows bounded output %s", (executable, toolName, argv) => {
    const f = commandFixture();
    expect(
      classifyAction(
        makeAction(f, {
          executable,
          toolName,
          argv,
          fileChange: "bounded",
          touchedPaths: ["dist", "coverage"],
        }),
        f.options,
      ).classification,
    ).toBe("automatic");
  });
});

const runtimeFixture = (
  outcome:
    | "allowed-once"
    | "rejected"
    | "unavailable"
    | "cancelled" = "allowed-once",
  override?: (
    fixture: ReturnType<typeof makeFixture>,
  ) => Partial<CanonicalAction>,
) => {
  const fixture = makeFixture();
  const root = new Context();
  root.provide("systemPrompt", {
    tools() {},
    context() {},
    getContextOrder() {
      return 0;
    },
  });
  new ToolRuntime(root);
  new ApprovalService(root, { policy: "ask" });
  const events: { type: string; data?: unknown }[] = [{ type: "turn/start" }];
  const agent = {
    id: "bridge-owned",
    ctx: root,
    session: {
      get seq() {
        return events.length;
      },
      eventAt(seq: number) {
        return events[seq];
      },
      append(type: string, data: unknown) {
        events.push({ type, data });
      },
    },
  };
  const scope = createScope(root, agent);
  agent.ctx = scope.ctx.extend({ agent });
  let bodies = 0;
  let action = makeAction(fixture, {
    toolName: "delete_file",
    fileChange: "destructive",
    touchedPaths: ["output.txt"],
    ...override?.(fixture),
  });
  agent.ctx.tools.register({
    name: action.toolName,
    description: "counter-only fixture",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "number" },
      render: () => [{ type: "text", text: "fixture" }],
    },
    async execute() {
      bodies++;
      return bodies;
    },
  });
  agent.ctx.on("approval/request", async () => outcome);
  const options = {
    repositories: [fixture.repository],
    trustedExecutables: Object.fromEntries(
      ["pnpm", "npm", "git", "vercel", "rg"].map((name) => [
        name,
        realpathSync(join(fixture.executableDirectory, name)),
      ]),
    ),
    agentId: agent.id,
    resolveAction: () => ({ action, provenance: "local_tool" as const }),
  };
  createPolicyAgentSetup(options)(agent.ctx);
  const execute = (signal = new AbortController().signal) =>
    root.tools.execute({
      callId: "call" as never,
      name: action.toolName,
      arguments: {},
      agent: agent as never,
      signal,
    });
  return {
    root,
    agent,
    events,
    execute,
    scope,
    options,
    bodies: () => bodies,
    changeAction: () => {
      action = { ...action, touchedPaths: ["other.txt"] };
    },
  };
};

describe("N1-N4 deterministic corrective wave", () => {
  const policy = (f: ReturnType<typeof makeFixture>) => ({
    repositories: [f.repository],
    trustedExecutables: Object.fromEntries(
      ["pnpm", "npm", "git", "vercel", "grep", "rg"].map((name) => [
        name,
        realpathSync(join(f.executableDirectory, name)),
      ]),
    ),
  });

  it.each([
    [
      "git",
      "git_push",
      ["-C", "..", "push", "origin", "main"],
      "PATH_TRAVERSAL",
    ],
    ["git", "git_push", ["-C../outside", "push"], "PATH_TRAVERSAL"],
    [
      "npm",
      "package_install",
      ["install", "--prefix", "../outside"],
      "PATH_TRAVERSAL",
    ],
    [
      "npm",
      "package_install",
      ["install", "--prefix=../outside"],
      "PATH_TRAVERSAL",
    ],
    [
      "npm",
      "package_install",
      ["install", "--userconfig", ".npmrc"],
      "PROTECTED_RESOURCE",
    ],
    [
      "pnpm",
      "package_install",
      ["install", "--dir", "../outside"],
      "PATH_TRAVERSAL",
    ],
    ["vercel", "deploy", ["deploy", "../outside"], "PATH_TRAVERSAL"],
    [
      "vercel",
      "deploy",
      ["deploy", "--local-config=.env"],
      "PROTECTED_RESOURCE",
    ],
  ])(
    "N1 validates %s %s %j before approval",
    (executable, toolName, argv, reasonCode) => {
      const f = makeFixture();
      expect(
        classifyAction(
          makeAction(f, { executable, toolName, argv }),
          policy(f),
        ),
      ).toMatchObject({ classification: "denied", reasonCode });
    },
  );

  it.each(["git", "npm", "vercel"])(
    "N1 blocks outside and symlink administrative paths for %s in real runtime",
    async (command) => {
      const f = runtimeFixture("allowed-once", (fixture) => {
        symlinkSync(
          fixture.outsidePath,
          join(fixture.repositoryPath, "linked"),
        );
        const argv =
          command === "git"
            ? ["-C", "linked", "push", "origin", "main"]
            : command === "npm"
              ? ["install", "--prefix", fixture.outsidePath]
              : ["deploy", "linked"];
        return {
          executable: command,
          toolName:
            command === "git"
              ? "git_push"
              : command === "npm"
                ? "package_install"
                : "deploy",
          argv,
          touchedPaths: [],
          fileChange: "none",
        };
      });
      expect((await f.execute()).isError).toBe(true);
      expect(f.bodies()).toBe(0);
      expect(f.events).toHaveLength(1);
    },
  );

  it.each([
    ["git", "git_push", ["-C", ".", "push", "origin", "main"]],
    [
      "npm",
      "package_install",
      ["install", "--prefix", "dist", "example-package"],
    ],
    ["pnpm", "package_install", ["install", "--dir=dist"]],
    ["vercel", "deploy", ["deploy", "."]],
  ])(
    "N1 preserves contained approved %s",
    async (executable, toolName, argv) => {
      const f = runtimeFixture("allowed-once", () => ({
        executable,
        toolName,
        argv,
        touchedPaths: [],
        fileChange: "none",
      }));
      expect((await f.execute()).isError).toBe(false);
      expect(f.bodies()).toBe(1);
      expect(f.events.map((event) => event.type)).toEqual([
        "turn/start",
        "approval/asked",
        "approval/decided",
      ]);
    },
  );

  it.each([
    ["npm", ["run", "build", "--", "--build", "--clean"]],
    ["pnpm", ["build", "--build", "--clean"]],
  ])(
    "N2 requires actual approval for forwarded %s clean",
    async (executable, argv) => {
      for (const outcome of ["rejected", "allowed-once"] as const) {
        const f = runtimeFixture(outcome, () => ({
          executable,
          toolName: "build",
          argv,
          fileChange: "bounded",
          touchedPaths: ["dist"],
        }));
        expect((await f.execute()).isError).toBe(outcome !== "allowed-once");
        expect(f.bodies()).toBe(outcome === "allowed-once" ? 1 : 0);
        expect(f.events.map((event) => event.type)).toEqual([
          "turn/start",
          "approval/asked",
          "approval/decided",
        ]);
      }
    },
  );

  it.each(["npm", "pnpm"])(
    "N2 preserves safe bounded %s build",
    async (executable) => {
      const f = runtimeFixture("rejected", () => ({
        executable,
        toolName: "build",
        argv: ["run", "build", "--", "--outDir", "dist"],
        fileChange: "bounded",
        touchedPaths: ["dist"],
      }));
      expect((await f.execute()).isError).toBe(false);
      expect(f.bodies()).toBe(1);
      expect(f.events).toHaveLength(1);
    },
  );

  it("N3 verifies installed grep and rg attached-equals filename semantics without reading targets", () => {
    const f = makeFixture();
    writeFileSync(join(f.repositoryPath, "source.txt"), "nonsecret fixture\n");
    for (const [executable, expectedName] of [
      ["/usr/bin/grep", "=qhb_missing_patterns"],
      [actualRipgrep, "qhb_missing_patterns"],
    ]) {
      const result = spawnSync(
        executable as string,
        ["-f=qhb_missing_patterns", "source.txt"],
        { cwd: f.repositoryPath, encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expectedName);
      if (executable.endsWith("/rg"))
        expect(result.stderr).not.toContain("=qhb_missing_patterns");
    }
  });

  it("N3 checks the equals-prefixed grep file rather than its decoy", () => {
    const f = makeFixture();
    writeFileSync(join(f.repositoryPath, "patterns"), "nonsecret fixture\n");
    writeFileSync(join(f.repositoryPath, "source.txt"), "nonsecret fixture\n");
    symlinkSync(
      join(f.outsidePath, "patterns"),
      join(f.repositoryPath, "=patterns"),
    );
    writeFileSync(
      join(f.outsidePath, "patterns"),
      "nonsecret outside fixture\n",
    );
    const action = makeAction(f, {
      toolName: "search",
      executable: "grep",
      argv: ["-f=patterns", "source.txt"],
    });
    expect(classifyAction(action, policy(f))).toMatchObject({
      classification: "denied",
      reasonCode: "SYMLINK_ESCAPE",
    });
  });

  it("N3 separates grep filenames while retaining rg equals equivalence", () => {
    const f = makeFixture();
    writeFileSync(join(f.repositoryPath, "source.txt"), "nonsecret fixture\n");
    for (const executable of ["grep", "rg"]) {
      const decisions = ["-f=patterns", "-f=./patterns"].map((argument) =>
        classifyAction(
          makeAction(f, {
            toolName: "search",
            executable,
            argv: [argument, "source.txt"],
          }),
          policy(f),
        ),
      );
      expect(
        decisions.every((decision) => decision.classification === "automatic"),
      ).toBe(true);
      expect(decisions[0]?.fingerprint === decisions[1]?.fingerprint).toBe(
        executable === "rg",
      );
    }
  });

  it.each(["python", "python3", "python3.12"])(
    "N4 prioritizes explicit %s environment denial over approval effects",
    (executable) => {
      const f = makeFixture();
      for (const expression of ["os.environ", "os.getenv('EXAMPLE')"]) {
        expect(
          classifyAction(
            makeAction(f, {
              toolName: "delete_file",
              executable,
              argv: ["-c", `print(${expression})`],
              fileChange: "destructive",
              networkIntent: "write",
              externalSideEffect: "deploy",
            }),
            policy(f),
          ),
        ).toMatchObject({
          classification: "denied",
          reasonCode: "SECRET_ACCESS",
        });
      }
    },
  );

  it.each(["cmd.exe", "powershell.exe", "pwsh.exe"])(
    "N4 prioritizes interpreter denial for %s",
    (executable) => {
      const f = makeFixture();
      expect(
        classifyAction(
          makeAction(f, {
            toolName: "delete_file",
            executable,
            argv: [],
            fileChange: "destructive",
          }),
          policy(f),
        ),
      ).toMatchObject({
        classification: "denied",
        reasonCode: "ARBITRARY_COMMAND",
      });
    },
  );
});

describe("N1 administrative argument scope transitions", () => {
  it.each([
    ["search", "rg", ["-e", "--pre=fixture", "source.txt"]],
    ["test", "pnpm", ["test", "--testNamePattern", "install"]],
  ])(
    "does not reinterpret parsed %s data as a capability",
    (toolName, executable, argv) => {
      const fixture = makeFixture();
      expect(
        classifyAction(makeAction(fixture, { toolName, executable, argv }), {
          repositories: [fixture.repository],
          trustedExecutables: {
            [executable]: realpathSync(
              join(fixture.executableDirectory, executable),
            ),
          },
        }).classification,
      ).toBe("automatic");
    },
  );

  it.each([
    ["install", "--cache", "cache", "--dir", "nested"],
    ["install", "--dir", "nested", "--cache", "cache"],
    ["link", "--dir", "nested", "package"],
  ])("denies unsupported context-dependent path resolution %j", (...argv) => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.repositoryPath, "nested"));
    symlinkSync(
      fixture.outsidePath,
      join(fixture.repositoryPath, "nested", "cache"),
    );
    symlinkSync(
      fixture.outsidePath,
      join(fixture.repositoryPath, "nested", "package"),
    );
    const action = makeAction(fixture, {
      toolName: "package_install",
      executable: "pnpm",
      argv,
    });
    expect(
      classifyAction(action, { repositories: [fixture.repository] })
        .classification,
    ).toBe("denied");
  });

  it("rechecks a canonical administrative path after audited approval in actual runtime", async () => {
    let fixturePath = "";
    const f = runtimeFixture("allowed-once", (fixture) => {
      fixturePath = fixture.repositoryPath;
      mkdirSync(join(fixturePath, "first"));
      mkdirSync(join(fixturePath, "second"));
      symlinkSync(join(fixturePath, "first"), join(fixturePath, "alias"));
      return {
        toolName: "git_push",
        executable: "git",
        argv: ["-C", "alias", "push", "origin", "main"],
        touchedPaths: [],
        fileChange: "none",
      };
    });
    f.agent.ctx.on(
      "tools/pre-execute",
      async (_execution, next) => {
        await next();
        rmSync(join(fixturePath, "alias"));
        symlinkSync(join(fixturePath, "second"), join(fixturePath, "alias"));
        return { kind: "allow" };
      },
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(true);
    expect(f.bodies()).toBe(0);
    expect(f.events.map((event) => event.type)).toEqual([
      "turn/start",
      "approval/asked",
      "approval/decided",
    ]);
  });
});

describe("N5 actual ripgrep search domain", () => {
  const domainFixture = () => {
    const f = makeFixture();
    mkdirSync(join(f.repositoryPath, ".git"));
    mkdirSync(join(f.repositoryPath, "src"));
    writeFileSync(
      join(f.repositoryPath, "src", "safe.ts"),
      "nonsecret fixture\n",
    );
    writeFileSync(
      join(f.repositoryPath, ".gitignore"),
      "node_modules/\nignored/\n",
    );
    const options = {
      repositories: [f.repository],
      trustedExecutables: { rg: actualRipgrep },
    };
    const action = (argv: string[]) =>
      makeAction(f, { toolName: "search", executable: actualRipgrep, argv });
    return { ...f, options, action };
  };

  it("allows default root search despite ignored protected files and more than 10000 ignored entries", () => {
    const f = domainFixture();
    const dependencies = join(f.repositoryPath, "node_modules");
    mkdirSync(dependencies);
    for (let i = 0; i < 10020; i++)
      writeFileSync(join(dependencies, `fixture-${i}`), "nonsecret\n");
    writeFileSync(join(dependencies, ".env"), "nonsecret fixture\n");
    writeFileSync(
      join(f.repositoryPath, ".git", "id_rsa"),
      "nonsecret fixture\n",
    );
    expect(
      classifyAction(f.action(["-n", "fixture", "."]), f.options)
        .classification,
    ).toBe("automatic");
  });

  it.each([
    [["fixture", "."], "automatic"],
    [["--hidden", "fixture", "."], "denied"],
    [["--hidden", "-g", "!.env", "fixture", "."], "automatic"],
    [["-g", ".env", "fixture", "."], "denied"],
    [["fixture", ".env"], "denied"],
  ])(
    "matches actual hidden/glob/explicit selection %j",
    (argv, classification) => {
      const f = domainFixture();
      writeFileSync(join(f.repositoryPath, ".env"), "nonsecret fixture\n");
      expect(classifyAction(f.action(argv), f.options).classification).toBe(
        classification,
      );
    },
  );

  it.each([
    [["fixture", "."], "automatic"],
    [["--no-ignore", "fixture", "."], "denied"],
    [["-g", "ignored/**", "fixture", "."], "denied"],
    [["fixture", "ignored/private.txt"], "denied"],
  ])(
    "matches ignored and explicitly selected configured resources %j",
    (argv, classification) => {
      const f = domainFixture();
      mkdirSync(join(f.repositoryPath, "ignored"));
      writeFileSync(
        join(f.repositoryPath, "ignored", "private.txt"),
        "nonsecret fixture\n",
      );
      const options = {
        ...f.options,
        protectedPaths: { "repo-one": ["ignored/private.txt"] },
      };
      expect(classifyAction(f.action(argv), options).classification).toBe(
        classification,
      );
    },
  );

  it("preserves type/depth selection and filenames containing line delimiters", () => {
    const f = domainFixture();
    writeFileSync(
      join(f.repositoryPath, "src", "line\nbreak\tname.ts"),
      "nonsecret fixture\n",
    );
    writeFileSync(
      join(f.repositoryPath, "src", "private.txt"),
      "nonsecret fixture\n",
    );
    const options = {
      ...f.options,
      protectedPaths: { "repo-one": ["src/private.txt"] },
    };
    const action = f.action(["-t", "ts", "fixture", "."]);
    expect(classifyAction(action, options).classification).toBe("automatic");
    expect(canonicalizeAction(action, options).action.touchedPaths).toContain(
      join(f.repository.canonicalPath, "src", "line\nbreak\tname.ts"),
    );
    expect(
      classifyAction(f.action(["--max-depth", "1", "fixture", "."]), options)
        .classification,
    ).toBe("automatic");
  });

  it("does not enumerate symlink descendants but denies explicit outside links", () => {
    const f = domainFixture();
    writeFileSync(join(f.outsidePath, "ordinary.txt"), "nonsecret fixture\n");
    symlinkSync(f.outsidePath, join(f.repositoryPath, "linked"));
    expect(
      classifyAction(f.action(["fixture", "."]), f.options).classification,
    ).toBe("automatic");
    expect(
      classifyAction(f.action(["fixture", "linked"]), f.options).classification,
    ).toBe("denied");
  });

  it("preserves explicit alias operand spellings for glob selection before canonicalizing candidates", () => {
    const f = domainFixture();
    symlinkSync(join(f.repositoryPath, "src"), join(f.repositoryPath, "alias"));
    const argv = [
      "-g",
      "alias/**",
      "-g",
      "source.txt",
      "fixture",
      "alias",
      "source.txt",
    ];
    const actual = spawnSync(
      actualRipgrep,
      [
        "--files",
        "--null",
        "--no-config",
        "-g",
        "alias/**",
        "-g",
        "source.txt",
        "alias",
        "source.txt",
      ],
      { cwd: f.repositoryPath, encoding: "utf8" },
    );
    expect(actual.status).toBe(0);
    expect(actual.stdout.split("\0")).toContain("alias/safe.ts");
    expect(
      classifyAction(f.action(argv), {
        ...f.options,
        protectedPaths: { "repo-one": ["src/safe.ts"] },
      }),
    ).toMatchObject({
      classification: "denied",
      reasonCode: "PROTECTED_RESOURCE",
    });
  });

  it.each(["safe-file", "protected-file", "config"])(
    "rechecks %s domain changes at the actual runtime final guard",
    async (change) => {
      let repositoryPath = "";
      const f = runtimeFixture("allowed-once", (fixture) => {
        repositoryPath = fixture.repositoryPath;
        return {
          toolName: "search",
          executable: "rg",
          argv: ["--hidden", "fixture", "."],
          touchedPaths: [],
          fileChange: "none",
        };
      });
      f.agent.ctx.on(
        "tools/pre-execute",
        async (_execution, next) => {
          await next();
          if (change === "config")
            vi.stubEnv("RIPGREP_CONFIG_PATH", "unread-config");
          else
            writeFileSync(
              join(
                repositoryPath,
                change === "safe-file" ? "added.txt" : ".env",
              ),
              "nonsecret fixture\n",
            );
          return { kind: "allow" };
        },
        { prepend: true },
      );
      expect((await f.execute()).isError).toBe(true);
      expect(f.bodies()).toBe(0);
      expect(f.events).toHaveLength(1);
    },
  );

  it("executes a stable ordinary root search through actual runtime without approval", async () => {
    const f = runtimeFixture("rejected", () => ({
      toolName: "search",
      executable: "rg",
      argv: ["fixture", "."],
      touchedPaths: [],
      fileChange: "none",
    }));
    expect((await f.execute()).isError).toBe(false);
    expect(f.bodies()).toBe(1);
    expect(f.events).toHaveLength(1);
  });

  it("does not strip a leading Unicode BOM from candidate filenames", () => {
    const f = domainFixture();
    mkdirSync(join(f.repositoryPath, "\ufeffsrc"));
    writeFileSync(
      join(f.repositoryPath, "\ufeffsrc", "safe.ts"),
      "nonsecret fixture\n",
    );
    expect(
      classifyAction(f.action(["fixture", "\ufeffsrc"]), {
        ...f.options,
        protectedPaths: { "repo-one": ["\ufeffsrc/safe.ts"] },
      }),
    ).toMatchObject({
      classification: "denied",
      reasonCode: "PROTECTED_RESOURCE",
    });
  });

  it.each([["-r", "fixture"], ["-rn", "fixture"], ["fixture"]])(
    "requires an explicit grep search scope for %j",
    (...argv) => {
      const f = domainFixture();
      writeFileSync(join(f.repositoryPath, ".env"), "nonsecret fixture\n");
      expect(
        classifyAction(
          makeAction(f, { toolName: "search", executable: "grep", argv }),
          {
            ...f.options,
            trustedExecutables: {
              grep: realpathSync(join(f.executableDirectory, "grep")),
            },
          },
        ),
      ).toMatchObject({
        classification: "denied",
        reasonCode: "UNSUPPORTED_ARGUMENTS",
      });
    },
  );

  it("requires explicit no-config when RIPGREP_CONFIG_PATH is nonempty", () => {
    const f = domainFixture();
    vi.stubEnv("RIPGREP_CONFIG_PATH", join(f.repositoryPath, "unread-config"));
    expect(
      classifyAction(f.action(["fixture", "."]), f.options).classification,
    ).toBe("denied");
    expect(
      classifyAction(f.action(["--no-config", "fixture", "."]), f.options)
        .classification,
    ).toBe("automatic");
  });

  it("enumerates with bounded filename-only arguments, excluding regex and pattern-file inputs", () => {
    const f = domainFixture();
    writeFileSync(
      join(f.repositoryPath, "patterns.txt"),
      "nonsecret fixture\n",
    );
    const spy = vi.spyOn(childProcess, "spawnSync");
    try {
      expect(
        classifyAction(
          f.action([
            "--no-config",
            "-f",
            "patterns.txt",
            "-e",
            "unique-data-pattern",
            "-g",
            "*.ts",
            "src",
          ]),
          f.options,
        ).classification,
      ).toBe("automatic");
      expect(spy).toHaveBeenCalledOnce();
      const [executable, argv, options] = spy.mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(executable).toBe(actualRipgrep);
      expect(argv).toContain("--files");
      expect(argv).toContain("--null");
      expect(argv).toContain("--no-config");
      expect(argv).not.toContain("unique-data-pattern");
      expect(argv).not.toContain("-f");
      expect(argv.join(" ")).not.toContain("patterns.txt");
      expect(options).toMatchObject({
        shell: false,
        timeout: 2000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    "timeout",
    "truncated",
    "malformed",
    "too-many",
    "outside",
    "protected",
    "nonzero",
  ])("fails closed for bounded helper result %s", (kind) => {
    const f = domainFixture();
    let stdout = Buffer.from("");
    if (kind === "malformed") stdout = Buffer.from("unterminated");
    if (kind === "too-many")
      stdout = Buffer.from("src/safe.ts\0".repeat(10001));
    if (kind === "outside")
      stdout = Buffer.from(`${f.outsidePath}/ordinary.txt\0`);
    if (kind === "protected") stdout = Buffer.from(".env\0");
    const spy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: kind === "nonzero" ? 2 : 0,
      signal: null,
      stdout,
      stderr: Buffer.alloc(0),
      error:
        kind === "timeout" || kind === "truncated"
          ? new Error("fixture failure")
          : undefined,
    } as never);
    try {
      expect(
        classifyAction(f.action(["fixture", "."]), f.options).classification,
      ).toBe("denied");
    } finally {
      spy.mockRestore();
    }
  });

  it("requires concrete native search files and denies unspecified or directory scope", () => {
    const f = domainFixture();
    for (const touchedPaths of [[], ["."], ["src/safe.ts"]]) {
      const action = makeAction(f, {
        toolName: "search",
        argv: ["token"],
        touchedPaths,
      });
      expect(classifyAction(action, f.options).classification).toBe(
        touchedPaths[0] === "src/safe.ts" ? "automatic" : "denied",
      );
    }
  });
});

describe("actual scoped runtime approval and ownership", () => {
  it("does not mint proof when the approval audit cannot commit", async () => {
    const f = runtimeFixture();
    const append = f.agent.session.append;
    f.agent.session.append = (type, data) => {
      if (type === "approval/decided")
        throw new Error("fixture audit unavailable");
      append(type, data);
    };
    f.agent.ctx.on(
      "tools/pre-execute",
      async (_exec, next) => {
        await next();
        return { kind: "allow" as const };
      },
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(true);
    expect(f.bodies()).toBe(0);
  });

  it("rejects a scope tag belonging to another Agent", () => {
    const f = runtimeFixture();
    const wrong = { id: "bridge-owned", ctx: f.root };
    wrong.ctx = createScope(f.root, {}).ctx.extend({ agent: wrong });
    expect(() => createPolicyAgentSetup(f.options)(wrong.ctx)).toThrow(
      "POLICY_AGENT_SCOPE_REQUIRED",
    );
  });

  it("does not reuse one setup capability on a different object with the same ID", () => {
    const f = runtimeFixture();
    const setup = createPolicyAgentSetup(f.options);
    const owned = { id: "bridge-owned", ctx: f.root };
    owned.ctx = createScope(f.root, owned).ctx.extend({ agent: owned });
    setup(owned.ctx);
    const other = { id: "bridge-owned", ctx: f.root };
    other.ctx = createScope(f.root, other).ctx.extend({ agent: other });
    expect(() => setup(other.ctx)).toThrow("POLICY_BRIDGE_AGENT_MISMATCH");
  });
  it("denies missing approval service even if an outer layer returns allow", async () => {
    const f = runtimeFixture();
    f.root.set("approval", undefined);
    f.agent.ctx.on(
      "tools/pre-execute",
      async (_exec, next) => {
        await next();
        return { kind: "allow" as const };
      },
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(true);
    expect(f.bodies()).toBe(0);
  });

  it("does not install policy on unrelated or agentless executions", async () => {
    const f = runtimeFixture();
    const action = makeAction(makeFixture(), { environmentRead: "arbitrary" });
    f.root.tools.register({
      name: "read_file",
      description: "scope probe",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "number" }, render: () => [] },
      async execute() {
        return 1;
      },
    });
    expect(
      (
        await f.root.tools.execute({
          name: "read_file",
          arguments: { action },
          callId: "agentless" as never,
          signal: new AbortController().signal,
        })
      ).isError,
    ).toBe(false);
    const other = { id: "another" };
    expect(
      (
        await f.root.tools.execute({
          name: "read_file",
          arguments: { action },
          agent: other as never,
          callId: "another" as never,
          signal: new AbortController().signal,
        })
      ).isError,
    ).toBe(false);
  });
  it("F1 audits a grant before executing and consumes proof once", async () => {
    const f = runtimeFixture();
    let captured: ToolExecution | undefined;
    f.agent.ctx.on(
      "tools/pre-execute",
      async (exec, next) => {
        captured = exec;
        return next();
      },
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(false);
    expect(f.bodies()).toBe(1);
    expect(f.events.map((event) => event.type)).toEqual([
      "turn/start",
      "approval/asked",
      "approval/decided",
    ]);
    expect(
      (
        f.root.tools as unknown as {
          guardReason(exec: ToolExecution): string | undefined;
        }
      ).guardReason(captured as ToolExecution),
    ).toMatch(/APPROVAL|PROOF/u);
  });

  it("F1 denies a later prepended allow without an approval", async () => {
    const f = runtimeFixture();
    f.agent.ctx.on(
      "tools/pre-execute",
      async () => ({ kind: "allow" as const }),
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(true);
    expect(f.bodies()).toBe(0);
    expect(f.events).toHaveLength(1);
  });

  it.each(["rejected", "unavailable", "cancelled"] as const)(
    "F1 outer allow cannot rewrite %s",
    async (outcome) => {
      const f = runtimeFixture(outcome);
      f.agent.ctx.on(
        "tools/pre-execute",
        async (_exec, next) => {
          await next();
          return { kind: "allow" as const };
        },
        { prepend: true },
      );
      expect((await f.execute()).isError).toBe(true);
      expect(f.bodies()).toBe(0);
    },
  );

  it("F1 denies changed fingerprints after a granted request", async () => {
    const f = runtimeFixture();
    f.agent.ctx.on(
      "tools/pre-execute",
      async (_exec, next) => {
        await next();
        f.changeAction();
        return { kind: "allow" as const };
      },
      { prepend: true },
    );
    expect((await f.execute()).isError).toBe(true);
    expect(f.bodies()).toBe(0);
  });

  it("F1 abort cannot produce usable approval proof", async () => {
    const f = runtimeFixture();
    const abort = new AbortController();
    f.agent.ctx.on(
      "approval/request",
      async () => {
        abort.abort();
        return "allowed-once" as const;
      },
      { prepend: true },
    );
    expect((await f.execute(abort.signal)).isError).toBe(true);
    expect(f.bodies()).toBe(0);
  });

  it("F8 rejects an untagged self-reference without installing a global guard", () => {
    const fixture = makeFixture();
    const root = new Context();
    root.provide("systemPrompt", {
      tools() {},
      context() {},
      getContextOrder() {
        return 0;
      },
    });
    new ToolRuntime(root);
    const agent = { ctx: root, id: "owned" };
    agent.ctx = root.extend({ agent });
    expect(() =>
      registerPolicyGuard(agent.ctx, {
        repositories: [fixture.repository],
        resolveAction: () => undefined,
      }),
    ).toThrow();
    expect(
      (
        root.tools as unknown as {
          guardReason(exec: object): string | undefined;
        }
      ).guardReason({ name: "read_file" }),
    ).toBeUndefined();
  });

  it("F8 binds the setup capability to the specified bridge agent", () => {
    const f = runtimeFixture();
    const stranger = { id: "unrelated", ctx: f.root };
    stranger.ctx = createScope(f.root, stranger).ctx.extend({
      agent: stranger,
    });
    expect(() => createPolicyAgentSetup(f.options)(stranger.ctx)).toThrow();
  });
});

const policyOptions = (
  fixture: ReturnType<typeof makeFixture>,
): ActionPolicyOptions => ({ repositories: [fixture.repository] });

type TestExecution = Readonly<{
  name: string;
  arguments: unknown;
  agent?: object;
  signal?: AbortSignal;
  callId?: string;
}>;
type TestGuard = (execution: TestExecution) => string | undefined;

let testAgent: { ctx: Context; id: string } | undefined;
const makeAgentScope = () => {
  const root = new Context();
  root.provide("approval", {
    async request() {
      return "allowed-once";
    },
  });
  const guards: TestGuard[] = [];
  const agent = { ctx: root, id: "test-owned" };
  const agentContext = createScope(root, agent).ctx.extend({
    agent,
    tools: {
      guard(guard: TestGuard) {
        guards.push(guard);
        return () => {
          const index = guards.indexOf(guard);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    },
  });
  agent.ctx = agentContext;
  testAgent = agent;
  return { agentContext, guards, root };
};

const installPolicy = (
  ctx: Context,
  options: PolicyGuardRegistrationOptions,
) => {
  const setup = createPolicyAgentSetup({
    ...options,
    agentId: String(ctx.agent?.id ?? "test-owned"),
  });
  setup(ctx);
  return setup.dispose;
};

const makeExecution = (
  action: CanonicalAction,
  name = action.toolName,
): TestExecution => ({
  name,
  arguments: { action },
  agent: testAgent,
  signal: new AbortController().signal,
  callId: "fixture",
});

const trustedPolicyOptions = (
  fixture: ReturnType<typeof makeFixture>,
  trustedActions: WeakMap<object, TrustedPolicyAction>,
): PolicyGuardRegistrationOptions => ({
  repositories: [fixture.repository],
  trustedExecutables: Object.fromEntries(
    ["pnpm", "rg", "rm"].map((name) => [
      name,
      join(realpathSync(fixture.executableDirectory), name),
    ]),
  ),
  resolveAction(execution) {
    return trustedActions.get(execution);
  },
});

const trustExecution = (
  trustedActions: WeakMap<object, TrustedPolicyAction>,
  execution: TestExecution,
  action: CanonicalAction,
  _fixture: ReturnType<typeof makeFixture>,
  provenance: TrustedPolicyAction["provenance"] = "local_tool",
): void => {
  trustedActions.set(execution, {
    action,
    provenance,
  });
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

describe("local repository policy boundary", () => {
  it("treats an empty PATH entry as cwd before a trusted executable", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.repository.canonicalPath, "rg"),
      "attacker fixture\n",
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${delimiter}${fixture.executableDirectory}`);
    const action = makeAction(fixture, {
      toolName: "search",
      executable: "rg",
      argv: ["--files"],
    });
    const options = {
      repositories: [fixture.repository],
      trustedExecutables: {
        rg: realpathSync(join(fixture.executableDirectory, "rg")),
      },
    };
    expect(classifyAction(action, options).classification).toBe("denied");
  });

  it("denies a same-name PATH shadow despite a registered safe rg", () => {
    const fixture = makeFixture();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const { agentContext, guards } = makeAgentScope();
    installPolicy(agentContext, trustedPolicyOptions(fixture, trustedActions));
    const attacker = join(fixture.outsidePath, "rg");
    writeFileSync(attacker, "attacker fixture\n", { mode: 0o755 });
    vi.stubEnv("PATH", fixture.outsidePath);
    const action = makeAction(fixture, {
      toolName: "search",
      executable: "rg",
      argv: ["--files"],
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);
    expect(guards[0]?.(execution)).toBe(
      "POLICY_DENIED:EXECUTABLE_TOOL_MISMATCH",
    );
  });

  it("denies bare rg supplied by a per-action resolver without registration trust", () => {
    const fixture = makeFixture();
    const context = {
      provenance: "local_tool" as const,
      resolveExecutable: () => join(fixture.executableDirectory, "rg"),
    };
    expect(
      classifyAction(
        makeAction(fixture, {
          toolName: "search",
          executable: "rg",
          argv: ["--files"],
        }),
        policyOptions(fixture),
        context,
      ).classification,
    ).toBe("denied");
  });

  it.each([
    ["search", "rg", "rg", ["--files", "."], "automatic"],
    ["test", "pnpm", "pnpm", ["test"], "automatic"],
    ["build", "tsc", "tsc.js", ["--outDir=."], "automatic"],
    ["build", "tsc", "compiler-entry.js", ["--noEmit"], "automatic"],
    ["build", "pnpm", "pnpm", ["install"], "approval_required"],
    ["git_push", "git", "git", ["push"], "approval_required"],
    ["deploy", "vercel", "vercel", ["deploy"], "approval_required"],
  ])(
    "preserves explicit trusted %s %s",
    (toolName, identity, filename, argv, expected) => {
      const fixture = makeFixture();
      const executable = join(fixture.executableDirectory, filename);
      writeFileSync(executable, "fixture\n", { mode: 0o755 });
      if (identity === "rg") copyFileSync(actualRipgrep, executable);
      if (identity !== filename)
        symlinkSync(executable, join(fixture.executableDirectory, identity));
      const options = {
        repositories: [fixture.repository],
        trustedExecutables: { [identity]: realpathSync(executable) },
      };
      for (const spelling of [identity, executable]) {
        expect(
          classifyAction(
            makeAction(fixture, { toolName, executable: spelling, argv }),
            options,
          ).classification,
        ).toBe(expected);
      }
    },
  );

  it.each([
    ["search", "rg", ["--files", ".."]],
    ["grep", "grep", ["needle", ".."]],
    ["build", "tsc", ["--outDir", ".."]],
    ["build", "tsc", ["--outDir=.."]],
    ["build", "tsc", ["-o.."]],
    ["search", "rg", ["-C.."]],
  ])("rejects exact traversal in %s %s %j", (toolName, executable, argv) => {
    const fixture = makeFixture();
    const path = join(fixture.executableDirectory, executable);
    writeFileSync(path, "fixture\n");
    const options = {
      repositories: [fixture.repository],
      trustedExecutables: { [executable]: realpathSync(path) },
    };
    expect(
      classifyAction(
        makeAction(fixture, { toolName, executable: path, argv }),
        options,
      ),
    ).toMatchObject({ classification: "denied", reasonCode: "PATH_TRAVERSAL" });
  });

  it.each([".", "--outDir=.", "-o."])(
    "canonicalizes exact current directory %s",
    (argument) => {
      const fixture = makeFixture();
      const result = canonicalizeAction(
        makeAction(fixture, {
          toolName: "build",
          executable: join(fixture.executableDirectory, "pnpm"),
          argv: ["build", argument],
        }),
        policyOptions(fixture),
      );
      expect(result.violations).toEqual([]);
      expect(result.action.argv).toEqual([
        "build",
        argument.replace(/\.$/u, fixture.repository.canonicalPath),
      ]);
    },
  );

  it.each([
    ["search", "rg", ["--files"]],
    ["build", "tsc.js", ["--noEmit"]],
  ])(
    "does not trust an arbitrary %s executable named %s",
    (toolName, name, argv) => {
      const fixture = makeFixture();
      const executable = join(fixture.outsidePath, name);
      writeFileSync(executable, "attacker fixture\n");
      expect(
        classifyAction(
          makeAction(fixture, { toolName, executable, argv }),
          policyOptions(fixture),
        ).classification,
      ).toBe("denied");
    },
  );

  it("ignores per-execution executable trust and snapshots registration", async () => {
    const fixture = makeFixture();
    const attacker = join(fixture.outsidePath, "rg");
    writeFileSync(attacker, "attacker fixture\n");
    const trusted = realpathSync(join(fixture.executableDirectory, "rg"));
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const options = {
      ...trustedPolicyOptions(fixture, trustedActions),
      trustedExecutables: { rg: trusted },
    };
    const { agentContext, guards } = makeAgentScope();
    installPolicy(agentContext, options);
    const repositoryId = fixture.repository.id;
    fixture.repository.canonicalPath = realpathSync(fixture.outsidePath);
    options.trustedExecutables.rg = realpathSync(attacker);
    options.repositories = [
      {
        id: fixture.repository.id,
        canonicalPath: realpathSync(fixture.outsidePath),
      },
    ];
    const action = makeAction(fixture, {
      toolName: "search",
      executable: "rg",
      argv: ["--files"],
      cwd: realpathSync(fixture.repositoryPath),
      repositoryId,
    });
    const execution = makeExecution(action);
    const injected = {
      action,
      provenance: "local_tool" as const,
      resolveExecutable: () => attacker,
      trustedExecutables: { rg: attacker },
    };
    trustedActions.set(execution, injected);
    options.resolveAction = () => undefined;
    await expect(
      agentContext.waterfall(
        scopeTarget({}, agentContext.agent),
        "tools/pre-execute",
        execution,
        async () => ({
          kind: "allow" as const,
        }),
      ),
    ).resolves.toMatchObject({ kind: "allow" });
    expect(guards[0]?.(execution)).toBeUndefined();
    trustedActions.set(execution, {
      action: { ...action, executable: attacker },
      provenance: "local_tool",
    });
    expect(guards[0]?.(execution)).toMatch(/^POLICY_DENIED:/u);
  });

  it("resolves a new target through its nearest existing ancestor", () => {
    const fixture = makeFixture();
    const newTarget = join(fixture.repository.canonicalPath, "new", "file.txt");

    expect(canonicalizePath(fixture.repository.canonicalPath, newTarget)).toBe(
      newTarget,
    );
  });

  it("keeps the first segment when the nearest existing ancestor is filesystem root", () => {
    const target = `/qhb-policy-new-${process.pid}-${Date.now()}`;

    expect(canonicalizePath("/", target)).toBe(target);
  });

  it("rejects traversal before lexical normalization can hide it", () => {
    const fixture = makeFixture();
    const traversed = `${fixture.repository.canonicalPath}/../outside`;

    expect(() =>
      canonicalizePath(fixture.repository.canonicalPath, traversed),
    ).toThrowError("PATH_TRAVERSAL");
  });

  it("rechecks a previously safe new path immediately before execution", () => {
    const fixture = makeFixture();
    const swapDirectory = join(fixture.repository.canonicalPath, "swap");
    const target = join(swapDirectory, "new-file.txt");
    mkdirSync(swapDirectory);
    const initial = canonicalizePath(fixture.repository.canonicalPath, target);

    renameSync(swapDirectory, join(fixture.directory, "original-swap"));
    symlinkSync(fixture.outsidePath, swapDirectory, "dir");

    expect(() =>
      recheckCanonicalPath(fixture.repository.canonicalPath, target, initial),
    ).toThrowError(/PATH_OUTSIDE_REPOSITORY|SYMLINK_ESCAPE/);
  });

  it("denies a canonical cwd outside the configured repository", () => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { cwd: fixture.outsidePath }),
      policyOptions(fixture),
    );

    expect(decision.classification).toBe("denied");
  });

  it("denies arbitrary environment access even without a path escape", () => {
    const fixture = makeFixture();

    const decision = classifyAction(
      makeAction(fixture, { environmentRead: "arbitrary" }),
      policyOptions(fixture),
    );

    expect(decision.classification).toBe("denied");
  });

  it("denies Keychain and system-settings tools regardless of file scope", () => {
    const fixture = makeFixture();

    for (const action of [
      makeAction(fixture, { toolName: "keychain_read" }),
      makeAction(fixture, { toolName: "system_settings" }),
    ]) {
      expect(
        classifyAction(action, policyOptions(fixture)).classification,
      ).toBe("denied");
    }
  });

  it("keeps an unconditional denied result monotonic across later policy layers", () => {
    const fixture = makeFixture();
    const denied = classifyAction(
      makeAction(fixture, { environmentRead: "arbitrary" }),
      policyOptions(fixture),
    );
    const laterAllow = "later-plugin-allowed";

    expect(denied.classification).toBe("denied");
    expect(denied.reasonCode).not.toBe(laterAllow);
  });

  it("registers denied and approval policy through a trusted local resolver", async () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const dispose = installPolicy(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );

    const deniedAction = makeAction(fixture, { environmentRead: "arbitrary" });
    const deniedExecution = makeExecution(deniedAction);
    trustExecution(trustedActions, deniedExecution, deniedAction, fixture);
    expect(guards[0]?.(deniedExecution)).toMatch(/POLICY_DENIED|ENVIRONMENT/);

    const approvalAction = makeAction(fixture, {
      executable: "pnpm",
      argv: ["install"],
    });
    const approvalExecution = makeExecution(approvalAction);
    trustExecution(trustedActions, approvalExecution, approvalAction, fixture);
    await expect(
      agentContext.waterfall(
        scopeTarget({}, agentContext.agent),
        "tools/pre-execute",
        approvalExecution,
        async () => ({ kind: "allow" as const }),
      ),
    ).resolves.toMatchObject({ kind: "allow" });

    dispose();
  });

  it("prepends approval policy ahead of an earlier fail-open listener", async () => {
    const fixture = makeFixture();
    const { agentContext } = makeAgentScope();
    let earlierAllowCalls = 0;
    const disposeEarlier = agentContext.on("tools/pre-execute", async () => {
      earlierAllowCalls += 1;
      return { kind: "allow" as const };
    });
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const disposePolicy = installPolicy(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
    const action = makeAction(fixture, {
      executable: "pnpm",
      argv: ["install"],
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);

    const result = await agentContext.waterfall(
      scopeTarget({}, agentContext.agent),
      "tools/pre-execute",
      execution,
      async () => ({ kind: "allow" as const }),
    );

    expect(result).toMatchObject({ kind: "allow" });
    expect(earlierAllowCalls).toBe(0);
    disposePolicy();
    disposeEarlier();
  });

  it("rejects policy registration through a root Cordis context", () => {
    const fixture = makeFixture();
    const root = new Context();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();

    expect(() =>
      installPolicy(root, trustedPolicyOptions(fixture, trustedActions)),
    ).toThrowError("POLICY_AGENT_SCOPE_REQUIRED");
  });

  it("provides an official Agent setup callback for scoped registration", async () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const policyModule = await import(
      "../../packages/harness-plugin/src/policy/register-guard.js"
    );

    expect(policyModule).toHaveProperty("createPolicyAgentSetup");
    const createPolicyAgentSetup = (
      policyModule as typeof policyModule & {
        createPolicyAgentSetup: (
          options: PolicyGuardRegistrationOptions,
        ) => (agentContext: Context) => void;
      }
    ).createPolicyAgentSetup;
    const setup = createPolicyAgentSetup({
      ...trustedPolicyOptions(fixture, trustedActions),
      agentId: "test-owned",
    });
    setup(agentContext);

    expect(guards).toHaveLength(1);
  });

  it.each([
    ["complete embedded metadata", {}],
    ["missing side-effect metadata", { externalSideEffect: undefined }],
    ["unknown side-effect metadata", { environmentRead: "unexpected" }],
  ])("denies %s without a trusted local resolver", (_label, overrides) => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    installPolicy(agentContext, policyOptions(fixture) as never);
    const action = { ...makeAction(fixture), ...overrides };
    const execution = makeExecution(action as CanonicalAction);

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:UNTRUSTED_ACTION");
  });

  it("rejects a trusted tool identity that disagrees with execution", () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    installPolicy(agentContext, trustedPolicyOptions(fixture, trustedActions));
    const action = makeAction(fixture);
    const execution = makeExecution(action, "shell");
    trustExecution(trustedActions, execution, action, fixture);

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:UNTRUSTED_ACTION");
  });

  it("resolves a trusted bare executable before automatic authorization", () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    installPolicy(agentContext, trustedPolicyOptions(fixture, trustedActions));
    rmSync(join(fixture.executableDirectory, "rg"));
    symlinkSync(
      join(fixture.executableDirectory, "rm"),
      join(fixture.executableDirectory, "rg"),
    );
    const action = makeAction(fixture, {
      toolName: "search",
      executable: "rg",
      argv: ["needle"],
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:UNSUPPORTED_ARGUMENTS");
  });

  it("rejects an inside-repository directory symlink swap through the guard", async () => {
    const fixture = makeFixture();
    const firstDirectory = join(fixture.repository.canonicalPath, "first");
    const secondDirectory = join(fixture.repository.canonicalPath, "second");
    const target = join(firstDirectory, "new-file.txt");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const dispose = installPolicy(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
    const action = makeAction(fixture, {
      touchedPaths: [target],
      fileChange: "destructive",
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);
    await expect(
      agentContext.waterfall(
        scopeTarget({}, agentContext.agent),
        "tools/pre-execute",
        execution,
        async () => ({
          kind: "allow" as const,
        }),
      ),
    ).resolves.toMatchObject({ kind: "allow" });

    renameSync(firstDirectory, join(fixture.directory, "first-original"));
    symlinkSync(secondDirectory, firstDirectory, "dir");

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:PATH_CHANGED");
    dispose();
  });

  it("rejects an inside-repository leaf symlink swap through the guard", async () => {
    const fixture = makeFixture();
    const firstTarget = join(fixture.repository.canonicalPath, "first.txt");
    const secondTarget = join(fixture.repository.canonicalPath, "second.txt");
    const leaf = join(fixture.repository.canonicalPath, "leaf.txt");
    writeFileSync(firstTarget, "first\n");
    writeFileSync(secondTarget, "second\n");
    symlinkSync(firstTarget, leaf);
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    const dispose = installPolicy(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
    const action = makeAction(fixture, {
      touchedPaths: [leaf],
      fileChange: "destructive",
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);
    await agentContext.waterfall(
      scopeTarget({}, agentContext.agent),
      "tools/pre-execute",
      execution,
      async () => ({
        kind: "allow" as const,
      }),
    );

    rmSync(leaf);
    symlinkSync(secondTarget, leaf);

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:PATH_CHANGED");
    dispose();
  });
});
