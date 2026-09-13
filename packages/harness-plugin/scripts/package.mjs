import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTar } from "./tar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

/** Packages the Harness host must provide; they are peers, never vendored. */
export const HOST_PEER_PREFIX = "@deepseek-ai/";
/**
 * Runtime packages whose compiled binary is bound to the running host ABI. The
 * artifact must not vendor them (a binary built here cannot load under the
 * operator's runtime), so the profile's package manager installs and builds
 * them for the host that actually runs the connector.
 */
export const HOST_INSTALLED_NATIVE = Object.freeze(["better-sqlite3"]);
/** Where vendored runtime packages live inside the artifact. */
export const VENDOR_PREFIX = "package/node_modules/";
/** Vendored build-time sources that a runtime never loads. */
const VENDOR_SKIP = /\.(?:c|cc|cpp|h|hpp|gyp|gypi)$/iu;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".github"]);
/** Vendored test material is never loaded at runtime and may hold fixtures. */
const VENDOR_EXCLUDE_PATH =
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/iu;
/** License text that npm publishes regardless of a package's `files` field. */
const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:\.[^/]*)?$/iu;
const TEXT_ENTRY =
  /\.(?:cjs|mjs|mts|js|json|map|ts|yml|yaml|sql|md|txt|toml|ini)$/iu;

/**
 * Matches a credential-looking assignment: a camelCase or snake_case key that
 * names a credential, assigned a quoted literal of at least eight characters or
 * an unquoted token of at least sixteen characters containing a digit. Type
 * annotations, empty defaults, and expressions such as
 * `token = Symbol("event-task")` or `sessionTokenClient: SessionTokenClient`
 * are not credentials.
 */
