import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;

const runtimeEnvironment =
  (
    globalThis as typeof globalThis & {
      process?: { env?: Environment };
    }
  ).process?.env ?? {};

const postgresUrlSchema = z
  .string()
  .trim()
  .min(1, "DATABASE_URL is required")
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "DATABASE_URL must be a PostgreSQL URL");

const optionalSecretSchema = z.string().trim().min(32).optional();
const optionalPathSchema = z.string().trim().min(1).optional();

const environmentSchema = z
  .object({
    DATABASE_URL: postgresUrlSchema,
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_IDLE_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(3_600)
      .default(20),
    DB_CONNECT_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(10),
    QHB_OWNER_ID: z.string().trim().min(1).optional(),
    QHB_MCP_BEARER_TOKEN: optionalSecretSchema,
    QHB_REQUEST_ENCRYPTION_KEY: optionalSecretSchema,
    QHB_CONNECTOR_SESSION_SIGNING_KEY: optionalSecretSchema,
    QHB_TLS_CERT_PATH: optionalPathSchema,
    QHB_TLS_KEY_PATH: optionalPathSchema,
  })
  .superRefine((value, context) => {
    const secretPairs = [
      ["QHB_MCP_BEARER_TOKEN", "QHB_REQUEST_ENCRYPTION_KEY"],
      ["QHB_MCP_BEARER_TOKEN", "QHB_CONNECTOR_SESSION_SIGNING_KEY"],
      ["QHB_REQUEST_ENCRYPTION_KEY", "QHB_CONNECTOR_SESSION_SIGNING_KEY"],
    ] as const;

    for (const [firstSecret, secondSecret] of secretPairs) {
      if (
        value[firstSecret] !== undefined &&
        value[firstSecret] === value[secondSecret]
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [secondSecret],
          message: `${firstSecret} and ${secondSecret} must be different`,
        });
      }
    }

    const hasCertificate = value.QHB_TLS_CERT_PATH !== undefined;
    const hasKey = value.QHB_TLS_KEY_PATH !== undefined;
    if (hasCertificate !== hasKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasCertificate ? "QHB_TLS_KEY_PATH" : "QHB_TLS_CERT_PATH"],
        message:
          "QHB_TLS_CERT_PATH and QHB_TLS_KEY_PATH must be provided together",
      });
    }
  });

export type AppConfig = {
  databaseUrl: string;
  port: number;
  host: string;
  dbPoolMax: number;
  dbIdleTimeoutSeconds: number;
  dbConnectTimeoutSeconds: number;
  ownerId?: string;
  mcpBearerToken?: string;
  requestEncryptionKey?: string;
  connectorSessionSigningKey?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
};

export type TlsPathConfig = Readonly<{
  certPath: string;
  keyPath: string;
}>;

export function loadConfig(
  environment: Environment = runtimeEnvironment,
): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    host: parsed.HOST,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbIdleTimeoutSeconds: parsed.DB_IDLE_TIMEOUT_SECONDS,
    dbConnectTimeoutSeconds: parsed.DB_CONNECT_TIMEOUT_SECONDS,
    ...(parsed.QHB_OWNER_ID === undefined
      ? {}
      : { ownerId: parsed.QHB_OWNER_ID }),
    ...(parsed.QHB_MCP_BEARER_TOKEN === undefined
      ? {}
      : { mcpBearerToken: parsed.QHB_MCP_BEARER_TOKEN }),
    ...(parsed.QHB_REQUEST_ENCRYPTION_KEY === undefined
      ? {}
      : { requestEncryptionKey: parsed.QHB_REQUEST_ENCRYPTION_KEY }),
    ...(parsed.QHB_CONNECTOR_SESSION_SIGNING_KEY === undefined
      ? {}
      : {
          connectorSessionSigningKey: parsed.QHB_CONNECTOR_SESSION_SIGNING_KEY,
        }),
    ...(parsed.QHB_TLS_CERT_PATH === undefined
      ? {}
      : { tlsCertPath: parsed.QHB_TLS_CERT_PATH }),
    ...(parsed.QHB_TLS_KEY_PATH === undefined
      ? {}
      : { tlsKeyPath: parsed.QHB_TLS_KEY_PATH }),
  };
}

export function requireTlsPaths(
  value: Pick<AppConfig, "tlsCertPath" | "tlsKeyPath">,
): TlsPathConfig {
  if (value.tlsCertPath === undefined || value.tlsKeyPath === undefined) {
    throw new Error("QHB_TLS_CERT_PATH and QHB_TLS_KEY_PATH are required");
  }
  return { certPath: value.tlsCertPath, keyPath: value.tlsKeyPath };
}

export const config = loadConfig();
