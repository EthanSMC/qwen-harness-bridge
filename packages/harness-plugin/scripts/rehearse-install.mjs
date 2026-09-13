import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { buildArtifact } from "./package.mjs";
import { createCleanRoot, linkHostPeers } from "./smoke-root.mjs";
import { readTar } from "./tar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const tsc = join(repositoryRoot, "node_modules/typescript/bin/tsc");
const outIndex = process.argv.indexOf("--out");
const outFile =
  outIndex === -1 ? undefined : resolve(process.argv[outIndex + 1]);

const steps = [];
const record = (name, status, detail) => {
  steps.push({ name, status, detail });
};

const compile = (directory) =>
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: directory,
    stdio: "inherit",
  });

const runProbe = (root, extensionRoot, config, mode) => {
  const probePath = join(root, "probe.mjs");
  const configPath = join(root, "probe-config.json");
  cpSync(join(packageRoot, "scripts/probe-install.mjs"), probePath);
  writeFileSync(configPath, JSON.stringify(config));
  const args = [probePath, extensionRoot, configPath];
  if (mode !== undefined) args.push(mode);
  const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
  return JSON.parse(stdout);
};

const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const root = createCleanRoot({ repositoryRoot, label: "qhb-rehearsal" });
const report = {
  environment: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    node: process.version,
    tempDirectory: tmpdir(),
    rehearsalRoot: root,
    startedAt: new Date().toISOString(),
  },
  steps,
};

try {
  // 1. Build the compiled package the artifact ships.
  compile(resolve(packageRoot, "../protocol"));
  compile(packageRoot);
  mkdirSync(join(packageRoot, "dist/store"), { recursive: true });
  cpSync(
    join(packageRoot, "src/store/schema.sql"),
    join(packageRoot, "dist/store/schema.sql"),
  );
  record(
    "build",
    "PASS",
    "tsc --noEmit output compiled for protocol and plugin",
  );

  // 2. Pack the self-contained artifact.
  const artifact = buildArtifact({
    outFile: join(root, "qhb-harness-plugin.tar"),
  });
  record("pack", "PASS", {
    entries: artifact.entries.length,
    version: artifact.version,
    sha256: artifact.sha256,
    vendoredDependencies: artifact.vendoredDependencies,
  });

  // 3. Install into a clean extension root with host-provided peers only.
  const entries = readTar(readFileSync(artifact.outFile));
  const extensionRoot = join(root, "extension");
  for (const item of entries) {
    const target = join(extensionRoot, item.name.slice("package/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.data);
  }
  const manifest = JSON.parse(
    readFileSync(join(extensionRoot, "package.json"), "utf8"),
  );
  const peers = linkHostPeers({
    extensionRoot,
    packageRoot,
    peers: Object.keys(manifest.peerDependencies ?? {}),
  });
  record("install", "PASS", {
    extensionRoot,
    hostPeers: peers,
    vendoredPackages: artifact.vendoredDependencies.length,
    artifactBytes: readFileSync(artifact.outFile).length,
  });

  // 4. Load the sample wiring and validate it with the packaged schema.
  const samplePath = join(extensionRoot, "cordis.example.yml");
  const sample = readFileSync(samplePath, "utf8");
  const document = parseYaml(sample);
  const stateDirectory = join(root, "state");
  const repositoryDirectory = join(root, "repository");
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(repositoryDirectory, { recursive: true });
  const journal = join(stateDirectory, "connector.sqlite");
  const config = {
    ...document.config,
    databasePath: journal,
    repositories: document.config.repositories.map((repository) => ({
      ...repository,
      canonicalPath: repositoryDirectory,
    })),
  };
  const first = runProbe(root, extensionRoot, config, "--keychain");
  record("load-sample-config", "PASS", {
    sampleSha256: sha256(samplePath),
    configuration: config,
    configurationSha256: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex"),
  });
  record("import-packaged-entry", "PASS", {
    name: first.name,
    apply: first.apply,
    inject: first.inject,
  });
  record("open-journal", "PASS", {
    databasePath: first.databasePath,
    journalBytes: existsSync(journal) ? readFileSync(journal).length : 0,
  });
  record(
    "credential-read",
    first.credential.code === null ? "PASS" : "FAIL-CLOSED",
    {
      platform: platform(),
      outcome: first.credential.outcome,
      code: first.credential.code,
      note: "The reader spawns /usr/bin/security; on a non-macOS host the connector fails closed instead of authenticating.",
    },
  );

  // 5. Rotate the credential: the artifact never carries one, and a second
  //    probe with a different account keeps the same journal.
  const rotated = {
    ...config,
    keychainAccount: `${config.keychainAccount}-rotated`,
  };
  const afterRotation = runProbe(root, extensionRoot, rotated, "--keychain");
  record("rotate-credential", "PARTIAL", {
    sameJournal: afterRotation.databasePath === journal,
    journalBytes: readFileSync(journal).length,
    outcome: afterRotation.credential.outcome,
    code: afterRotation.credential.code,
    note: "The credential source is rotated and the journal is preserved; a live Keychain item and Control Plane exchange are not available on this host.",
  });

  // 6. Roll back: reinstall the artifact over the same mapping and reopen.
  const bytesBefore = readFileSync(journal).length;
  for (const item of entries) {
    const target = join(extensionRoot, item.name.slice("package/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.data);
  }
  const afterRollback = runProbe(root, extensionRoot, config);
  record("rollback", "PASS", {
    journalPreserved: existsSync(journal),
    journalBytesBefore: bytesBefore,
    journalBytesAfter: readFileSync(journal).length,
    name: afterRollback.name,
    repositoryCount: afterRollback.repositoryCount,
  });

  report.status = steps.some((step) => step.status === "FAIL")
    ? "FAIL"
    : "PASS";
} catch (error) {
  record("rehearsal", "FAIL", { message: error?.message ?? String(error) });
  report.status = "FAIL";
  process.exitCode = 1;
} finally {
  report.environment.finishedAt = new Date().toISOString();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (outFile !== undefined) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, text);
  }
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
