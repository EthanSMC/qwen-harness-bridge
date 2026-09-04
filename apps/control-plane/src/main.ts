import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import { resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { type AppConfig, config, requireTlsPaths } from "./config.js";
import { closeDatabase, db, terminateDatabaseOperations } from "./db/client.js";
import { JobRepository } from "./db/job-repository.js";
import {
  Aes256GcmEncryptor,
  JobCoordinator,
} from "./domain/job-coordinator.js";
import { createApp } from "./http/app.js";
import {
  createCancellablePostgresReadinessProbe,
  createReadinessSqlClientFactory,
} from "./http/health.js";
import {
  createMetricsRegistry,
  createPostgresMetricsAdapter,
} from "./http/metrics.js";
import { closeRuntimeResources } from "./http/shutdown.js";

export type RuntimeConfiguration = Readonly<{
  ownerId: string;
  mcpBearerToken: string;
  requestEncryptionKey: string;
  connectorSessionSigningKey: string;
  tlsCertPath: string;
  tlsKeyPath: string;
}>;

export const requiredConfiguration = (
  value: AppConfig = config,
): RuntimeConfiguration => {
  if (
    value.ownerId === undefined ||
    value.mcpBearerToken === undefined ||
    value.requestEncryptionKey === undefined ||
    value.connectorSessionSigningKey === undefined
  ) {
    throw new Error(
      "QHB_OWNER_ID, QHB_MCP_BEARER_TOKEN, QHB_REQUEST_ENCRYPTION_KEY, and QHB_CONNECTOR_SESSION_SIGNING_KEY are required",
    );
  }
  const tls = requireTlsPaths(value);
  return {
    ownerId: value.ownerId,
    mcpBearerToken: value.mcpBearerToken,
    requestEncryptionKey: value.requestEncryptionKey,
    connectorSessionSigningKey: value.connectorSessionSigningKey,
    tlsCertPath: tls.certPath,
    tlsKeyPath: tls.keyPath,
  };
};

export const readTlsOptions = (
  value: Pick<RuntimeConfiguration, "tlsCertPath" | "tlsKeyPath">,
): Pick<HttpsServerOptions, "cert" | "key"> => {
  try {
    const cert = readFileSync(value.tlsCertPath);
    const key = readFileSync(value.tlsKeyPath);
    createSecureContext({ cert, key });
    return { cert, key };
  } catch {
    throw new Error("QHB TLS certificate and key are invalid");
  }
};

export async function start() {
  const runtime = requiredConfiguration();
  const https = readTlsOptions(runtime);
  const cipher = new Aes256GcmEncryptor(
    createHash("sha256").update(runtime.requestEncryptionKey, "utf8").digest(),
  );
  const coordinator = new JobCoordinator({
    repository: new JobRepository(db),
    encryptor: cipher,
    now: () => new Date(),
  });
  let draining = false;
  const metrics = createMetricsRegistry({
    readSnapshot: createPostgresMetricsAdapter(db).readSnapshot,
  });
  const readinessProbe = createCancellablePostgresReadinessProbe(
    createReadinessSqlClientFactory(config.databaseUrl, {
      connectTimeoutSeconds: 1,
    }),
    { statementTimeoutMs: 250 },
  );
  const app = await createApp({
    coordinator,
    ownerId: runtime.ownerId,
    mcpBearerToken: runtime.mcpBearerToken,
    https,
    readinessProbe,
    isDraining: () => draining,
    metrics,
    connectorGateway: {
      database: db,
      sessionSigningKey: runtime.connectorSessionSigningKey,
      terminateStoreOperations: terminateDatabaseOperations,
      requestDecryptor: cipher,
      metrics,
    },
  });
  await app.listen({ port: config.port, host: config.host });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    draining = true;
    shutdownPromise = closeRuntimeResources(() => app.close(), closeDatabase);
    return shutdownPromise;
  };
  const onSignal = (): void => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  return app;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  void start().catch(() => {
    console.error("QHB control plane failed to start.");
    process.exitCode = 1;
  });
}
