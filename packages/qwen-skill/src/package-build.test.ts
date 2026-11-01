import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const buildScript = join(packageRoot, "scripts", "build-package.mjs");
const checkScript = join(packageRoot, "scripts", "check-package.mjs");

const requiredEntries = [
  "SKILL.md",
  "config/repositories.json",
  "mcp.import.example.json",
  "references/errors.md",
  "references/intents.md",
  "references/speech-contract.md",
  "references/tool-contract.md",
  "references/ui-contract.md",
  "skill.json",
];

const workDirectories: string[] = [];
const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `qhb-${label}-`));
  workDirectories.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of workDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sourceCommit = (): string =>
  execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

type RunResult = { code: number; output: string };

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of ["GITHUB_SHA", "QHB_SOURCE_COMMIT", "SOURCE_COMMIT"]) {
    delete environment[key];
  }
  return environment;
};

const run = (
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv = cleanEnvironment(),
): RunResult => {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      }),
    };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

const copyPackage = (label: string): string => {
  const root = join(temporaryDirectory(label), "qwen-skill");
  cpSync(packageRoot, root, {
    recursive: true,
    filter: (source) => !/node_modules|dist/u.test(source),
  });
  return root;
};

const build = (
  root: string,
  out: string,
  extra: string[] = [],
  environment: NodeJS.ProcessEnv = cleanEnvironment(),
): RunResult =>
  run(buildScript, ["--root", root, "--out", out, ...extra], environment);

const check = (root: string, packageDirectory: string): RunResult =>
  run(checkScript, ["--root", root, "--package", packageDirectory]);

type Manifest = {
  version: string;
  monorepo_version: string;
  source_commit: string;
  archive: string;
  archive_sha256: string;
  mcp_tools: string[];
  entries: { path: string; bytes: number; sha256: string }[];
};

const readManifest = (out: string): Manifest =>
  JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

describe("reproducible private package build", () => {
  it("builds a manifest and archive with the required content only", () => {
    const out = join(temporaryDirectory("artifact"), "dist");
    const result = build(packageRoot, out, ["--source-commit", sourceCommit()]);

    expect(result.code).toBe(0);
    const manifest = readManifest(out);
    expect(manifest.version).toBe("0.3.0");
    expect(manifest.monorepo_version).toBe(
      readJson<{ version: string }>(join(repoRoot, "package.json")).version,
    );
    expect(manifest.source_commit).toBe(sourceCommit());
    expect(manifest.archive).toBe("qwen-skill-0.3.0.zip");
    expect(manifest.archive_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(join(out, manifest.archive))).toBe(true);
    expect(existsSync(join(out, "SHA256SUMS"))).toBe(true);

    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    for (const required of requiredEntries) expect(paths).toContain(required);
    for (const forbidden of [
      /^fixtures\//u,
      /\.test\.ts$/u,
      /\.map$/u,
      /(?:^|\/)\.env/u,
      /keychain/iu,
      /^dist\//u,
    ]) {
      expect(paths.some((path) => forbidden.test(path))).toBe(false);
    }
    expect(manifest.mcp_tools).toHaveLength(7);
  });

  it("produces the same digest for two builds of the same source", () => {
    const first = join(temporaryDirectory("repro-a"), "dist");
    const second = join(temporaryDirectory("repro-b"), "dist");
    const commit = sourceCommit();

    expect(build(packageRoot, first, ["--source-commit", commit]).code).toBe(0);
    expect(build(packageRoot, second, ["--source-commit", commit]).code).toBe(
      0,
    );

    const firstManifest = readManifest(first);
    const secondManifest = readManifest(second);
    expect(secondManifest.archive_sha256).toBe(firstManifest.archive_sha256);
    expect(
      readFileSync(join(second, secondManifest.archive)).equals(
        readFileSync(join(first, firstManifest.archive)),
      ),
    ).toBe(true);
  });

  it("excludes local reports, environment files, keychain material and maps", () => {
    const root = copyPackage("excluded");
    writeFileSync(join(root, ".env"), "QWEN_MCP_BEARER_TOKEN=placeholder\n");
    writeFileSync(join(root, "keychain-material.pem"), "-----BEGIN KEY-----\n");
    writeFileSync(join(root, "src", "generated.js.map"), "{}\n");
    writeFileSync(join(root, "local-report.md"), "# local report\n");

    const out = join(temporaryDirectory("excluded-out"), "dist");
    const result = build(root, out, ["--source-commit", sourceCommit()]);

    expect(result.code).toBe(0);
    const paths = readManifest(out).entries.map((entry) => entry.path);
    for (const forbidden of [
      /(?:^|\/)\.env/u,
      /keychain/iu,
      /\.map$/u,
      /local-report\.md/u,
      /^fixtures\//u,
    ]) {
      expect(paths.some((path) => forbidden.test(path))).toBe(false);
    }
  });

  it("fails when skill.json and the package version differ", () => {
    const root = copyPackage("version");
    const skill = readJson<Record<string, unknown>>(join(root, "skill.json"));
    writeFileSync(
      join(root, "skill.json"),
      JSON.stringify({ ...skill, version: "9.9.9" }, null, 2),
    );

    const result = build(
      root,
      join(temporaryDirectory("version-out"), "dist"),
      ["--source-commit", sourceCommit()],
    );

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/VERSION_MISMATCH|version/iu);
  });

  it("builds outside a git checkout when the environment provides the commit", () => {
    const root = copyPackage("no-git-env");
    const out = join(temporaryDirectory("no-git-env-out"), "dist");
    const commit = "0123456789abcdef0123456789abcdef01234567";

    const result = build(root, out, [], {
      ...cleanEnvironment(),
      GITHUB_SHA: commit,
    });

    expect(result.code).toBe(0);
    expect(readManifest(out).source_commit).toBe(commit);
  });

  it("fails outside a git checkout without a source commit", () => {
    const root = copyPackage("no-git");
    const out = join(temporaryDirectory("no-git-out"), "dist");

    const result = build(root, out);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/SOURCE_COMMIT|source commit/iu);
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });

  it("refuses an MCP import that contains a literal credential", () => {
    const root = copyPackage("secret");
    const imported = readJson<{
      servers: { auth: { token_secret_ref: string } }[];
    }>(join(root, "mcp.import.example.json"));
    imported.servers[0].auth.token_secret_ref = [
      "Bearer",
      "abcdefgh12345678",
    ].join(" ");
    writeFileSync(
      join(root, "mcp.import.example.json"),
      JSON.stringify(imported, null, 2),
    );

    const result = build(root, join(temporaryDirectory("secret-out"), "dist"), [
      "--source-commit",
      sourceCommit(),
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/secret|credential/iu);
  });
});

