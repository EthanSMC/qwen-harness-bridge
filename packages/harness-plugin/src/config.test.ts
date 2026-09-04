import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError, parsePluginConfig } from "./config.js";
import {
  CredentialUnavailableError,
  MacOSKeychainCredentialReader,
} from "./keychain.js";

const temporaryDirectories: string[] = [];

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-plugin-config-"));
  const repository = join(directory, "repository");
  mkdirSync(repository);
  temporaryDirectories.push(directory);
  return {
    directory,
    repository,
    databasePath: join(directory, "state.sqlite"),
  };
};

const makeConfig = (
  fixture: ReturnType<typeof makeFixture>,
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    connectorId: "connector-1",
    controlPlaneUrl: "wss://control.example.test/connector",
    keychainService: "com.example.qhb",
    keychainAccount: "connector-1",
    databasePath: fixture.databasePath,
    repositories: [
      {
        id: "repo-one",
        displayName: "Repository One",
        canonicalPath: realpathSync(fixture.repository),
        approvalTimeoutSeconds: 300,
      },
    ],
    ...overrides,
  });

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      recursive: true,
      force: true,
    });
  }
});

describe("Harness plugin configuration", () => {
  it("rejects insecure ws control-plane URLs", () => {
    const fixture = makeFixture();

    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, { controlPlaneUrl: "ws://control.example.test" }),
      ),
    ).toThrow(ConfigValidationError);
  });

  it.each([
    "wss://user@control.example.test/connector",
    "wss://:password@control.example.test/connector",
    "wss://user:password@control.example.test/connector",
    "wss://control.example.test/connector?credential=private",
    "wss://control.example.test/connector?",
    "wss://control.example.test/connector#private",
    "wss://control.example.test/connector#",
  ])(
    "rejects control-plane URL authority or suffix data generically",
    (url) => {
      const fixture = makeFixture();

      expect(() =>
        parsePluginConfig(makeConfig(fixture, { controlPlaneUrl: url })),
      ).toThrowError("INVALID_PLUGIN_CONFIG");
      expect(() =>
        parsePluginConfig(makeConfig(fixture, { controlPlaneUrl: url })),
      ).not.toThrowError(/user|password|credential|private/);
    },
  );

  it("allows and preserves the intended wss control-plane path", () => {
    const fixture = makeFixture();

    expect(parsePluginConfig(makeConfig(fixture)).controlPlaneUrl).toBe(
      "wss://control.example.test/connector",
    );
  });

  it.each(["/private/repository", "Repo-one", "repo.one", "a", "a".repeat(51)])(
    "rejects invalid repository ID %s before reflecting it",
    (repositoryId) => {
      const fixture = makeFixture();
      const repository = JSON.parse(makeConfig(fixture)).repositories[0];
      repository.id = repositoryId;

      expect(() =>
        parsePluginConfig(makeConfig(fixture, { repositories: [repository] })),
      ).toThrowError("INVALID_PLUGIN_CONFIG");
      expect(() =>
        parsePluginConfig(makeConfig(fixture, { repositories: [repository] })),
      ).not.toThrowError(repositoryId);
    },
  );

  it("rejects duplicate repository IDs without exposing configured paths", () => {
    const fixture = makeFixture();
    const repository = JSON.parse(makeConfig(fixture)).repositories[0];

    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, { repositories: [repository, repository] }),
      ),
    ).toThrowError(/repo-one/);
    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, { repositories: [repository, repository] }),
      ),
    ).not.toThrowError(fixture.repository);
  });

  it("rejects a missing repository root with only its repository ID", () => {
    const fixture = makeFixture();
    const missingPath = join(fixture.directory, "does-not-exist");

    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, {
          repositories: [
            {
              id: "missing-repo",
              displayName: "Missing",
              canonicalPath: missingPath,
              approvalTimeoutSeconds: 300,
            },
          ],
        }),
      ),
    ).toThrowError(/missing-repo/);
    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, {
          repositories: [
            {
              id: "missing-repo",
              displayName: "Missing",
              canonicalPath: missingPath,
              approvalTimeoutSeconds: 300,
            },
          ],
        }),
      ),
    ).not.toThrowError(missingPath);
  });

  it("rejects a symlinked repository root whose real path differs", () => {
    const fixture = makeFixture();
    const linkPath = join(fixture.directory, "repository-link");
    symlinkSync(fixture.repository, linkPath, "dir");

    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, {
          repositories: [
            {
              id: "linked-repo",
              displayName: "Linked",
              canonicalPath: linkPath,
              approvalTimeoutSeconds: 300,
            },
          ],
        }),
      ),
    ).toThrowError(/linked-repo/);
    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, {
          repositories: [
            {
              id: "linked-repo",
              displayName: "Linked",
              canonicalPath: linkPath,
              approvalTimeoutSeconds: 300,
            },
          ],
        }),
      ),
    ).not.toThrowError(linkPath);
  });

  it.each([59, 1801])("rejects approval timeout %s seconds", (timeout) => {
    const fixture = makeFixture();

    expect(() =>
      parsePluginConfig(
        makeConfig(fixture, {
          repositories: [
            {
              id: "repo-one",
              displayName: "Repository One",
              canonicalPath: fixture.repository,
              approvalTimeoutSeconds: timeout,
            },
          ],
        }),
      ),
    ).toThrow(ConfigValidationError);
  });

  it("returns a canonical deeply immutable configuration", () => {
    const fixture = makeFixture();
    const config = parsePluginConfig(
      makeConfig(fixture, {
        connectorId: " connector-1 ",
        keychainService: " com.example.qhb ",
        keychainAccount: " connector-1 ",
      }),
    );

    expect(config.connectorId).toBe("connector-1");
    expect(config.repositories[0]?.canonicalPath).toBe(
      realpathSync(fixture.repository),
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.repositories)).toBe(true);
    expect(Object.isFrozen(config.repositories[0])).toBe(true);
  });

  it("accepts a first-install database file when its existing parent is valid", () => {
    const fixture = makeFixture();
    const nestedDirectory = join(fixture.directory, "nested-state");
    mkdirSync(nestedDirectory);
    const databasePath = join(nestedDirectory, "state.sqlite");

    expect(() =>
      parsePluginConfig(makeConfig(fixture, { databasePath })),
    ).not.toThrow();
  });

  it.each(["existing", "dangling"])(
    "rejects a %s final-component database symlink without exposing it",
    (targetKind) => {
      const fixture = makeFixture();
      const targetPath = join(fixture.directory, "database-target.sqlite");
      if (targetKind === "existing") writeFileSync(targetPath, "");
      symlinkSync(targetPath, fixture.databasePath);

      expect(() => parsePluginConfig(makeConfig(fixture))).toThrowError(
        "DATABASE_PATH_NOT_CANONICAL",
      );
      expect(() => parsePluginConfig(makeConfig(fixture))).not.toThrowError(
        fixture.databasePath,
      );
    },
  );
});

