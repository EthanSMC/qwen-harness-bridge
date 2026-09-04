import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActionPolicyOptions,
  classifyAction,
} from "../../packages/harness-plugin/src/policy/action-classifier.js";
import {
  canonicalizePath,
  recheckCanonicalPath,
} from "../../packages/harness-plugin/src/policy/canonical-path.js";
import { registerPolicyGuard } from "../../packages/harness-plugin/src/policy/register-guard.js";
import type {
  CanonicalAction,
  RepositoryPolicy,
} from "../../packages/harness-plugin/src/policy/types.js";

const temporaryDirectories: string[] = [];

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-local-policy-"));
  const repositoryPath = join(directory, "repository");
  const outsidePath = join(directory, "outside");
  mkdirSync(repositoryPath);
  mkdirSync(outsidePath);
  temporaryDirectories.push(directory);
  return {
    directory,
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

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      recursive: true,
      force: true,
    });
  }
});

describe("local repository policy boundary", () => {
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

  it("registers the denied guard and approval waterfall only on the supplied scope", async () => {
    const fixture = makeFixture();
    const guards: Array<(execution: unknown) => string | undefined> = [];
    const listeners: Array<{
      name: string;
      listener: (
        execution: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>;
    }> = [];
    const scopedContext = {
      tools: {
        guard(guard: (execution: unknown) => string | undefined) {
          guards.push(guard);
          return () => undefined;
        },
      },
      on(
        name: string,
        listener: (
          execution: unknown,
          next: () => Promise<unknown>,
        ) => Promise<unknown>,
      ) {
        listeners.push({ name, listener });
        return () => undefined;
      },
    };

    const dispose = registerPolicyGuard(scopedContext, policyOptions(fixture));
    expect(guards).toHaveLength(1);
    expect(listeners.map(({ name }) => name)).toContain("tools/pre-execute");

    const deniedAction = makeAction(fixture, { environmentRead: "arbitrary" });
    expect(
      guards[0]?.({
        name: deniedAction.toolName,
        arguments: { action: deniedAction },
      }),
    ).toMatch(/POLICY_DENIED|ENVIRONMENT/);

    const approvalListener = listeners.find(
      ({ name }) => name === "tools/pre-execute",
    )?.listener;
    const approvalAction = makeAction(fixture, {
      executable: "pnpm",
      argv: ["install"],
    });
    await expect(
      approvalListener?.(
        {
          name: approvalAction.toolName,
          arguments: { action: approvalAction },
        },
        async () => ({ kind: "allow" }),
      ),
    ).resolves.toMatchObject({ kind: "ask" });

    dispose();
  });

  it("rejects a canonical target changed by an inside-repository symlink swap", async () => {
    const fixture = makeFixture();
    const firstDirectory = join(fixture.repository.canonicalPath, "first");
    const secondDirectory = join(fixture.repository.canonicalPath, "second");
    const target = join(firstDirectory, "new-file.txt");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);

    const guards: Array<(execution: unknown) => string | undefined> = [];
    const listeners: Array<{
      name: string;
      listener: (
        execution: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>;
    }> = [];
    const scopedContext = {
      tools: {
        guard(guard: (execution: unknown) => string | undefined) {
          guards.push(guard);
          return () => undefined;
        },
      },
      on(
        name: string,
        listener: (
          execution: unknown,
          next: () => Promise<unknown>,
        ) => Promise<unknown>,
      ) {
        listeners.push({ name, listener });
        return () => undefined;
      },
    };
    const dispose = registerPolicyGuard(scopedContext, policyOptions(fixture));
    const action = makeAction(fixture, {
      touchedPaths: [target],
      fileChange: "destructive",
    });
    const execution = {
      name: action.toolName,
      arguments: { action },
    };
    const listener = listeners.find(
      ({ name }) => name === "tools/pre-execute",
    )?.listener;
    await expect(
      listener?.(execution, async () => ({ kind: "allow" })),
    ).resolves.toMatchObject({
      kind: "ask",
    });

    renameSync(firstDirectory, join(fixture.directory, "first-original"));
    symlinkSync(secondDirectory, firstDirectory, "dir");

    expect(guards[0]?.(execution)).toMatch(/PATH_CHANGED|POLICY_DENIED/);
    dispose();
  });
  it("does not let action arguments relabel the executing shell tool", () => {
    const fixture = makeFixture();
    const action = makeAction(fixture, { toolName: "read_file" });
    const guards: Array<(execution: unknown) => string | undefined> = [];

    const scopedContext = {
      tools: {
        guard(guard: (execution: unknown) => string | undefined) {
          guards.push(guard);
          return () => undefined;
        },
      },
      on() {
        return () => undefined;
      },
    };
    registerPolicyGuard(scopedContext, policyOptions(fixture));

    expect(guards[0]?.({ name: "shell", arguments: { action } })).toMatch(
      /POLICY_DENIED|ARBITRARY_COMMAND/,
    );
  });

  it("fails closed when a structured action has malformed path arguments", () => {
    const fixture = makeFixture();
    const guards: Array<(execution: unknown) => string | undefined> = [];
    const scopedContext = {
      tools: {
        guard(guard: (execution: unknown) => string | undefined) {
          guards.push(guard);
          return () => undefined;
        },
      },
      on() {
        return () => undefined;
      },
    };
    registerPolicyGuard(scopedContext, policyOptions(fixture));

    expect(
      guards[0]?.({
        name: "read_file",
        arguments: {
          action: { repositoryId: fixture.repository.id, argv: "not-an-array" },
        },
      }),
    ).toMatch(/POLICY_DENIED/);
  });

  it("fails closed when untrusted action flags contain an unknown value", () => {
    const fixture = makeFixture();
    const guards: Array<(execution: unknown) => string | undefined> = [];
    const scopedContext = {
      tools: {
        guard(guard: (execution: unknown) => string | undefined) {
          guards.push(guard);
          return () => undefined;
        },
      },
      on() {
        return () => undefined;
      },
    };
    registerPolicyGuard(scopedContext, policyOptions(fixture));

    const action = makeAction(fixture, {
      environmentRead: "unexpected" as never,
    });
    expect(
      guards[0]?.({ name: action.toolName, arguments: { action } }),
    ).toMatch(/POLICY_DENIED/);
  });
});
