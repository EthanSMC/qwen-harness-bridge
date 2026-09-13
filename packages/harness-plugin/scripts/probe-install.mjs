import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Installs nothing and imports nothing from the repository: this process runs
 * inside a clean extension root and can only see the packaged artifact plus the
 * host-provided peers.
 */
const [extensionRoot, configPath, mode] = process.argv.slice(2);
const entry = await import(
  pathToFileURL(join(extensionRoot, "dist/index.js")).href
);
const config = entry.parsePluginConfig(
  JSON.parse(readFileSync(configPath, "utf8")),
);
const store = new entry.SqlitePluginStore(config.databasePath);
store.close();

const credential = { attempted: false, outcome: null, code: null };
if (mode === "--keychain") {
  credential.attempted = true;
  try {
    const reader = new entry.MacOSKeychainCredentialReader();
    const value = await reader.read(
      config.keychainService,
      config.keychainAccount,
    );
    credential.outcome =
      typeof value === "string" && value.length > 0 ? "read" : "empty";
  } catch (error) {
    credential.outcome = "fail-closed";
    credential.code = error?.code ?? error?.name ?? "UNKNOWN";
  }
}

process.stdout.write(
  JSON.stringify({
    name: entry.name,
    apply: typeof entry.apply,
    inject: [...entry.inject],
    connectorId: config.connectorId,
    controlPlaneUrl: config.controlPlaneUrl,
    keychainService: config.keychainService,
    keychainAccount: config.keychainAccount,
    databasePath: config.databasePath,
    repositoryCount: config.repositories.length,
    canonicalPath: config.repositories[0].canonicalPath,
    approvalTimeoutSeconds: config.repositories[0].approvalTimeoutSeconds,
    credential,
  }),
);