const makeFakeSpawn = (options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}) => {
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr,
      kill: vi.fn(() => true),
      unref: vi.fn(() => child),
    });
    queueMicrotask(() => {
      if (options.stdout !== undefined) stdout.end(options.stdout);
      if (options.stderr !== undefined) stderr.end(options.stderr);
      if (options.error !== undefined) child.emit("error", options.error);
      child.emit("close", options.exitCode ?? 0, options.signal ?? null);
    });
    return child;
  });
  return spawn;
};

const makeControlledSpawn = () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((_: NodeJS.Signals | number = "SIGTERM") => true);
  const unref = vi.fn(() => child);
  Object.assign(child, { stdout, stderr, kill, unref });
  return {
    child,
    stdout,
    stderr,
    kill,
    unref,
    spawn: vi.fn(() => child),
  };
};

describe("macOS Keychain credential reader", () => {
  it("uses security without a shell and returns only the credential", async () => {
    const spawn = makeFakeSpawn({ stdout: "bootstrap-secret\n" });
    const reader = new MacOSKeychainCredentialReader(spawn);

    await expect(reader.read("service-name", "account-name")).resolves.toBe(
      "bootstrap-secret",
    );
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "service-name",
        "-a",
        "account-name",
        "-w",
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it("maps command failures to a safe credential-unavailable error", async () => {
    const spawn = makeFakeSpawn({
      stderr: "credential value must not appear in this error",
      exitCode: 1,
    });
    const reader = new MacOSKeychainCredentialReader(spawn);

    await expect(reader.read("service-name", "account-name")).rejects.toEqual(
      expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
    );
    await expect(
      reader.read("service-name", "account-name"),
    ).rejects.not.toThrow(/credential value|service-name|account-name/);
    expect(CredentialUnavailableError.code).toBe(
      "CONNECTOR_CREDENTIAL_UNAVAILABLE",
    );
  });

  it("settles once when spawn error races the close event", async () => {
    const spawn = makeFakeSpawn({
      error: new Error("private spawn details"),
      exitCode: 1,
      signal: "SIGTERM",
    });
    const reader = new MacOSKeychainCredentialReader(spawn);

    await expect(
      reader.read("private-service", "private-account"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
    );
  });

  it("rejects a signaled security process and caps stderr without exposing it", async () => {
    const stderr = `private stderr ${"x".repeat(2_048)}`;
    const spawn = makeFakeSpawn({
      stdout: "private credential",
      stderr,
      exitCode: null,
      signal: "SIGTERM",
    });
    const reader = new MacOSKeychainCredentialReader(spawn);

    const result = reader.read("private-service", "private-account");
    await expect(result).rejects.toEqual(
      expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
    );
    await expect(result).rejects.not.toThrow(
      /private stderr|private-service|private-account|private credential/,
    );
  });

  it("times out, terminates the child, and settles safely across kill races", async () => {
    vi.useFakeTimers();
    const controlled = makeControlledSpawn();
    controlled.kill.mockImplementation(() => {
      controlled.child.emit("error", new Error("private kill race"));
      controlled.child.emit("close", null, "SIGTERM");
      return true;
    });
    const reader = new MacOSKeychainCredentialReader(controlled.spawn, 10);
    const result = reader.read("private-service", "private-account");
    const rejection = expect(result).rejects.toEqual(
      expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
    );

    await vi.advanceTimersByTimeAsync(10);
    const killCountAfterTimeout = controlled.kill.mock.calls.length;
    if (killCountAfterTimeout === 0) {
      controlled.child.emit("close", 1, null);
    }

    await rejection;
    expect(killCountAfterTimeout).toBe(1);
    expect(controlled.kill).toHaveBeenCalledWith("SIGTERM");
    expect(controlled.child.listenerCount("error")).toBe(0);
    expect(controlled.child.listenerCount("close")).toBe(0);
    expect(controlled.stdout.listenerCount("data")).toBe(0);
    expect(controlled.stdout.listenerCount("error")).toBe(0);
    expect(controlled.stderr.listenerCount("data")).toBe(0);
    expect(controlled.stderr.listenerCount("error")).toBe(0);
  });

  it("preserves the ten-second default credential timeout", async () => {
    vi.useFakeTimers();
    const controlled = makeControlledSpawn();
    const reader = new MacOSKeychainCredentialReader(controlled.spawn);
    const result = reader.read("private-service", "private-account");
    const rejection = expect(result).rejects.toEqual(
      expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(controlled.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(controlled.kill).toHaveBeenCalledWith("SIGTERM");

    controlled.child.emit("close", null, "SIGTERM");
    await vi.runAllTimersAsync();
  });

  it.each(["false", "throw", "no-close"] as const)(
    "escalates and fully releases a child when SIGTERM is %s",
    async (termBehavior) => {
      vi.useFakeTimers();
      const controlled = makeControlledSpawn();
      controlled.kill.mockImplementation((signal) => {
        if (signal === "SIGTERM") {
          if (termBehavior === "throw") {
            throw new Error("private SIGTERM failure");
          }
          return termBehavior === "no-close";
        }
        return false;
      });
      const retainedSecret = Buffer.from("private retained credential");
      const reader = new MacOSKeychainCredentialReader(controlled.spawn, 10);
      const result = reader.read("private-service", "private-account");
      const rejection = expect(result).rejects.toEqual(
        expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
      );
      const redaction = expect(result).rejects.not.toThrow(
        /private|credential|service|account|SIGTERM/,
      );
      controlled.stdout.emit("data", retainedSecret);

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      await redaction;
      await vi.runAllTimersAsync();

      expect(controlled.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(retainedSecret.equals(Buffer.alloc(retainedSecret.length))).toBe(
        true,
      );
      expect(controlled.stdout.destroyed).toBe(true);
      expect(controlled.stderr.destroyed).toBe(true);
      expect(controlled.unref).toHaveBeenCalled();
      expect(controlled.child.listenerCount("error")).toBe(0);
      expect(controlled.child.listenerCount("close")).toBe(0);
      expect(controlled.stdout.listenerCount("data")).toBe(0);
      expect(controlled.stdout.listenerCount("error")).toBe(0);
      expect(controlled.stderr.listenerCount("data")).toBe(0);
      expect(controlled.stderr.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "handles a private %s stream error and terminates the child",
    async (streamName) => {
      const controlled = makeControlledSpawn();
      controlled.kill.mockImplementation(() => {
        controlled.child.emit("error", new Error("private child race"));
        controlled.child.emit("close", null, "SIGTERM");
        return true;
      });
      const reader = new MacOSKeychainCredentialReader(controlled.spawn);
      const result = reader.read("private-service", "private-account");

      controlled[streamName].emit(
        "error",
        new Error(`private ${streamName} details`),
      );

      await expect(result).rejects.toEqual(
        expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
      );
      await expect(result).rejects.not.toThrow(
        /private|service|account|stdout|stderr/,
      );
      expect(controlled.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it.each([
    ["stdout", "x".repeat(16 * 1_024 + 1)],
    ["stderr", "x".repeat(1_025)],
  ] as const)(
    "terminates the child when %s exceeds its memory bound",
    async (streamName, content) => {
      const controlled = makeControlledSpawn();
      const reader = new MacOSKeychainCredentialReader(controlled.spawn);
      const result = reader.read("private-service", "private-account");

      controlled[streamName].end(content);
      controlled.child.emit("close", 0, null);

      await expect(result).rejects.toEqual(
        expect.objectContaining({ code: "CONNECTOR_CREDENTIAL_UNAVAILABLE" }),
      );
      expect(controlled.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("rejects an unbounded internal timeout without exposing its value", () => {
    const controlled = makeControlledSpawn();

    expect(
      () =>
        new MacOSKeychainCredentialReader(
          controlled.spawn,
          Number.MAX_SAFE_INTEGER,
        ),
    ).toThrowError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
  });
});
