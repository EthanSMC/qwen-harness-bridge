import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginConfig } from "./config.js";
import {
  type CredentialReader,
  CredentialUnavailableError,
  MacOSKeychainCredentialReader,
} from "./keychain.js";

/** Public evidence records the source kind only, never the value or location. */
export type CredentialSourceKind = "keychain" | "file" | "environment";

export interface CredentialSource {
  readonly kind: CredentialSourceKind;
  readonly reader: CredentialReader;
}

/** Bounded credential read: 16 KiB, matching the Keychain reader's ceiling. */
export const MAX_CREDENTIAL_SOURCE_BYTES = 16 * 1024;

/** `security` prints one trailing newline; every source trims exactly one. */
const trimSingleTrailingNewline = (value: string): string => {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
};

const boundedValue = (raw: string): string => {
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_SOURCE_BYTES) {
    throw new CredentialUnavailableError();
  }
  const value = trimSingleTrailingNewline(raw);
  if (value.length === 0) throw new CredentialUnavailableError();
  return value;
};

/** Reads a bounded, canonical, non-symlinked regular file. */
const readCredentialFile = (path: string): string => {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new CredentialUnavailableError();
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CredentialUnavailableError();
  }
  try {
    if (realpathSync.native(path) !== path)
      throw new CredentialUnavailableError();
    const parent = dirname(path);
    if (realpathSync.native(parent) !== parent) {
      throw new CredentialUnavailableError();
    }
  } catch (error) {
    if (error instanceof CredentialUnavailableError) throw error;
    throw new CredentialUnavailableError();
  }
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_CREDENTIAL_SOURCE_BYTES) {
    throw new CredentialUnavailableError();
  }
  return boundedValue(readFileSync(path, "utf8"));
};

class FileCredentialReader implements CredentialReader {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  read(): Promise<string> {
    try {
      return Promise.resolve(readCredentialFile(this.#path));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class EnvironmentCredentialReader implements CredentialReader {
  readonly #variable: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(variable: string, environment: NodeJS.ProcessEnv) {
    this.#variable = variable;
    this.#environment = environment;
  }

  read(): Promise<string> {
    const raw = this.#environment[this.#variable];
    if (typeof raw !== "string") {
      return Promise.reject(new CredentialUnavailableError());
    }
    try {
      return Promise.resolve(boundedValue(raw));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/**
 * Select the bootstrap credential source. macOS Keychain is the default and the
 * only automatic source everywhere; an explicit `file` or `environment` source
 * is opt-in, and a missing source keeps failing closed instead of silently
 * selecting something else. Reads are bounded and never echo the value.
 *
 * `platform` is accepted so callers and tests state the host they select for;
 * the approved contract (ADR 0008) is platform-uniform.
 */
export const createCredentialReader = (
  config: PluginConfig,
  options: Readonly<{
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
  }> = {},
): CredentialSource => {
  const source = config.credentialSource;
  if (source === undefined || source.kind === "keychain") {
    return Object.freeze({
      kind: "keychain" as const,
      reader: new MacOSKeychainCredentialReader(),
    });
  }
  if (source.kind === "file") {
    return Object.freeze({
      kind: "file" as const,
      reader: new FileCredentialReader(source.path),
    });
  }
  return Object.freeze({
    kind: "environment" as const,
    reader: new EnvironmentCredentialReader(
      source.variable,
      options.environment ?? process.env,
    ),
  });
};
