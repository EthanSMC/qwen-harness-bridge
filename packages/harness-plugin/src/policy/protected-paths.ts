import { lstatSync, opendirSync, type Stats } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  CanonicalPathError,
  canonicalizePath,
  isPathWithinRoot,
} from "./canonical-path.js";

export type ProtectedPaths = Readonly<Record<string, readonly string[]>>;

export const resolveProtectedPaths = (
  root: string,
  paths: readonly string[],
): readonly string[] => [
  ...new Set(
    paths.flatMap((path) => [
      resolve(root, path),
      canonicalizePath(root, path, { basePath: root }),
    ]),
  ),
];

/** Inspect names/metadata only, with a hard bound; never open file contents. */
export function assertSearchResources(
  root: string,
  paths: readonly string[],
  configured: readonly string[],
): void {
  const pending = [...paths];
  let remaining = 10000;
  while (pending.length > 0) {
    if (--remaining < 0) throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
    const target = pending.pop() as string;
    if (isProtectedPath(root, target, configured))
      throw new CanonicalPathError("PROTECTED_RESOURCE");
    let stat: Stats;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CanonicalPathError("PATH_UNAVAILABLE");
    }
    if (stat.isSymbolicLink()) continue; // admitted traversal modes never follow descendants
    if (isProtectedPath(root, canonicalizePath(root, target), configured))
      throw new CanonicalPathError("PROTECTED_RESOURCE");
    if (stat.isDirectory()) {
      // opendir-style streaming avoids allocating an unbounded entry list.
      const directory = opendirSync(target);
      try {
        for (
          let entry = directory.readSync();
          entry !== null;
          entry = directory.readSync()
        ) {
          if (pending.length >= remaining)
            throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
          pending.push(join(target, entry.name));
        }
      } finally {
        directory.closeSync();
      }
    }
  }
}

/** Resource names are exact path components, never source/pattern substrings. */
export function isProtectedPath(
  root: string,
  target: string,
  configured: readonly string[] = [],
): boolean {
  const canonical = resolve(root, target);
  const segments = relative(root, canonical).split(/[\\/]/u);
  const conventional = segments.some(
    (name) =>
      [
        ".env",
        ".npmrc",
        ".pypirc",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "login.keychain-db",
        "System.keychain",
      ].includes(name) ||
      (/^\.env\./u.test(name) &&
        !/^\.env\.(?:example|sample|template)$/u.test(name)),
  );
  const keychainDirectory = segments.some(
    (name, index) => name === "Library" && segments[index + 1] === "Keychains",
  );
  const awsCredentials = segments.some(
    (name, index) => name === ".aws" && segments[index + 1] === "credentials",
  );
  return (
    conventional ||
    keychainDirectory ||
    awsCredentials ||
    configured.some((path) => isPathWithinRoot(resolve(root, path), canonical))
  );
}
