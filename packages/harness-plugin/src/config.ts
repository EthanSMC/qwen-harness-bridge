import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const repositorySchema = z
  .object({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    canonicalPath: z.string().trim().min(1),
    approvalTimeoutSeconds: z.number().int().min(60).max(1_800),
  })
  .strict();

const pluginConfigSchema = z
  .object({
    connectorId: z.string().trim().min(1),
    controlPlaneUrl: z
      .string()
      .trim()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "wss:" && url.hostname.length > 0;
        } catch {
          return false;
        }
      }),
    keychainService: z.string().trim().min(1),
    keychainAccount: z.string().trim().min(1),
    databasePath: z.string().trim().min(1),
    repositories: z.array(repositorySchema).min(1),
  })
  .strict();

export type PluginConfig = Readonly<{
  connectorId: string;
  controlPlaneUrl: `wss://${string}`;
  keychainService: string;
  keychainAccount: string;
  databasePath: string;
  repositories: ReadonlyArray<
    Readonly<{
      id: string;
      displayName: string;
      canonicalPath: string;
      approvalTimeoutSeconds: number;
    }>
  >;
}>;

export type ConfigValidationCode =
  | "INVALID_PLUGIN_CONFIG"
  | "INVALID_DATABASE_PATH"
  | "DATABASE_PATH_UNAVAILABLE"
  | "DATABASE_PATH_NOT_CANONICAL"
  | "DUPLICATE_REPOSITORY_ID"
  | "REPOSITORY_PATH_UNAVAILABLE"
  | "REPOSITORY_PATH_NOT_CANONICAL";

export class ConfigValidationError extends Error {
  readonly code: ConfigValidationCode;
  readonly repositoryId: string | undefined;

  constructor(code: ConfigValidationCode, repositoryId?: string) {
    super(repositoryId === undefined ? code : `${code}:${repositoryId}`);
    this.name = "ConfigValidationError";
    this.code = code;
    this.repositoryId = repositoryId;
  }
}

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
};

const parseInput = (input: string | unknown): unknown => {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ConfigValidationError("INVALID_PLUGIN_CONFIG");
  }
};

const canonicalRepositoryPath = (
  repository: z.infer<typeof repositorySchema>,
): string => {
  if (!isAbsolute(repository.canonicalPath)) {
    throw new ConfigValidationError(
      "REPOSITORY_PATH_NOT_CANONICAL",
      repository.id,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync.native(repository.canonicalPath);
    if (!statSync(resolvedPath).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new ConfigValidationError(
      "REPOSITORY_PATH_UNAVAILABLE",
      repository.id,
    );
  }

  if (resolvedPath !== repository.canonicalPath) {
    throw new ConfigValidationError(
      "REPOSITORY_PATH_NOT_CANONICAL",
      repository.id,
    );
  }
  return resolvedPath;
};

const canonicalDatabasePath = (databasePath: string): string => {
  if (!isAbsolute(databasePath)) {
    throw new ConfigValidationError("INVALID_DATABASE_PATH");
  }

  let parentPath: string;
  try {
    parentPath = realpathSync.native(dirname(databasePath));
  } catch {
    throw new ConfigValidationError("DATABASE_PATH_UNAVAILABLE");
  }

  const resolvedPath = join(parentPath, basename(databasePath));
  if (!existsSync(databasePath)) return resolvedPath;

  try {
    if (realpathSync.native(databasePath) !== databasePath) {
      throw new ConfigValidationError("DATABASE_PATH_NOT_CANONICAL");
    }
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError("DATABASE_PATH_UNAVAILABLE");
  }
  return resolvedPath;
};

export function parsePluginConfig(input: string | unknown): PluginConfig {
  const parsedInput = parseInput(input);
  const parsed = pluginConfigSchema.safeParse(parsedInput);
  if (!parsed.success) {
    throw new ConfigValidationError("INVALID_PLUGIN_CONFIG");
  }

  const repositoryIds = new Set<string>();
  for (const repository of parsed.data.repositories) {
    if (repositoryIds.has(repository.id)) {
      throw new ConfigValidationError("DUPLICATE_REPOSITORY_ID", repository.id);
    }
    repositoryIds.add(repository.id);
  }

  const config: PluginConfig = {
    connectorId: parsed.data.connectorId,
    controlPlaneUrl: parsed.data.controlPlaneUrl as `wss://${string}`,
    keychainService: parsed.data.keychainService,
    keychainAccount: parsed.data.keychainAccount,
    databasePath: canonicalDatabasePath(parsed.data.databasePath),
    repositories: parsed.data.repositories.map((repository) => ({
      id: repository.id,
      displayName: repository.displayName,
      canonicalPath: canonicalRepositoryPath(repository),
      approvalTimeoutSeconds: repository.approvalTimeoutSeconds,
    })),
  };

  return deepFreeze(config);
}
