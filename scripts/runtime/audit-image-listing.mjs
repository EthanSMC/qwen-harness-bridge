import { readFile } from "node:fs/promises";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (name === undefined || value === undefined || !name.startsWith("--")) {
    throw new Error(
      "usage: audit-image-listing.mjs --workdir <absolute-path> --listing <file>",
    );
  }
  argumentsByName.set(name, value);
}

const workdir = argumentsByName.get("--workdir");
const listingPath = argumentsByName.get("--listing");
if (workdir === undefined || listingPath === undefined) {
  throw new Error(
    "usage: audit-image-listing.mjs --workdir <absolute-path> --listing <file>",
  );
}

const normalizedWorkdir = workdir.replace(/^\/+|\/+$/g, "");
if (normalizedWorkdir.length === 0 || workdir.startsWith("/") === false) {
  throw new Error("workdir must be a non-root absolute path");
}

const normalizeArchiveEntry = (entry) =>
  entry
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

const isTestArtifact = (path) =>
  /(^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(path) ||
  /\.(?:test|spec)\.[^/]+(?:\.map)?$/i.test(path);

const isGloballyForbidden = (path) =>
  /(^|\/)\.git(?:\/|$)/.test(path) || /(^|\/)\.env(?:\.[^/]*)?$/.test(path);

const isApplicationSecret = (path) => /\.(?:key|pem|crt|cert|p12)$/i.test(path);

const listing = await readFile(listingPath, "utf8");
for (const rawEntry of listing.split(/\r?\n/)) {
  if (rawEntry.length === 0) continue;
  const entry = normalizeArchiveEntry(rawEntry);
  if (entry.length === 0) continue;
  if (entry.split("/").includes("..")) {
    throw new Error("image listing contains a path traversal entry");
  }
  if (isGloballyForbidden(entry)) {
    throw new Error(`image listing contains forbidden global path: ${entry}`);
  }

  if (
    entry !== normalizedWorkdir &&
    !entry.startsWith(`${normalizedWorkdir}/`)
  ) {
    continue;
  }

  const applicationPath = entry
    .slice(normalizedWorkdir.length)
    .replace(/^\//, "");
  if (applicationPath.length === 0) continue;
  if (isApplicationSecret(applicationPath) || isTestArtifact(applicationPath)) {
    throw new Error(`runtime workdir contains forbidden artifact: ${entry}`);
  }
  if (
    applicationPath !== "package.json" &&
    applicationPath !== "dist" &&
    !applicationPath.startsWith("dist/") &&
    applicationPath !== "node_modules" &&
    !applicationPath.startsWith("node_modules/")
  ) {
    throw new Error(`runtime workdir contains unexpected path: ${entry}`);
  }
}
