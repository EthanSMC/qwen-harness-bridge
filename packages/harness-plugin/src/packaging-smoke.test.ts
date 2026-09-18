import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  assertCredentialFree,
  buildArtifact,
  CREDENTIAL_ASSIGNMENT,
  findCredentialAssignment,
  HOST_PEER_PREFIX,
  runtimeClosure,
} from "../scripts/package.mjs";
import {
  createCleanRoot,
  hasNodeModulesAncestor,
  hasRepositoryAncestor,
  isInsideRepository,
  linkHostPeers,
} from "../scripts/smoke-root.mjs";
import { readTar } from "../scripts/tar.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const tsc = join(repositoryRoot, "node_modules/typescript/bin/tsc");

const buildProject = (directory: string) => {
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: directory,
    stdio: "inherit",
  });
};

const newestSourceMtime = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
};

/** Compile what is missing or stale. Deleting a workspace `dist` here would
 * race sibling suites that resolve the same package during a full run. */
const ensureDist = () => {
  const protocolRoot = resolve(packageRoot, "../protocol");
  if (!existsSync(join(protocolRoot, "dist/index.js"))) {
    buildProject(protocolRoot);
  }
  const built = join(packageRoot, "dist/index.js");
  if (
    !existsSync(built) ||
    !existsSync(join(packageRoot, "dist/index.js.map")) ||
    newestSourceMtime(join(packageRoot, "src")) > statSync(built).mtimeMs
  ) {
    buildProject(packageRoot);
  }
  mkdirSync(join(packageRoot, "dist/store"), { recursive: true });
  cpSync(
    join(packageRoot, "src/store/schema.sql"),
    join(packageRoot, "dist/store/schema.sql"),
  );
};

interface ArchiveEntry {
  readonly name: string;
  readonly data: Buffer;
}

const extract = (entries: readonly ArchiveEntry[], extensionRoot: string) => {
  for (const item of entries) {
    const target = join(extensionRoot, item.name.slice("package/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.data);
  }
};

/** Installs and exercises the packaged entry in a separate process, exactly as
 * a Harness host would, so the test process never loads the artifact itself. */
const runProbe = (root: string, extensionRoot: string, config: unknown) => {
  const probePath = join(root, "probe.mjs");
  const configPath = join(root, "probe-config.json");
  cpSync(join(packageRoot, "scripts/probe-install.mjs"), probePath);
  writeFileSync(configPath, JSON.stringify(config));
  const stdout = execFileSync(
    process.execPath,
    [probePath, extensionRoot, configPath],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
};

const removeRoot = (root: string) => {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
};

/** True when any entry named `segment` exists anywhere below `root`. */
const containsPathSegment = (root: string, segment: string): boolean => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === segment) return true;
    if (
      entry.isDirectory() &&
      containsPathSegment(join(root, entry.name), segment)
    ) {
      return true;
    }
  }
  return false;
};

it("detects credential-looking assignments without flagging code", () => {
  for (const text of [
    'bootstrapToken: "abcdefgh"',
    "bootstrapToken=abc123def456ghi789",
    'api_key: "sk-1234567890"',
    "password = hunter2hunter2hunter2",
    '{"secret":"abcdefghijkl"}',
    "sessionSecret: 9f8e7d6c5b4a3210",
  ]) {
    expect(findCredentialAssignment(text), text).not.toBeNull();
  }
  for (const text of [
    "token: z.string().min(1)",
    'token = Symbol("event-task");',
    'password = ""',
    "token: string;",
    "sessionTokenClient: SessionTokenClient",
    "keychainAccount: qhb-connector-bootstrap",
  ]) {
    expect(findCredentialAssignment(text), text).toBeNull();
  }
  expect(() =>
    assertCredentialFree([
      {
        name: "package/dist/index.js",
        data: Buffer.from('bootstrapToken: "abcdefgh"', "utf8"),
      },
    ]),
  ).toThrow();
  expect(() =>
    assertCredentialFree([
      { name: "package/dist/index.js", data: Buffer.from("token: z.string()") },
    ]),
  ).not.toThrow();
});

/** The option-A mechanism, kept for any future native runtime dependency: a
 * package bound to the host ABI is skipped by the vendored closure, so the
 * profile installs it for the operator's runtime instead of shipping a binary
 * built here. */
