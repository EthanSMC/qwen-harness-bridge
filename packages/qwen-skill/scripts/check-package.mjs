#!/usr/bin/env node
/**
 * Independently checks a built private Qwen Skill package.
 *
 * The checker does not trust build output: it reads the ZIP central directory,
 * extracts every stored entry, recomputes CRC-32 and SHA-256, derives the
 * expected content list from the package sources again, validates the manifest,
 * re-runs the build to prove digest reproducibility, and confirms that the seven
 * MCP tools match the protocol schema sources. Any missing file, unexpected
 * entry, version disagreement, credential literal or unsafe path exits non-zero.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = join(scriptRoot, "scripts", "build-package.mjs");

const SEMVER = /^\d+\.\d+\.\d+$/u;
const SECRET_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/u;
const CREDENTIAL_LITERALS = [
  /\bsk-[A-Za-z0-9_-]{8,}/u,
  /Bearer\s+[A-Za-z0-9._-]{8,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];
const FORBIDDEN = [
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
const FIXED_TIME = 0;
const FIXED_DATE = 0x21;
const FIXED_MODE = 0o100644;

const parseArguments = (argv) => {
  const options = {
    root: scriptRoot,
    packageDir: null,
    skipRepro: false,
    skipProtocol: false,
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
    else if (argument === "--package") options.packageDir = resolve(value());
    else if (argument === "--skip-repro") options.skipRepro = true;
    else if (argument === "--skip-protocol") options.skipProtocol = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`INVALID_ARGUMENT: unknown argument ${argument}`);
    cursor += 1;
  }
  return options;
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

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const findEndOfCentralDirectory = (buffer) => {
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP_STRUCTURE_INVALID: end of central directory missing");
};

const readZip = (buffer) => {
  const endOffset = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset)
    throw new Error("ZIP_STRUCTURE_INVALID: central directory bounds mismatch");
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("ZIP_STRUCTURE_INVALID: central directory entry missing");
    const method = buffer.readUInt16LE(offset + 10);
    const dosTime = buffer.readUInt16LE(offset + 12);
    const dosDate = buffer.readUInt16LE(offset + 14);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error(
        `ZIP_STRUCTURE_INVALID: local header missing for ${name}`,
      );
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString("utf8");
    if (localName !== name)
      throw new Error(`ZIP_STRUCTURE_INVALID: local name mismatch for ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      path: name,
      method,
      dosTime,
      dosDate,
      checksum,
      externalAttributes,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
      compressedSize,
      uncompressedSize,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const expectedEntries = (root) => {
  const skillText = readFileSync(join(root, "SKILL.md"), "utf8");
  const skill = readJson(join(root, "skill.json"));
  const paths = new Set([
    "SKILL.md",
    "skill.json",
    "mcp.import.example.json",
    "config/repositories.json",
  ]);
  for (const match of skillText.matchAll(/references\/[a-z0-9-]+\.md/gu))
    paths.add(match[0]);
  for (const key of ["mcp_import", "transcript_schema"]) {
    if (typeof skill[key] !== "string")
      throw new Error(`SKILL_REFERENCE_INVALID: ${key} is required`);
    paths.add(skill[key]);
  }
  return [...paths].sort();
};

const checkManifest = (manifest) => {
  const failures = [];
  if (manifest?.schema_version !== 1)
    failures.push("manifest schema_version must be 1");
  if (typeof manifest?.name !== "string" || manifest.name.length === 0)
    failures.push("manifest name is required");
  if (!SEMVER.test(String(manifest?.version ?? "")))
    failures.push("manifest version must be a SemVer string");
  if (!/^[0-9a-f]{7,64}$/u.test(String(manifest?.source_commit ?? "")))
    failures.push("manifest source_commit must be a lowercase SHA");
  if (typeof manifest?.archive !== "string" || manifest.archive.length === 0)
    failures.push("manifest archive name is required");
  if (!/^[0-9a-f]{64}$/u.test(String(manifest?.archive_sha256 ?? "")))
    failures.push("manifest archive_sha256 must be SHA-256");
  if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0)
    failures.push("manifest entry listing is required");
  else if (manifest.entry_count !== manifest.entries.length)
    failures.push("manifest entry_count does not match the entry listing");
  if (!Array.isArray(manifest?.mcp_tools) || manifest.mcp_tools.length !== 7)
    failures.push("manifest mcp_tools must list the seven tools");
  return failures;
};

const checkArchive = ({ manifest, archiveBuffer, entries, root }) => {
  const failures = [];
  if (sha256(archiveBuffer) !== manifest.archive_sha256)
    failures.push("archive digest mismatch against the manifest");
  const names = entries.map((entry) => entry.path);
  if (names.length !== manifest.entry_count)
    failures.push("archive entry count mismatch");
  if (names.join("\n") !== [...names].sort().join("\n"))
    failures.push("archive entries are not sorted");
  if (new Set(names).size !== names.length)
    failures.push("archive has duplicate entries");
  for (const entry of entries) {
    if (entry.path.endsWith("/"))
      failures.push(`${entry.path} is a directory entry`);
    if (
      isAbsolute(entry.path) ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..")
    )
      failures.push(`${entry.path} has an unsafe archive path`);
    if (entry.method !== 0)
      failures.push(`${entry.path} must be stored without compression`);
    if (entry.dosTime !== FIXED_TIME || entry.dosDate !== FIXED_DATE)
      failures.push(`${entry.path} has a non-normalized timestamp`);
    if ((entry.externalAttributes >>> 16) & (0o777 !== FIXED_MODE))
      failures.push(`${entry.path} has non-normalized permissions`);
    if (entry.compressedSize !== entry.uncompressedSize)
      failures.push(`${entry.path} has inconsistent stored sizes`);
    if (crc32(entry.data) !== entry.checksum)
      failures.push(`${entry.path} CRC-32 mismatch`);
  }

  const manifestEntries = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  if (manifestEntries.size !== manifest.entries.length)
    failures.push("manifest entry listing repeats a path");
  for (const entry of entries) {
    const recorded = manifestEntries.get(entry.path);
    if (recorded === undefined) {
      failures.push(`archive entry ${entry.path} is missing from the manifest`);
      continue;
    }
    if (recorded.bytes !== entry.data.length)
      failures.push(`${entry.path} byte count mismatch`);
    if (recorded.sha256 !== sha256(entry.data))
      failures.push(`${entry.path} SHA-256 mismatch`);
  }
  for (const path of manifestEntries.keys()) {
    if (!names.includes(path))
      failures.push(`manifest entry ${path} is missing from the archive`);
  }

  const expected = expectedEntries(root);
  for (const path of expected)
    if (!names.includes(path))
      failures.push(`required file ${path} is missing`);
  for (const path of names) {
    if (FORBIDDEN.some((pattern) => pattern.test(path)))
      failures.push(`forbidden entry ${path} is present`);
    if (!expected.includes(path))
      failures.push(`unexpected entry ${path} is present`);
  }
  return failures;
};

const checkContent = ({ entries, manifest, root }) => {
  const failures = [];
  const files = new Map(entries.map((entry) => [entry.path, entry.data]));
  const textFile = (path) => files.get(path)?.toString("utf8") ?? "";
  const skill = JSON.parse(textFile("skill.json") || "{}");
  const pkg = readJson(join(root, "package.json"));
  if (skill.version !== manifest.version)
    failures.push("archive skill.json version differs from the manifest");
  if (pkg.version !== manifest.version)
    failures.push("package.json version differs from the manifest");
  if (skill.version !== pkg.version)
    failures.push("archive skill.json and package.json versions differ");

  const imported = JSON.parse(textFile("mcp.import.example.json") || "{}");
  const servers = Array.isArray(imported.servers) ? imported.servers : [];
  if (servers.length !== 1)
    failures.push("archive MCP import must declare one server");
  else {
    const server = servers[0];
    if (!String(server.url ?? "").startsWith("https://"))
      failures.push("archive MCP import must use https");
    if (
      server.auth?.type !== "bearer" ||
      !SECRET_REFERENCE.test(String(server.auth?.token_secret_ref ?? ""))
    )
      failures.push(
        "archive MCP import must reference a secret, never a literal",
      );
    const tools = [
      ...new Set(Array.isArray(server.tools) ? server.tools : []),
    ].sort();
    if (tools.join(",") !== [...manifest.mcp_tools].sort().join(","))
      failures.push("archive MCP tools differ from the manifest");
  }

  for (const [path, data] of files) {
    if (!/\.(?:md|json|ts|mjs)$/u.test(path)) continue;
    const text = data.toString("utf8");
    for (const pattern of CREDENTIAL_LITERALS) {
      if (pattern.test(text))
        failures.push(`${path} contains a credential literal`);
    }
  }
  return failures;
};

const checkProtocolSurface = ({ manifest, root }) => {
  const failures = [];
  const repoRoot = resolve(root, "..", "..");
  const schemaPath = join(root, "src", "transcript-schema.ts");
  if (!existsSync(schemaPath))
    return ["PROTOCOL_SOURCE_MISSING: transcript schema map is required"];
  const source = readFileSync(schemaPath, "utf8");
  const sources = [
    ...source.matchAll(
      /(\w+):\s*\{\s*file:\s*"([^"]+)",\s*schema:\s*"([^"]+)"/gu,
    ),
  ];
  if (sources.length !== 7)
    failures.push("seven protocol schema sources are required");
  if (sources.length !== manifest.mcp_tools.length)
    failures.push("protocol tool count differs from the manifest");
  const tools = sources.map((match) => match[1]).sort();
  if (tools.join(",") !== [...manifest.mcp_tools].sort().join(","))
    failures.push("protocol tool names differ from the MCP import surface");
  for (const [, tool, file, schema] of sources) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) {
      failures.push(`protocol source ${file} for ${tool} is missing`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(`export const ${schema}`))
      failures.push(`protocol schema ${schema} for ${tool} is missing`);
  }
  return failures;
};

const runReproducibility = ({ manifest, root }) => {
  const temporary = mkdtempSync(join(tmpdir(), "qhb-check-repro-"));
  try {
    execFileSync(
      process.execPath,
      [
        buildScript,
        "--root",
        root,
        "--out",
        temporary,
        "--source-commit",
        manifest.source_commit,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const rebuilt = readJson(join(temporary, "manifest.json"));
    return rebuilt.archive_sha256 === manifest.archive_sha256
      ? []
      : ["rebuilt archive digest differs from the recorded digest"];
  } catch (error) {
    return [`rebuild failed: ${error.message}`];
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

export const checkPackage = ({
  root = scriptRoot,
  packageDir = null,
  skipRepro = false,
  skipProtocol = false,
} = {}) => {
  const optionsRoot = resolve(root);
  const directory =
    packageDir === null ? join(optionsRoot, "dist") : resolve(packageDir);
  const manifestPath = join(directory, "manifest.json");
  const failures = [];
  if (!existsSync(manifestPath)) {
    return {
      failures: ["MANIFEST_MISSING: run the package build first"],
      version: null,
    };
  }
  const manifest = readJson(manifestPath);
  failures.push(...checkManifest(manifest));
  if (failures.length > 0)
    return { failures, version: manifest.version ?? null };

  const archivePath = join(directory, manifest.archive);
  if (!existsSync(archivePath))
    return {
      failures: [`ARCHIVE_MISSING: ${manifest.archive}`],
      version: manifest.version,
    };
  const archiveBuffer = readFileSync(archivePath);
  const sums = join(directory, "SHA256SUMS");
  if (!existsSync(sums)) failures.push("SHA256SUMS is missing");
  else if (!readFileSync(sums, "utf8").includes(manifest.archive_sha256))
    failures.push("SHA256SUMS does not match the manifest digest");

  let entries;
  try {
    entries = readZip(archiveBuffer);
  } catch (error) {
    return { failures: [error.message], version: manifest.version };
  }
  failures.push(
    ...checkArchive({ manifest, archiveBuffer, entries, root: optionsRoot }),
  );
  failures.push(...checkContent({ entries, manifest, root: optionsRoot }));
  if (!skipProtocol)
    failures.push(...checkProtocolSurface({ manifest, root: optionsRoot }));
  if (!skipRepro)
    failures.push(...runReproducibility({ manifest, root: optionsRoot }));

  return {
    failures,
    version: manifest.version,
    digest: manifest.archive_sha256,
    entries: entries.length,
  };
};

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: check-package.mjs [--root DIR] [--package DIR] [--skip-repro] [--skip-protocol]\n",
    );
    return;
  }
  const result = checkPackage(options);
  if (result.failures.length > 0) {
    for (const failure of result.failures)
      process.stderr.write(` - ${failure}\n`);
    process.stderr.write(
      `SKILL_PACKAGE_CHECK FAILED ${result.failures.length} check(s)\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `SKILL_PACKAGE_CHECK PASS version=${result.version} sha256=${result.digest} entries=${result.entries} protocol_tools=7\n`,
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`SKILL_PACKAGE_CHECK FAILED ${error.message}\n`);
    process.exitCode = 1;
  }
}
