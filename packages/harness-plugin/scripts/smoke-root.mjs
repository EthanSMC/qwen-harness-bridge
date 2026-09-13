import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** True when the directory or any ancestor already has `node_modules`. */
export const hasNodeModulesAncestor = (directory) => {
  let current = resolve(directory);
  for (;;) {
    if (existsSync(join(current, "node_modules"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

/** True when the directory or any ancestor belongs to a Git repository. */
export const hasRepositoryAncestor = (directory) => {
  let current = resolve(directory);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

export const isInsideRepository = (directory, repositoryRoot) => {
  const base = resolve(repositoryRoot);
  const target = resolve(directory);
  return target === base || target.startsWith(`${base}${sep}`);
};

/**
 * Create a temporary root outside the repository whose ancestry has no
 * monorepo `node_modules`, so Node resolution inside it can only use the
 * artifact and the host-provided peers.
 */
export const createCleanRoot = ({ repositoryRoot, label }) => {
  const candidates = [];
  try {
    candidates.push(realpathSync.native(tmpdir()));
  } catch {
    // Fall through to the sibling candidate.
  }
  // Then walk up from the repository parent until an ancestor chain without a
  // monorepo `node_modules` is found (a git worktree may sit inside one).
  let ancestor = dirname(resolve(repositoryRoot));
  for (;;) {
    candidates.push(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    if (isInsideRepository(base, repositoryRoot)) continue;
    if (hasNodeModulesAncestor(base)) continue;
    if (hasRepositoryAncestor(base)) continue;
    const root = mkdtempSync(join(base, `${label}-`));
    if (isInsideRepository(root, repositoryRoot)) {
      throw new Error("PACKAGING_SMOKE_ROOT_INSIDE_REPOSITORY");
    }
    if (hasRepositoryAncestor(root)) {
      throw new Error("PACKAGING_SMOKE_ROOT_INSIDE_REPOSITORY");
    }
    if (hasNodeModulesAncestor(root)) {
      throw new Error("PACKAGING_SMOKE_ROOT_NOT_CLEAN");
    }
    return root;
  }
  throw new Error("PACKAGING_SMOKE_ROOT_UNAVAILABLE");
};

/** Link host-provided peers into an extracted extension root. */
export const linkHostPeers = ({ extensionRoot, packageRoot, peers }) => {
  const linked = [];
  for (const name of peers) {
    const source = join(packageRoot, "node_modules", name);
    if (!existsSync(source)) {
      throw new Error(`HOST_PEER_UNAVAILABLE: ${name}`);
    }
    const target = realpathSync.native(source);
    const link = join(extensionRoot, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    linked.push(name);
  }
  return linked;
};
