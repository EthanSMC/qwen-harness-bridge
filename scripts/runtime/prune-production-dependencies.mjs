import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
const pnpmWorkspaceNodeModulesRoot = join(
  canonicalNodeModulesRoot,
  ".pnpm",
  "node_modules",
);

const isContainedBy = (root, candidate) => {
  const candidateRelativePath = relative(root, candidate);
  return (
    candidateRelativePath === "" ||
    (candidateRelativePath !== ".." &&
      !candidateRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelativePath))
  );
};

const isPnpmWorkspaceLinkCandidate = (candidate) =>
  candidate !== pnpmWorkspaceNodeModulesRoot &&
  isContainedBy(pnpmWorkspaceNodeModulesRoot, candidate);

let pnpmWorkspaceSelfLink;
const loadPnpmWorkspaceSelfLink = async () => {
  if (pnpmWorkspaceSelfLink !== undefined) return pnpmWorkspaceSelfLink;

  const packageJson = JSON.parse(
    await readFile(join(canonicalRoot, "package.json"), "utf8"),
  );
  const packageName = packageJson?.name;
  const packageNameSegments =
    typeof packageName === "string" ? packageName.split("/") : [];
  const hasValidShape = packageName?.startsWith("@")
    ? packageNameSegments.length === 2 &&
      packageNameSegments[0]?.length > 1 &&
      packageNameSegments[1]?.length > 0
    : packageNameSegments.length === 1 && packageNameSegments[0]?.length > 0;
  const hasSafeSegments = packageNameSegments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\\") &&
      !segment.includes("\0"),
  );

  if (!hasValidShape || !hasSafeSegments) {
    throw new Error("runtime package.json must contain a valid package name");
  }

  pnpmWorkspaceSelfLink = join(
    pnpmWorkspaceNodeModulesRoot,
    ...packageNameSegments,
  );
  return pnpmWorkspaceSelfLink;
};

const assertInsideNodeModules = (candidate, description) => {
  if (!isContainedBy(canonicalNodeModulesRoot, candidate)) {
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
      if (
        !isContainedBy(canonicalNodeModulesRoot, canonicalTarget) &&
        isPnpmWorkspaceLinkCandidate(entryPath) &&
        entryPath === (await loadPnpmWorkspaceSelfLink())
      ) {
        await rm(entryPath, { force: true });
        continue;
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
