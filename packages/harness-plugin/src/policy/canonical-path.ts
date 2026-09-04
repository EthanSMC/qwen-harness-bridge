import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { PolicyPathViolation } from "./types.js";

export type CanonicalPathOptions = Readonly<{
  basePath?: string;
}>;

export class CanonicalPathError extends Error {
  readonly code: PolicyPathViolation;

  constructor(code: PolicyPathViolation) {
    super(code);
    this.name = "CanonicalPathError";
    this.code = code;
  }
}

const isMissingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const hasTraversalSegment = (path: string): boolean =>
  path.split(/[\\/]/u).some((segment) => segment === "..");

const assertPathInput = (
  path: string,
  options: CanonicalPathOptions,
): string => {
  if (typeof path !== "string" || path.length === 0) {
    throw new CanonicalPathError("PATH_UNAVAILABLE");
  }
  if (hasTraversalSegment(path)) {
    throw new CanonicalPathError("PATH_TRAVERSAL");
  }

  if (isAbsolute(path)) return path;
  if (options.basePath === undefined || !isAbsolute(options.basePath)) {
    throw new CanonicalPathError("PATH_NOT_ABSOLUTE");
  }
  return resolve(options.basePath, path);
};

const canonicalRoot = (root: string): string => {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new CanonicalPathError("ROOT_NOT_CANONICAL");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync.native(root);
    if (!statSync(resolvedRoot).isDirectory()) {
      throw new Error("root is not a directory");
    }
  } catch {
    throw new CanonicalPathError("ROOT_NOT_CANONICAL");
  }

  if (resolvedRoot !== root) {
    throw new CanonicalPathError("ROOT_NOT_CANONICAL");
  }
  return resolvedRoot;
};

const isWithinRoot = (root: string, target: string): boolean => {
  const distance = relative(root, target);
  return (
    distance === "" ||
    (!isAbsolute(distance) &&
      distance !== ".." &&
      !distance.startsWith(`..${sep}`))
  );
};

const nearestExistingAncestor = (
  candidate: string,
): { ancestor: string; missingSegments: readonly string[] } => {
  let cursor = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      lstatSync(cursor);
      return { ancestor: cursor, missingSegments };
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new CanonicalPathError("PATH_UNAVAILABLE");
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new CanonicalPathError("PATH_UNAVAILABLE");
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
};

const outsideCode = (candidate: string, root: string): PolicyPathViolation =>
  isWithinRoot(root, candidate) ? "SYMLINK_ESCAPE" : "PATH_OUTSIDE_REPOSITORY";

/**
 * Return the filesystem's canonical spelling for an existing path, or the
 * canonical nearest-existing-ancestor plus lexical suffix for a new path.
 */
export function canonicalizePath(
  root: string,
  target: string,
  options: CanonicalPathOptions = {},
): string {
  const resolvedRoot = canonicalRoot(root);
  const candidate = assertPathInput(target, options);

  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync.native(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new CanonicalPathError("PATH_UNAVAILABLE");
    }

    const nearest = nearestExistingAncestor(candidate);
    let canonicalAncestor: string;
    try {
      canonicalAncestor = realpathSync.native(nearest.ancestor);
      if (
        nearest.missingSegments.length > 0 &&
        !statSync(canonicalAncestor).isDirectory()
      ) {
        throw new Error("ancestor is not a directory");
      }
    } catch {
      throw new CanonicalPathError("PATH_UNAVAILABLE");
    }
    canonicalTarget = join(canonicalAncestor, ...nearest.missingSegments);
  }

  if (!isWithinRoot(resolvedRoot, canonicalTarget)) {
    throw new CanonicalPathError(outsideCode(candidate, resolvedRoot));
  }
  return canonicalTarget;
}

/** The canonical root check used by policy configuration and tests. */
export function canonicalizeRepositoryRoot(root: string): string {
  return canonicalRoot(root);
}

/** Check containment without touching the filesystem. Both paths must be canonical. */
export function isPathWithinRoot(root: string, target: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(target)) return false;
  return isWithinRoot(root, target);
}

/**
 * Re-resolve a path at the execution boundary. A changed canonical path is a
 * denial even when the replacement remains inside the repository because it
 * would invalidate a previously approved action fingerprint.
 */
export function recheckCanonicalPath(
  root: string,
  target: string,
  expectedCanonicalPath: string,
  options: CanonicalPathOptions = {},
): string {
  const current = canonicalizePath(root, target, options);
  if (current !== expectedCanonicalPath) {
    throw new CanonicalPathError("PATH_CHANGED");
  }
  return current;
}

export { isWithinRoot };
