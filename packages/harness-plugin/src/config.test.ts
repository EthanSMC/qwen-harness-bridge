import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
    Object.assign(child, { stdout, stderr });
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
});
