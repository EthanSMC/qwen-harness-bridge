import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const visitedDirectories = new Set();

const assertInsideNodeModules = (candidate, description) => {
  const candidateRelativePath = relative(canonicalNodeModulesRoot, candidate);

  if (
    candidateRelativePath === ".." ||
    candidateRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelativePath)
  ) {
    throw new Error(
      `Refusing to prune ${description} outside the deployed node_modules: ${candidate}`,
    );
  }
};

const prune = async (directory) => {
  assertInsideNodeModules(directory, "directory");

  if (visitedDirectories.has(directory)) return;
  visitedDirectories.add(directory);

  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const entryPath = join(directory, entry.name);
    const entryMetadata = await lstat(entryPath);

    if (entryMetadata.isSymbolicLink()) {
      let canonicalTarget;
      try {
        canonicalTarget = await realpath(entryPath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          await rm(entryPath, { force: true });
          continue;
        }
        throw error;
      }
      assertInsideNodeModules(canonicalTarget, `symbolic link ${entryPath}`);

      if (
        testDirectoryNames.has(entry.name.toLowerCase()) ||
        testFilePattern.test(entry.name)
      ) {
        await rm(entryPath, { force: true });
        continue;
      }

      const targetMetadata = await stat(canonicalTarget);
      if (targetMetadata.isDirectory()) {
        if (testDirectoryNames.has(basename(canonicalTarget).toLowerCase())) {
          await rm(canonicalTarget, { force: true, recursive: true });
          await rm(entryPath, { force: true });
          continue;
        }
        await prune(canonicalTarget);
        continue;
      }

      if (targetMetadata.isFile()) {
        if (testFilePattern.test(basename(canonicalTarget))) {
          await rm(canonicalTarget, { force: true });
          await rm(entryPath, { force: true });
        }
        continue;
      }

      throw new Error(`Unsupported symbolic link target: ${entryPath}`);
    }

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
