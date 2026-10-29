#!/usr/bin/env node
/**
 * Builds the private Qwen Skill package.
 *
 * The artifact is reproducible: entries are sorted, every ZIP timestamp is the
 * fixed 1980-01-01 value, permissions are fixed and no build-time clock value is
 * recorded. The manifest records the artifact version, the Changesets-managed
 * package version source, the monorepo version for traceability, the source
 * commit and the archive SHA-256, so a later check can prove the same source
 * produced the same digest.
 *
 * The build fails closed when:
 * - skill.json and packages/qwen-skill/package.json disagree on the version;
 * - a referenced file is missing, absolute, escapes the package or is a symlink;
 * - the MCP import carries a literal credential or is not the seven-tool shape;
 * - excluded material (fixtures, tests, maps, reports, .env, keychain files) is
 *   referenced by the package itself; or
 * - no source commit can be resolved.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SEVEN_CODES = [
  "cancel_task",
  "decide_approval",
  "get_task",
  "get_task_result",
  "list_pending_approvals",
  "list_tasks",
  "submit_task",
];

const SECRET_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const EXCLUDED = [
  /^fixtures\//u,
  /^node_modules\//u,
  /^dist\//u,
  /\.test\.ts$/u,
  /\.map$/u,
  /(?:^|\/)\.env/u,
  /\.log$/u,
  /keychain/iu,
  /\.(?:p12|key|pem|mobileprovision)$/u,
  /(?:^|\/)local-report[^/]*\.md$/u,
];
const CREDENTIAL_LITERALS = [
  /\bsk-[A-Za-z0-9_-]{8,}/u,
  /Bearer\s+[A-Za-z0-9._-]{8,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /"(?:token|secret|password|api_key)"\s*:\s*"(?!\$\{)[^"]{8,}"/u,
];

const fail = (code, message) => {
  throw new Error(`${code}: ${message}`);
};

const parseArguments = (argv) => {
  const options = {
    root: scriptRoot,
    out: null,
    sourceCommit: null,
    help: false,
  };
  let cursor = 0;
  const value = () => {
    cursor += 1;
    return argv[cursor];
  };
  while (cursor < argv.length) {
    const argument = argv[cursor];
    if (argument === "--root") options.root = resolve(value());
    else if (argument === "--out") options.out = resolve(value());
    else if (argument === "--source-commit") options.sourceCommit = value();
    else if (argument === "--help") options.help = true;
    else fail("INVALID_ARGUMENT", `unknown argument ${argument}`);
    cursor += 1;
  }
  return options;
};

const readJson = (path, code) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code, `${path} is not valid JSON`);
  }
};

const isExcluded = (path) => EXCLUDED.some((pattern) => pattern.test(path));

const assertInsideRoot = (root, path) => {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes(".."))
    fail(
      "UNSAFE_ENTRY_PATH",
      `${path} must be a relative path without traversal`,
    );
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside))
    fail("UNSAFE_ENTRY_PATH", `${path} escapes the package root`);
  if (!existsSync(absolute)) fail("MISSING_ENTRY", `${path} does not exist`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink())
    fail("SYMLINK_ENTRY", `${path} must not be a symbolic link`);
  if (!info.isFile()) fail("MISSING_ENTRY", `${path} is not a regular file`);
  const realRoot = realpathSync(root);
  const realFile = realpathSync(absolute);
  if (relative(realRoot, realFile).startsWith(".."))
    fail("SYMLINK_ENTRY", `${path} resolves outside the package root`);
  return absolute;
};

const resolveSourceCommit = (root) => {
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{7,64}$/u.test(commit)) return commit;
  } catch {
    // Fall through to the documented CI environment variables: the runtime
    // container builds a copied tree without repository objects.
  }
  for (const key of ["GITHUB_SHA", "QHB_SOURCE_COMMIT", "SOURCE_COMMIT"]) {
    const value = process.env[key];
    if (typeof value === "string" && /^[0-9a-f]{7,64}$/u.test(value.trim()))
      return value.trim();
  }
  fail(
    "SOURCE_COMMIT_UNAVAILABLE",
    "no git checkout; set GITHUB_SHA, QHB_SOURCE_COMMIT or --source-commit",
  );
};

const monorepoVersion = (root) => {
  const monorepo = resolve(root, "..", "..", "package.json");
  if (!existsSync(monorepo)) return "unknown";
  const document = readJson(monorepo, "MONOREPO_VERSION_INVALID");
  return typeof document.version === "string" ? document.version : "unknown";
};

const collectEntries = (root) => {
  const skill = readJson(join(root, "skill.json"), "SKILL_JSON_INVALID");
  const pkg = readJson(join(root, "package.json"), "PACKAGE_JSON_INVALID");
  if (pkg.name !== "@qhb/qwen-skill")
    fail("PACKAGE_NAME_MISMATCH", "package must stay @qhb/qwen-skill");
  if (pkg.private !== true)
    fail("PACKAGE_VISIBILITY_INVALID", "package must stay private");
  if (!SEMVER.test(String(skill.version ?? "")))
    fail("VERSION_INVALID", "skill.json version must be a SemVer string");
  if (!SEMVER.test(String(pkg.version ?? "")))
    fail("VERSION_INVALID", "package.json version must be a SemVer string");
  if (skill.version !== pkg.version) {
    fail(
      "VERSION_MISMATCH",
      `skill.json ${skill.version} != package.json ${pkg.version}`,
    );
  }

  const skillText = readFileSync(join(root, "SKILL.md"), "utf8");
  const referenced = new Set([
    "SKILL.md",
    "skill.json",
    "mcp.import.example.json",
    "config/repositories.json",
  ]);
  for (const match of skillText.matchAll(/references\/[a-z0-9-]+\.md/gu))
    referenced.add(match[0]);
  for (const key of ["mcp_import", "transcript_schema"]) {
    const reference = skill[key];
    if (typeof reference !== "string" || reference.length === 0)
      fail("SKILL_REFERENCE_INVALID", `skill.json ${key} is required`);
    referenced.add(reference);
  }

  const paths = [...referenced].sort();
  for (const path of paths) {
    assertInsideRoot(root, path);
    if (isExcluded(path))
      fail("EXCLUDED_ENTRY_REFERENCED", `${path} must not ship`);
  }
  return { skill, pkg, paths };
};

const validateMcpImport = (root) => {
  const path = join(root, "mcp.import.example.json");
  const document = readJson(path, "MCP_IMPORT_INVALID");
  const servers = Array.isArray(document.servers) ? document.servers : [];
  if (servers.length !== 1)
    fail("MCP_IMPORT_INVALID", "mcp import must declare one server");
  const server = servers[0];
  if (!String(server.url ?? "").startsWith("https://"))
    fail("MCP_IMPORT_INSECURE", "mcp server url must use https");
  if (
    server.auth?.type !== "bearer" ||
    !SECRET_REFERENCE.test(String(server.auth?.token_secret_ref ?? ""))
  )
    fail(
      "MCP_IMPORT_SECRET",
      "mcp server must reference a secret, never a literal",
    );
  const tools = Array.isArray(server.tools) ? server.tools : [];
  const unique = [...new Set(tools)].sort();
  if (
    unique.length !== SEVEN_CODES.length ||
    unique.join(",") !== SEVEN_CODES.join(",")
  )
    fail(
      "MCP_TOOL_SURFACE_INVALID",
      "mcp import must list exactly the seven approved tools",
    );
  return unique;
};

const assertSecretFree = (root, paths) => {
  for (const path of paths) {
    const text = readFileSync(join(root, path), "utf8");
    for (const pattern of CREDENTIAL_LITERALS) {
      if (pattern.test(text))
        fail("CREDENTIAL_LITERAL", `${path} contains a credential literal`);
    }
  }
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};

const FIXED_TIME = 0;
const FIXED_DATE = 0x21; // 1980-01-01
const FIXED_MODE = 0o100644;

const buildZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(FIXED_TIME, 10);
    local.writeUInt16LE(FIXED_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0014, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(FIXED_TIME, 12);
    central.writeUInt16LE(FIXED_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((FIXED_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const cleanOutput = (root, out) => {
  const absoluteRoot = resolve(root);
  const absoluteOut = resolve(out);
  if (
    absoluteOut === absoluteRoot ||
    absoluteRoot.startsWith(`${absoluteOut}${sep}`) ||
    absoluteOut === resolve(absoluteOut, sep)
  )
    fail("UNSAFE_OUTPUT", "output directory must not contain the package root");
  rmSync(absoluteOut, { recursive: true, force: true });
  mkdirSync(absoluteOut, { recursive: true });
};

export const buildPackage = ({
  root = scriptRoot,
  out = null,
  sourceCommit = null,
} = {}) => {
  const optionsRoot = resolve(root);
  const output = out === null ? join(optionsRoot, "dist") : resolve(out);
  const commit = sourceCommit ?? resolveSourceCommit(optionsRoot);
  if (!/^[0-9a-f]{7,64}$/u.test(commit))
    fail("SOURCE_COMMIT_INVALID", "source commit must be a lowercase SHA");
  if (!existsSync(join(optionsRoot, "SKILL.md")))
    fail("PACKAGE_ROOT_INVALID", "root must contain SKILL.md");

  const { skill, paths } = collectEntries(optionsRoot);
  const tools = validateMcpImport(optionsRoot);
  assertSecretFree(optionsRoot, paths);

  const files = paths.map((path) => ({
    path,
    data: readFileSync(join(optionsRoot, path)),
  }));
  const archiveBytes = buildZip(files);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const archiveName = `qwen-skill-${skill.version}.zip`;

  const manifest = {
    schema_version: 1,
    name: skill.name,
    version: skill.version,
    version_source: "package.json",
    monorepo_version: monorepoVersion(optionsRoot),
    source_commit: commit,
    archive: archiveName,
    archive_sha256: archiveSha256,
    entry_count: files.length,
    mcp_tools: tools,
    entries: files.map((file) => ({
      path: file.path,
      bytes: file.data.length,
      sha256: createHash("sha256").update(file.data).digest("hex"),
    })),
  };

  cleanOutput(optionsRoot, output);
  writeFileSync(join(output, archiveName), archiveBytes);
  writeFileSync(
    join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "SHA256SUMS"),
    `${archiveSha256}  ${archiveName}\n`,
  );

  return { manifest, output, archivePath: join(output, archiveName) };
};

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: build-package.mjs [--root DIR] [--out DIR] [--source-commit SHA]\n",
    );
    return;
  }
  const result = buildPackage(options);
  process.stdout.write(
    `SKILL_PACKAGE_BUILD version=${result.manifest.version} sha256=${result.manifest.archive_sha256} entries=${result.manifest.entry_count} source=${result.manifest.source_commit} out=${relative(process.cwd(), result.output)}\n`,
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`SKILL_PACKAGE_BUILD_FAILED ${error.message}\n`);
    process.exitCode = 1;
  }
}