describe("independent package check", () => {
  it("accepts the built artifact and reports the digest and protocol surface", () => {
    const out = join(temporaryDirectory("check"), "dist");
    expect(
      build(packageRoot, out, ["--source-commit", sourceCommit()]).code,
    ).toBe(0);

    const result = check(packageRoot, out);

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/PASS/u);
    expect(result.output).toMatch(/[0-9a-f]{64}/u);
  });

  it("rejects a tampered archive digest", () => {
    const out = join(temporaryDirectory("tamper-digest"), "dist");
    expect(
      build(packageRoot, out, ["--source-commit", sourceCommit()]).code,
    ).toBe(0);
    const manifest = readManifest(out);
    const archivePath = join(out, manifest.archive);
    const bytes = readFileSync(archivePath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(archivePath, bytes);

    const result = check(packageRoot, out);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/digest|sha256|checksum/iu);
  });

  it("rejects a manifest whose entry list no longer matches the archive", () => {
    const out = join(temporaryDirectory("tamper-manifest"), "dist");
    expect(
      build(packageRoot, out, ["--source-commit", sourceCommit()]).code,
    ).toBe(0);
    const manifest = readManifest(out);
    manifest.entries.pop();
    writeFileSync(
      join(out, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const result = check(packageRoot, out);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/entr|manifest|listing/iu);
  });

  it("rehearses artifact rollback and keeps the seven-tool surface identical", () => {
    const previous = join(temporaryDirectory("rollback-previous"), "dist");
    expect(
      build(packageRoot, previous, ["--source-commit", sourceCommit()]).code,
    ).toBe(0);
    const previousManifest = readManifest(previous);

    const candidateRoot = copyPackage("rollback-candidate");
    for (const file of ["skill.json", "package.json"]) {
      const value = readJson<Record<string, unknown>>(
        join(candidateRoot, file),
      );
      writeFileSync(
        join(candidateRoot, file),
        JSON.stringify({ ...value, version: "0.3.1" }, null, 2),
      );
    }
    const candidate = join(
      temporaryDirectory("rollback-candidate-out"),
      "dist",
    );
    expect(
      build(candidateRoot, candidate, ["--source-commit", sourceCommit()]).code,
    ).toBe(0);
    const candidateManifest = readManifest(candidate);

    expect(candidateManifest.version).toBe("0.3.1");
    expect(candidateManifest.archive_sha256).not.toBe(
      previousManifest.archive_sha256,
    );
    expect(candidateManifest.mcp_tools).toEqual(previousManifest.mcp_tools);
    expect(previousManifest.mcp_tools).toHaveLength(7);

    // The retained previous artifact is still valid after the candidate exists:
    // rollback re-activates exactly this digest.
    expect(check(packageRoot, previous).code).toBe(0);
  });
});
