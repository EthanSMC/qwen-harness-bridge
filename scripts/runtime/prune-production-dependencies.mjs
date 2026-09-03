import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const [runtimeRootArgument] = process.argv.slice(2);

if (runtimeRootArgument === undefined) {
  throw new Error("usage: prune-production-dependencies.mjs <runtime-root>");
}

if (!isAbsolute(runtimeRootArgument)) {
  throw new Error("runtime root must be a non-root absolute path");
}

const runtimeRoot = resolve(runtimeRootArgument);
const canonicalRoot = await realpath(runtimeRoot);
if (canonicalRoot === sep) {
  throw new Error("runtime root must not resolve to the filesystem root");
}
const nodeModulesRoot = join(canonicalRoot, "node_modules");
const canonicalNodeModulesRoot = await realpath(nodeModulesRoot);
const nodeModulesRelativePath = relative(
  canonicalRoot,
  canonicalNodeModulesRoot,
);

if (
  nodeModulesRelativePath === "" ||
  nodeModulesRelativePath === ".." ||
  nodeModulesRelativePath.startsWith(`..${sep}`) ||
  isAbsolute(nodeModulesRelativePath)
) {
  throw new Error("node_modules must be contained by the runtime root");
}

const testDirectoryNames = new Set(["test", "tests", "__tests__"]);
const testFilePattern = /\.(?:test|spec)\.[^/]+(?:\.map)?$/i;

const prune = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const entryMetadata = await lstat(entryPath);

    if (entryMetadata.isSymbolicLink()) continue;
    if (entryMetadata.isDirectory()) {
      if (testDirectoryNames.has(entry.name.toLowerCase())) {
        await rm(entryPath, { force: true, recursive: true });
        continue;
      }
      await prune(entryPath);
      continue;
    }

    if (entryMetadata.isFile() && testFilePattern.test(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
};

await prune(canonicalNodeModulesRoot);
