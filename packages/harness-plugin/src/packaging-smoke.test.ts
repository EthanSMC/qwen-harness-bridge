import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildArtifact, CREDENTIAL_ASSIGNMENT } from "../scripts/package.mjs";
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

/** Compile only what is missing. Deleting a workspace `dist` here would race
 * sibling suites that resolve the same package during a full workspace run. */
const buildDist = () => {
  const protocolRoot = resolve(packageRoot, "../protocol");
  if (!existsSync(join(protocolRoot, "dist/index.js"))) {
    buildProject(protocolRoot);
  }
  if (
    !existsSync(join(packageRoot, "dist/index.js")) ||
    !existsSync(join(packageRoot, "dist/index.js.map"))
  ) {
    buildProject(packageRoot);
  }
  mkdirSync(join(packageRoot, "dist/store"), { recursive: true });
  cpSync(
    join(packageRoot, "src/store/schema.sql"),
    join(packageRoot, "dist/store/schema.sql"),
  );
};

it("packages a loadable artifact without any credential value", async () => {
  buildDist();
  const work = mkdtempSync(join(packageRoot, ".pack-smoke-"));
  const sentinel = "smoke-credential-sentinel-value";
  try {
    const artifact = buildArtifact({
      outFile: join(work, "qhb-harness-plugin.tar"),
      credentials: [sentinel, "qhb-connector-bootstrap-value"],
    });
    expect(artifact.version).toMatch(/^\d+\.\d+\.\d+/u);
    for (const required of [
      "package/package.json",
      "package/cordis.example.yml",
      "package/dist/index.js",
      "package/dist/index.js.map",
      "package/dist/store/schema.sql",
    ]) {
      expect(artifact.entries).toContain(required);
    }

    // Install into a temporary Harness extension root.
    const extensionRoot = join(work, "extension");
    const entries = readTar(readFileSync(artifact.outFile));
    expect(entries.length).toBe(artifact.entries.length);
    for (const entry of entries) {
      expect(entry.name.startsWith("package/")).toBe(true);
      const target = join(extensionRoot, entry.name.slice("package/".length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }

    // The packaged entry imports and exports the Cordis plugin identity.
    const entry = await import(
      pathToFileURL(join(extensionRoot, "dist/index.js")).href
    );
    expect(typeof entry.apply).toBe("function");
    expect(entry.name).toBe("qwen-harness-bridge");
    expect([...entry.inject]).toEqual([
      "agents",
      "sessions",
      "sessionPersistence",
      "approval",
      "tools",
    ]);

    // Sample wiring loads with the expected keys and no credential material.
    const sample = readFileSync(
      join(extensionRoot, "cordis.example.yml"),
      "utf8",
    );
    for (const key of [
      "connectorId:",
      "controlPlaneUrl:",
      "keychainService:",
      "keychainAccount:",
      "databasePath:",
      "canonicalPath:",
      "approvalTimeoutSeconds:",
    ]) {
      expect(sample).toContain(key);
    }
    // Prose may mention credentials; the sample must not assign one.
    expect(sample).not.toMatch(CREDENTIAL_ASSIGNMENT);
    expect(sample).not.toMatch(
      /^\s*(?:token|api[_-]?key|secret|password)\s*:/imu,
    );

    // No credential value or credential-looking assignment anywhere in the artifact.
    const serialized = entries
      .map((value) => value.data.toString("utf8"))
      .join("\n");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toMatch(CREDENTIAL_ASSIGNMENT);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
