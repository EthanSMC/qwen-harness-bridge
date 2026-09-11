import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTar } from "./tar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const collectFiles = (directory, prefix) => {
  const files = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, `${prefix}/${name}`));
    } else {
      files.push({ name: `${prefix}/${name}`, data: readFileSync(full) });
    }
  }
  return files;
};

/**
 * Matches a quoted literal assigned to a credential-looking key. Type annotations,
 * empty defaults, and local variables such as `token = Symbol("event-task")` are not
 * credentials and must not block packaging.
 */
export const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/iu;

/** Build a reproducible package tarball. Throws if a supplied credential value
 * or a credential-looking assignment would be copied into the artifact. */
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
  const license = existsSync(join(packageRoot, "../../LICENSE"))
    ? join(packageRoot, "../../LICENSE")
    : undefined;
  const entries = [
    {
      name: "package/package.json",
      data: readFileSync(join(packageRoot, "package.json")),
    },
    {
      name: "package/cordis.example.yml",
      data: readFileSync(join(packageRoot, "cordis.example.yml")),
    },
    ...collectFiles(dist, "package/dist"),
    ...(license === undefined
      ? []
      : [{ name: "package/LICENSE", data: readFileSync(license) }]),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  const serialized = entries
    .map((entry) => entry.data.toString("utf8"))
    .join("\n");
  for (const secret of credentials) {
    if (serialized.includes(secret)) {
      throw new Error("artifact would contain a credential value");
    }
  }
  if (CREDENTIAL_ASSIGNMENT.test(serialized)) {
    throw new Error("artifact would contain a credential-looking assignment");
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, createTar(entries));
  return {
    outFile,
    version: manifest.version,
    entries: entries.map((entry) => entry.name),
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
    `packaged ${result.entries.length} entries at version ${result.version}\n`,
  );
}