export const CREDENTIAL_ASSIGNMENT =
  /(?:^|[\s"'`{,;([])[A-Za-z0-9_$."'-]*(?:apikey|api[_-]?key|token|secret|password)[A-Za-z0-9_$."'-]*\s*[:=]\s*(?:(?:"[^"\n]{8,}")|(?:'[^'\n]{8,}')|(?=[A-Za-z0-9+/=_.-]*[0-9])[A-Za-z0-9+/=_.-]{16,})/imu;

/** Return the first credential-looking assignment in `text`, or null. */
export const findCredentialAssignment = (text) => {
  const pattern = new RegExp(CREDENTIAL_ASSIGNMENT.source, "gimu");
  const match = pattern.exec(text);
  return match === null ? null : match[0];
};

/** Compile the npm `files` subset used by this repository's dependencies. */
const globToRegExp = (pattern) => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index);
      if (end === -1) {
        source += "\\[";
      } else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else {
      source += character.replace(/[.+^${}()|\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^(?:${source})(?:/.*)?$`, "u");
};

/** A published package always keeps its manifest, native build output, and the
 * paths its own `files` field declares. */
const isIncluded = (relativePath, includes) =>
  relativePath === "package.json" ||
  relativePath.endsWith(".node") ||
  relativePath === "build" ||
  relativePath.startsWith("build/") ||
  LICENSE_FILE.test(basename(relativePath)) ||
  includes.some((pattern) => pattern.test(relativePath));

const collectFiles = (directory, prefix, options = {}) => {
  const { includes, root, skip } = options;
  const files = [];
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const full = join(directory, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectFiles(full, `${prefix}/${name}`, options));
    } else if (stats.isFile()) {
      if (skip?.test(name)) continue;
      if (root !== undefined) {
        const relativePath = relative(root, full).split(sep).join("/");
        if (VENDOR_EXCLUDE_PATH.test(relativePath)) continue;
        if (includes !== undefined && !isIncluded(relativePath, includes)) {
          continue;
        }
      }
      files.push({ name: `${prefix}/${name}`, data: readFileSync(full) });
    }
  }
  return files;
};

/** Resolve a package directory from a requiring directory. */
const resolvePackage = (specifier, fromDirectory) => {
  const require = createRequire(join(fromDirectory, "package.json"));
  let resolved;
  for (const candidate of [`${specifier}/package.json`, specifier]) {
    try {
      resolved = require.resolve(candidate);
      break;
    } catch {
      // Try the next candidate specifier.
    }
  }
  if (resolved === undefined) {
    throw new Error(`PACKAGE_RESOLUTION_FAILED: ${specifier}`);
  }
  let directory = dirname(resolved);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === specifier) return { directory, manifest };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`PACKAGE_RESOLUTION_FAILED: ${specifier}`);
};

/**
 * Resolve the runtime dependency closure of `manifest`, skipping host peers.
 * Throws when the closure needs two versions of the same package because the
 * artifact installs a flat `node_modules` tree.
 */
export const runtimeClosure = (
  manifest,
  fromDirectory,
  hostInstalled = HOST_INSTALLED_NATIVE,
) => {
  const resolved = new Map();
  const queue = [];
  const hostProvided = new Set(hostInstalled);
  const enqueue = (dependencies, from) => {
    for (const name of Object.keys(dependencies ?? {})) {
      if (name.startsWith(HOST_PEER_PREFIX) || hostProvided.has(name)) continue;
      queue.push({ name, from });
    }
  };
  enqueue(manifest.dependencies, fromDirectory);
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const found = resolvePackage(name, from);
    const previous = resolved.get(name);
    if (previous !== undefined) {
      if (previous.version !== found.manifest.version) {
        throw new Error(
          `PACKAGE_VERSION_CONFLICT: ${name} ${previous.version} vs ${found.manifest.version}`,
        );
      }
      continue;
    }
    resolved.set(name, {
      directory: found.directory,
      version: found.manifest.version,
      manifest: found.manifest,
    });
    enqueue(found.manifest.dependencies, found.directory);
  }
  return resolved;
};

/** Throw when the archive would carry a supplied or credential-looking value. */
export const assertCredentialFree = (entries, credentials = []) => {
  for (const entry of entries) {
    for (const secret of credentials) {
      if (
        typeof secret === "string" &&
        secret.length > 0 &&
        entry.data.includes(secret)
      ) {
        throw new Error(
          `artifact would contain a credential value in ${entry.name}`,
        );
      }
    }
  }
  for (const entry of entries) {
    if (!TEXT_ENTRY.test(entry.name)) continue;
    const found = findCredentialAssignment(entry.data.toString("utf8"));
    if (found !== null) {
      throw new Error(
        `artifact would contain a credential-looking assignment in ${entry.name}`,
      );
    }
  }
};

/** Build a reproducible, self-contained package tarball. */
export function buildArtifact(options) {
  const outFile = resolve(options.outFile);
  const credentials = (options.credentials ?? []).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const dist = join(packageRoot, "dist");
  if (!existsSync(join(dist, "index.js"))) {
    throw new Error(
      "dist/index.js is missing; build the package before packaging",
    );
  }
  if (!existsSync(join(dist, "index.js.map"))) {
    throw new Error("dist/index.js.map is missing; enable source maps");
  }
  const closure = runtimeClosure(manifest, packageRoot);
  const vendored = [...closure.keys()].sort();
  const hostInstalled = HOST_INSTALLED_NATIVE.filter(
    (name) => manifest.dependencies?.[name] !== undefined,
  );
  const vendoredEntries = vendored.flatMap((name) => {
    const info = closure.get(name);
    const declared = Array.isArray(info.manifest.files)
      ? info.manifest.files.filter((value) => typeof value === "string")
      : undefined;
    return collectFiles(info.directory, `${VENDOR_PREFIX}${name}`, {
      skip: VENDOR_SKIP,
      root: info.directory,
      ...(declared === undefined
        ? {}
        : { includes: declared.map(globToRegExp) }),
    });
  });
  const vendoredLicenses = vendoredEntries
    .filter((entry) => LICENSE_FILE.test(basename(entry.name)))
    .map((entry) => entry.name.slice(VENDOR_PREFIX.length))
    .sort();
  const schema = readFileSync(join(dist, "store/schema.sql"));
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    ...installable
  } = manifest;
  const packagedManifest = {
    ...installable,
    dependencies: Object.fromEntries(
      Object.entries(installable.dependencies ?? {}).filter(
        ([name]) => !vendored.includes(name),
      ),
    ),
    qhbVendoredDependencies: vendored,
    qhbHostInstalledDependencies: hostInstalled,
    qhbVendoredLicenses: vendoredLicenses,
    qhbSchemaSha256: createHash("sha256").update(schema).digest("hex"),
  };
  const license = existsSync(join(packageRoot, "../../LICENSE"))
    ? join(packageRoot, "../../LICENSE")
    : undefined;
  const entries = [
    {
      name: "package/package.json",
      data: Buffer.from(
        `${JSON.stringify(packagedManifest, null, 2)}\n`,
        "utf8",
      ),
    },
    {
      name: "package/cordis.example.yml",
      data: readFileSync(join(packageRoot, "cordis.example.yml")),
    },
    {
      name: "package/cordis.patch.yml",
      data: readFileSync(join(packageRoot, "cordis.patch.yml")),
    },
    ...collectFiles(dist, "package/dist"),
    ...vendoredEntries,
    ...(license === undefined
      ? []
      : [{ name: "package/LICENSE", data: readFileSync(license) }]),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  assertCredentialFree(entries, credentials);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, createTar(entries));
  return {
    outFile,
    version: manifest.version,
    entries: entries.map((entry) => entry.name),
    vendoredDependencies: vendored,
    hostInstalledDependencies: hostInstalled,
    vendoredLicenses,
    manifest: packagedManifest,
    sha256: createHash("sha256").update(readFileSync(outFile)).digest("hex"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out =
    process.argv[2] ??
    join(packageRoot, "dist-package", "qhb-harness-plugin.tar");
  const result = buildArtifact({
    outFile: out,
    credentials: [process.env.QHB_BOOTSTRAP_CREDENTIAL ?? ""],
  });
  process.stdout.write(
    `packaged ${result.entries.length} entries at version ${result.version} with ${result.vendoredDependencies.length} vendored runtime packages and ${result.vendoredLicenses.length} vendored license files`,
  );
  process.stdout.write(`\nsha256 ${result.sha256}\n`);
}
