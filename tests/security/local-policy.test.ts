import {
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
  type ActionPolicyOptions,
  canonicalizeAction,
  classifyAction,
} from "../../packages/harness-plugin/src/policy/action-classifier.js";
import {
  canonicalizePath,
  recheckCanonicalPath,
} from "../../packages/harness-plugin/src/policy/canonical-path.js";
import {
  type PolicyGuardRegistrationOptions,
  registerPolicyGuard,
  type TrustedPolicyAction,
} from "../../packages/harness-plugin/src/policy/register-guard.js";
import type {
  CanonicalAction,
  RepositoryPolicy,
} from "../../packages/harness-plugin/src/policy/types.js";

const temporaryDirectories: string[] = [];

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-local-policy-"));
  const repositoryPath = join(directory, "repository");
  const outsidePath = join(directory, "outside");
  const executableDirectory = join(directory, "bin");
  mkdirSync(repositoryPath);
  mkdirSync(outsidePath);
  mkdirSync(executableDirectory);
  for (const executable of ["pnpm", "rg", "rm"]) {
    writeFileSync(join(executableDirectory, executable), "test executable\n", {
      mode: 0o755,
    });
  }
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

const policyOptions = (
  fixture: ReturnType<typeof makeFixture>,
): ActionPolicyOptions => ({ repositories: [fixture.repository] });

type TestExecution = Readonly<{ name: string; arguments: unknown }>;
type TestGuard = (execution: TestExecution) => string | undefined;

const makeAgentScope = () => {
  const root = new Context();
  const guards: TestGuard[] = [];
  const agent = {} as { ctx: Context };
  const agentContext = root.extend({
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
  return { agentContext, guards, root };
};

const makeExecution = (
  action: CanonicalAction,
  name = action.toolName,
): TestExecution => ({ name, arguments: { action } });

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
    registerPolicyGuard(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
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
        makeAction(fixture, { argv: [argument] }),
        policyOptions(fixture),
      );
      expect(result.violations).toEqual([]);
      expect(result.action.argv).toEqual([
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
    registerPolicyGuard(agentContext, options);
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
    expect(guards[0]?.(execution)).toBeUndefined();
    await expect(
      agentContext.waterfall("tools/pre-execute", execution, async () => ({
        kind: "allow" as const,
      })),
    ).resolves.toMatchObject({ kind: "allow" });
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
    const dispose = registerPolicyGuard(
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
        "tools/pre-execute",
        approvalExecution,
        async () => ({ kind: "allow" as const }),
      ),
    ).resolves.toMatchObject({ kind: "ask" });

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
    const disposePolicy = registerPolicyGuard(
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
      "tools/pre-execute",
      execution,
      async () => ({ kind: "allow" as const }),
    );

    expect(result).toMatchObject({ kind: "ask" });
    expect(earlierAllowCalls).toBe(0);
    disposePolicy();
    disposeEarlier();
  });

  it("rejects policy registration through a root Cordis context", () => {
    const fixture = makeFixture();
    const root = new Context();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();

    expect(() =>
      registerPolicyGuard(root, trustedPolicyOptions(fixture, trustedActions)),
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
    const setup = createPolicyAgentSetup(
      trustedPolicyOptions(fixture, trustedActions),
    );
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
    registerPolicyGuard(agentContext, policyOptions(fixture) as never);
    const action = { ...makeAction(fixture), ...overrides };
    const execution = { name: action.toolName, arguments: { action } };

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:UNTRUSTED_ACTION");
  });

  it("rejects a trusted tool identity that disagrees with execution", () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    registerPolicyGuard(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
    const action = makeAction(fixture);
    const execution = makeExecution(action, "shell");
    trustExecution(trustedActions, execution, action, fixture);

    expect(guards[0]?.(execution)).toBe(
      "POLICY_DENIED:UNTRUSTED_TOOL_IDENTITY",
    );
  });

  it("resolves a trusted bare executable before automatic authorization", () => {
    const fixture = makeFixture();
    const { agentContext, guards } = makeAgentScope();
    const trustedActions = new WeakMap<object, TrustedPolicyAction>();
    registerPolicyGuard(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
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

    expect(guards[0]?.(execution)).toBe(
      "POLICY_DENIED:EXECUTABLE_TOOL_MISMATCH",
    );
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
    const dispose = registerPolicyGuard(
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
      agentContext.waterfall("tools/pre-execute", execution, async () => ({
        kind: "allow" as const,
      })),
    ).resolves.toMatchObject({ kind: "ask" });

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
    const dispose = registerPolicyGuard(
      agentContext,
      trustedPolicyOptions(fixture, trustedActions),
    );
    const action = makeAction(fixture, {
      touchedPaths: [leaf],
      fileChange: "destructive",
    });
    const execution = makeExecution(action);
    trustExecution(trustedActions, execution, action, fixture);
    await agentContext.waterfall("tools/pre-execute", execution, async () => ({
      kind: "allow" as const,
    }));

    rmSync(leaf);
    symlinkSync(secondTarget, leaf);

    expect(guards[0]?.(execution)).toBe("POLICY_DENIED:PATH_CHANGED");
    dispose();
  });
});