it("keeps a host-installed native module and its closure out of the vendored tree", () => {
  const closure = runtimeClosure(
    { dependencies: { "better-sqlite3": "^12.10.0", ws: "^8.21.3" } },
    packageRoot,
    ["better-sqlite3"],
  );
  const names = [...closure.keys()];
  expect(names).toContain("ws");
  expect(names).not.toContain("better-sqlite3");
  // Nothing native-only may arrive through the skipped package's own closure.
  expect(names).not.toContain("bindings");
  expect(names).not.toContain("prebuild-install");
});

/** The option-A stand-in for a host-bound package: the smoke root links the
 * host's own build of the native package, so the artifact is proven to resolve
 * it from the host instead of shipping a binary compiled for another ABI. */
it("links the host's native stand-in build instead of a vendored copy", () => {
  const root = createCleanRoot({
    repositoryRoot,
    label: "qhb-native-stand-in",
  });
  try {
    const linked = linkHostPeers({
      extensionRoot: root,
      packageRoot,
      peers: ["better-sqlite3"],
    });
    expect(linked).toEqual(["better-sqlite3"]);
    const linkPath = join(root, "node_modules", "better-sqlite3");
    expect(existsSync(join(linkPath, "package.json"))).toBe(true);
    expect(realpathSync.native(linkPath)).toBe(
      realpathSync.native(join(packageRoot, "node_modules", "better-sqlite3")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("packages a self-contained artifact that installs outside the repository", async () => {
  ensureDist();
  const sentinel = "smoke-credential-sentinel-value";
  const root = createCleanRoot({ repositoryRoot, label: "qhb-pack-smoke" });
  const controlRoot = createCleanRoot({
    repositoryRoot,
    label: "qhb-pack-control",
  });
  try {
    expect(isInsideRepository(root, repositoryRoot)).toBe(false);
    expect(hasRepositoryAncestor(root)).toBe(false);
    expect(hasNodeModulesAncestor(root)).toBe(false);

    const artifact = buildArtifact({
      outFile: join(root, "qhb-harness-plugin.tar"),
      credentials: [sentinel, "qhb-connector-bootstrap-value"],
    });
    const entries: ArchiveEntry[] = readTar(readFileSync(artifact.outFile));
    expect(entries.length).toBe(artifact.entries.length);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);

    // The private workspace package is vendored into the archive, never
    // referenced as an installable specifier.
    expect(artifact.vendoredDependencies).toContain("@qhb/protocol");
    expect(JSON.stringify(artifact.manifest.dependencies ?? {})).not.toContain(
      "workspace:",
    );
    for (const name of ["@qhb/protocol", "zod", "ws"]) {
      expect(artifact.vendoredDependencies).toContain(name);
    }
    // The connector has no native runtime dependency: the durable store uses
    // the built-in node:sqlite, so nothing has to be built for the host ABI.
    expect(artifact.vendoredDependencies).not.toContain("better-sqlite3");
    expect(artifact.hostInstalledDependencies).toEqual([]);
    expect(artifact.entries).not.toContain(
      "package/node_modules/better-sqlite3/package.json",
    );

    // Vendored third-party license text must travel with the artifact.
    expect(artifact.vendoredLicenses).toEqual(
      [...artifact.vendoredLicenses].sort(),
    );
    // Host-installed native modules bring their own license with the profile
    // install; only vendored packages are inventoried here.
    for (const expected of ["ws/LICENSE", "zod/LICENSE"]) {
      expect(artifact.vendoredLicenses, expected).toContain(expected);
    }
    for (const license of artifact.vendoredLicenses) {
      expect(artifact.entries, license).toContain(
        `package/node_modules/${license}`,
      );
    }

    const packageManifest = JSON.parse(
      entries
        .find((item) => item.name === "package/package.json")
        ?.data.toString("utf8") ?? "{}",
    );
    const peers = Object.keys(packageManifest.peerDependencies ?? {});
    // The artifact must install as a DSH profile layer, not a plain dependency.
    expect(packageManifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(artifact.entries).toContain("package/cordis.patch.yml");

    const extensionRoot = join(root, "extension");
    extract(entries, extensionRoot);
    for (const name of artifact.vendoredDependencies) {
      expect(
        existsSync(join(extensionRoot, "node_modules", name, "package.json")),
        name,
      ).toBe(true);
    }
    expect(
      existsSync(
        join(extensionRoot, "node_modules", HOST_PEER_PREFIX.slice(0, -1)),
      ),
    ).toBe(false);
    // The absent-native proof the packaging decision requires: a recursive scan
    // finds no better-sqlite3 entry anywhere below this clean root, so the
    // journal the probe opens below can only come from the host's built-in
    // node:sqlite.
    expect(containsPathSegment(extensionRoot, "better-sqlite3")).toBe(false);
    // Only the artifact's own node_modules may exist below the clean root.
    expect(hasNodeModulesAncestor(dirname(extensionRoot))).toBe(false);
    expect(hasRepositoryAncestor(dirname(extensionRoot))).toBe(false);

    // Host peers and host-built native modules are supplied the same way.
    linkHostPeers({
      extensionRoot,
      packageRoot,
      peers: [...peers, ...artifact.hostInstalledDependencies],
    });

    // The dsh bundle patch inserts the plugin entry; the operator profile patch
    // supplies the environment-specific config by id.
    const bundlePatch = parseYaml(
      readFileSync(join(extensionRoot, "cordis.patch.yml"), "utf8"),
    );
    expect(bundlePatch).toEqual([
      {
        insert: [{ id: "qwen-harness-bridge", name: "@qhb/harness-plugin" }],
      },
    ]);

    // Load the packaged sample wiring: the YAML is parsed here and validated by
    // the packaged config schema inside the probe process.
    const sample = readFileSync(
      join(extensionRoot, "cordis.example.yml"),
      "utf8",
    );
    expect(sample).not.toMatch(CREDENTIAL_ASSIGNMENT);
    const document = parseYaml(sample);
    expect(document.plugin).toBe("@qhb/harness-plugin");
    const stateDirectory = join(root, "state");
    const repositoryDirectory = join(root, "repository");
    mkdirSync(stateDirectory, { recursive: true });
    mkdirSync(repositoryDirectory, { recursive: true });
    const journal = join(stateDirectory, "connector.sqlite");
    const config = {
      ...document.config,
      databasePath: journal,
      repositories: document.config.repositories.map(
        (repository: Record<string, unknown>) => ({
          ...repository,
          canonicalPath: repositoryDirectory,
        }),
      ),
    };

    const probe = runProbe(root, extensionRoot, config);
    expect(probe.name).toBe("qwen-harness-bridge");
    expect(probe.apply).toBe("function");
    expect(probe.inject).toEqual([
      "agents",
      "sessions",
      "sessionPersistence",
      "approval",
      "tools",
    ]);
    expect(probe.connectorId).toBe(document.config.connectorId);
    expect(probe.controlPlaneUrl).toBe(document.config.controlPlaneUrl);
    expect(probe.keychainService).toBe(document.config.keychainService);
    expect(probe.repositoryCount).toBe(1);
    expect(probe.canonicalPath).toBe(repositoryDirectory);
    expect(probe.approvalTimeoutSeconds).toBe(300);
    // The probe opened the journal from the clean root with the host's built-in
    // node:sqlite; no native module is vendored or host-installed.
    expect(probe.databasePath).toBe(journal);
    expect(existsSync(journal)).toBe(true);

    // Fail closed: without the vendored private package the packaged entry
    // cannot even be imported, which proves the archive carries the runtime
    // instead of resolving it from the monorepo.
    const controlExtension = join(controlRoot, "extension");
    extract(
      entries.filter(
        (item) => !item.name.startsWith("package/node_modules/@qhb/protocol/"),
      ),
      controlExtension,
    );
    linkHostPeers({
      extensionRoot: controlExtension,
      packageRoot,
      peers: [...peers, ...artifact.hostInstalledDependencies],
    });
    expect(() => runProbe(controlRoot, controlExtension, config)).toThrow(
      /Cannot find package '@qhb\/protocol'/u,
    );

    // No credential value or credential-looking assignment anywhere.
    const serialized = entries
      .map((item) => item.data.toString("utf8"))
      .join("\n");
    expect(serialized).not.toContain(sentinel);
  } finally {
    removeRoot(root);
    removeRoot(controlRoot);
  }
}, 300_000);
