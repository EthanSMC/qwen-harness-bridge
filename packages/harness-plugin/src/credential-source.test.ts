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
import { expect, it } from "vitest";
import { ConfigValidationError, parsePluginConfig } from "./config.js";
import { createCredentialReader } from "./credential-source.js";
import { CredentialUnavailableError } from "./keychain.js";

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "qhb-cred-")));
const repository = join(directory, "repository");
mkdirSync(repository, { recursive: true });

const baseConfig = (credentialSource?: unknown) => ({
  connectorId: "00000000-0000-4000-8000-000000000000",
  controlPlaneUrl: "wss://control-plane.example.com/connector/v1",
  keychainService: "qhb-connector",
  keychainAccount: "qhb-connector-bootstrap",
  databasePath: join(directory, "connector.sqlite"),
  repositories: [
    {
      id: "example",
      displayName: "Example repository",
      canonicalPath: repository,
      approvalTimeoutSeconds: 300,
    },
  ],
  ...(credentialSource === undefined ? {} : { credentialSource }),
});

const secretFile = (name: string, content: string) => {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
};

it("keeps macOS Keychain as the default and explicit source", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const selected = createCredentialReader(parsePluginConfig(baseConfig()), {
      platform,
    });
    expect(selected.kind).toBe("keychain");
  }
  const explicit = createCredentialReader(
    parsePluginConfig(baseConfig({ kind: "keychain" })),
    { platform: "win32" },
  );
  expect(explicit.kind).toBe("keychain");
});

it("fails closed when a Keychain read is unavailable", async () => {
  const selected = createCredentialReader(parsePluginConfig(baseConfig()), {
    platform: "win32",
  });
  await expect(
    selected.reader.read("qhb-connector-missing", "qhb-connector-missing"),
  ).rejects.toBeInstanceOf(CredentialUnavailableError);
});

it("reads a bounded file source and trims one trailing newline", async () => {
  const selected = createCredentialReader(
    parsePluginConfig(
      baseConfig({
        kind: "file",
        path: secretFile("single.secret", "value-1\n"),
      }),
    ),
    { platform: "win32" },
  );
  expect(selected.kind).toBe("file");
  await expect(selected.reader.read("ignored", "ignored")).resolves.toBe(
    "value-1",
  );

  const doubled = createCredentialReader(
    parsePluginConfig(
      baseConfig({
        kind: "file",
        path: secretFile("double.secret", "value-2\n\n"),
      }),
    ),
  );
  await expect(doubled.reader.read("ignored", "ignored")).resolves.toBe(
    "value-2\n",
  );
});

it("fails closed for missing, empty, non-regular, symlinked and oversized files", async () => {
  const missing = createCredentialReader(
    parsePluginConfig(
      baseConfig({ kind: "file", path: join(directory, "absent.secret") }),
    ),
  );
  await expect(missing.reader.read("a", "b")).rejects.toBeInstanceOf(
    CredentialUnavailableError,
  );

  const empty = createCredentialReader(
    parsePluginConfig(
      baseConfig({ kind: "file", path: secretFile("empty.secret", "") }),
    ),
  );
  await expect(empty.reader.read("a", "b")).rejects.toBeInstanceOf(
    CredentialUnavailableError,
  );

  const asDirectory = createCredentialReader(
    parsePluginConfig(
      baseConfig({ kind: "file", path: join(directory, "repository") }),
    ),
  );
  await expect(asDirectory.reader.read("a", "b")).rejects.toBeInstanceOf(
    CredentialUnavailableError,
  );

  const symlinkTarget = secretFile("real.secret", "value-3\n");
  const linkPath = join(directory, "link.secret");
  let symlinkCreated = false;
  try {
    symlinkSync(symlinkTarget, linkPath, "file");
    symlinkCreated = true;
  } catch {
    // Windows without developer mode cannot create file symlinks; skip only this
    // case, and never swallow an assertion failure for a symlink that did exist.
  }
  if (symlinkCreated) {
    const linked = createCredentialReader(
      parsePluginConfig(baseConfig({ kind: "file", path: linkPath })),
    );
    await expect(linked.reader.read("a", "b")).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    );
  }

  const oversized = createCredentialReader(
    parsePluginConfig(
      baseConfig({
        kind: "file",
        path: secretFile("large.secret", "x".repeat(16 * 1024 + 1)),
      }),
    ),
  );
  await expect(oversized.reader.read("a", "b")).rejects.toBeInstanceOf(
    CredentialUnavailableError,
  );
});

it("reads a bounded environment source", async () => {
  const environment = { QHB_TEST_BOOTSTRAP: "value-4\n" };
  const selected = createCredentialReader(
    parsePluginConfig(
      baseConfig({ kind: "environment", variable: "QHB_TEST_BOOTSTRAP" }),
    ),
    { platform: "linux", environment },
  );
  expect(selected.kind).toBe("environment");
  await expect(selected.reader.read("ignored", "ignored")).resolves.toBe(
    "value-4",
  );

  for (const missing of [
    { QHB_OTHER: "value" },
    { QHB_TEST_BOOTSTRAP: "" },
    { QHB_TEST_BOOTSTRAP: "y".repeat(16 * 1024 + 1) },
  ]) {
    const reader = createCredentialReader(
      parsePluginConfig(
        baseConfig({ kind: "environment", variable: "QHB_TEST_BOOTSTRAP" }),
      ),
      { platform: "linux", environment: missing },
    );
    await expect(reader.reader.read("a", "b")).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    );
  }
});

it("rejects ambiguous, malformed or relative credential configuration", () => {
  const invalid = (source: unknown) =>
    expect(() => parsePluginConfig(baseConfig(source))).toThrow(
      ConfigValidationError,
    );
  invalid({ kind: "file", path: "relative/secret" });
  invalid({ kind: "environment", variable: "1 invalid name" });
  invalid({ kind: "unknown" });
  invalid({ kind: "file", path: join(directory, "x"), variable: "EXTRA" });
  invalid({ kind: "keychain", path: join(directory, "x") });
});

it("removes the temporary fixture tree", () => {
  rmSync(directory, { recursive: true, force: true });
});
