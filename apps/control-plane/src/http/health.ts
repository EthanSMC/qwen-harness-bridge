import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import type { Database } from "../db/client.js";

export type MigrationIdentity = Readonly<{
  tag: string;
  createdAt: number;
  hash: string;
}>;

type MigrationJournal = Readonly<{
  entries?: readonly Readonly<{
    tag?: unknown;
    when?: unknown;
  }>[];
}>;

const readBundledMigrationIdentity = (): MigrationIdentity => {
  const journal = JSON.parse(
    readFileSync(
      new URL("../db/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as MigrationJournal;
  const entry = journal.entries?.at(-1);
  if (
    entry === undefined ||
    typeof entry.tag !== "string" ||
    !/^[a-z0-9_]+$/u.test(entry.tag) ||
    typeof entry.when !== "number" ||
    !Number.isSafeInteger(entry.when)
  ) {
    throw new Error("Serving image migration journal is invalid");
  }
  const migrationSql = readFileSync(
    new URL(`../db/migrations/${entry.tag}.sql`, import.meta.url),
    "utf8",
  );
  return {
    tag: entry.tag,
    createdAt: entry.when,
    hash: createHash("sha256").update(migrationSql, "utf8").digest("hex"),
  };
};

export const EXPECTED_MIGRATION = readBundledMigrationIdentity();

const PROBE_SENTINEL = "qhb_health_probe";
const DEFAULT_DEADLINE_MS = 1_000;

export type ReadinessProbe = Readonly<{
  assertReady(): Promise<void>;
}>;

type ReadinessTransactionContext = Readonly<{
  backendPid: number;
  readMigrationMetadata(): Promise<{
    tag: string;
    createdAt: number;
    hash: string;
  }>;
  writeProbeSentinel(sentinel: string): Promise<void>;
  readProbeSentinel(): Promise<string>;
}>;

export type ReadinessTransactionPort = Readonly<{
  withTransaction(
    callback: (context: ReadinessTransactionContext) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}>;

export type ReadinessTransactionOptions = Readonly<{
  deadlineMs: number;
}>;

export type ReadinessSqlClientFactory = () => Sql;

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
};

const assertExpectedMigration = (actual: {
  tag: string;
  createdAt: number;
  hash: string;
}): void => {
  if (
    actual.tag !== EXPECTED_MIGRATION.tag ||
    actual.createdAt !== EXPECTED_MIGRATION.createdAt ||
    actual.hash !== EXPECTED_MIGRATION.hash
  ) {
    throw new Error("Readiness migration does not match the serving image");
  }
};

export async function assertReadinessTransaction(
  port: ReadinessTransactionPort,
  options: ReadinessTransactionOptions = { deadlineMs: DEFAULT_DEADLINE_MS },
): Promise<void> {
  assertPositiveInteger(options.deadlineMs, "Readiness deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operation = port.withTransaction(async (context) => {
    const throwIfAborted = (): void => {
      if (controller.signal.aborted) {
        throw new Error("Readiness probe aborted");
      }
    };
    throwIfAborted();
    const migration = await context.readMigrationMetadata();
    throwIfAborted();
    assertExpectedMigration(migration);
    await context.writeProbeSentinel(PROBE_SENTINEL);
    throwIfAborted();
    const sentinel = await context.readProbeSentinel();
    throwIfAborted();
    if (sentinel !== PROBE_SENTINEL) {
      throw new Error("Readiness probe sentinel did not round-trip");
    }
  }, controller.signal);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("Readiness probe deadline exceeded"));
    }, options.deadlineMs);
  });

  try {
    await Promise.race([operation, deadline]);
  } catch (error) {
    if (timedOut) {
      await operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const numericRowValue = (value: unknown): number | undefined => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
};

export function createPostgresReadinessTransactionPort(
  database: Database,
  options: Readonly<{ statementTimeoutMs: number }>,
): ReadinessTransactionPort {
  assertPositiveInteger(options.statementTimeoutMs, "Statement timeout");
  return {
    async withTransaction(callback, signal) {
      await database.transaction(async (transaction) => {
        if (signal?.aborted) {
          throw new Error("Readiness transaction aborted");
        }
        await transaction.execute(
          sql.raw(
            `SET LOCAL statement_timeout = ${options.statementTimeoutMs}`,
          ),
        );
        const pidRows = await transaction.execute(
          sql`SELECT pg_backend_pid() AS "backendPid"`,
        );
        const backendPid = numericRowValue(
          (pidRows[0] as { backendPid?: unknown } | undefined)?.backendPid,
        );
        if (backendPid === undefined) {
          throw new Error("Readiness backend identity is unavailable");
        }

        const context: ReadinessTransactionContext = {
          backendPid,
          async readMigrationMetadata() {
            const rows = await transaction.execute(sql`
              SELECT hash, created_at AS "createdAt"
              FROM drizzle.__drizzle_migrations
              ORDER BY created_at DESC
              LIMIT 1
            `);
            const row = rows[0] as
              | { hash?: unknown; createdAt?: unknown }
              | undefined;
            const createdAt = numericRowValue(row?.createdAt);
            if (typeof row?.hash !== "string" || createdAt === undefined) {
              throw new Error("Readiness migration metadata is unavailable");
            }
            return {
              tag: EXPECTED_MIGRATION.tag,
              createdAt,
              hash: row.hash,
            };
          },
          async writeProbeSentinel(sentinel) {
            await transaction.execute(sql`
              CREATE TEMP TABLE qhb_health_probe (
                sentinel text NOT NULL
              ) ON COMMIT DROP
            `);
            await transaction.execute(
              sql`INSERT INTO qhb_health_probe (sentinel) VALUES (${sentinel})`,
            );
          },
          async readProbeSentinel() {
            const rows = await transaction.execute(
              sql`SELECT sentinel FROM qhb_health_probe LIMIT 1`,
            );
            const value = (rows[0] as { sentinel?: unknown } | undefined)
              ?.sentinel;
            if (typeof value !== "string") {
              throw new Error("Readiness probe sentinel is unavailable");
            }
            return value;
          },
        };
        await callback(context);
      });
    },
  };
}

export function createReadinessSqlClientFactory(
  databaseUrl: string,
  options: Readonly<{ connectTimeoutSeconds: number }>,
): ReadinessSqlClientFactory {
  assertPositiveInteger(options.connectTimeoutSeconds, "Connect timeout");
  return () =>
    postgres(databaseUrl, {
      max: 1,
      connect_timeout: options.connectTimeoutSeconds,
      idle_timeout: 1,
      prepare: false,
    });
}

export function createCancellablePostgresReadinessTransactionPort(
  createClient: ReadinessSqlClientFactory,
  options: Readonly<{ statementTimeoutMs: number }>,
): ReadinessTransactionPort {
  assertPositiveInteger(options.statementTimeoutMs, "Statement timeout");
  return {
    async withTransaction(callback, signal) {
      const client = createClient();
      let closePromise: Promise<void> | undefined;
      const closeClient = (): Promise<void> => {
        closePromise ??= client.end({ timeout: 0 });
        return closePromise;
      };
      const onAbort = (): void => {
        void closeClient().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await client.begin(async (transaction) => {
          if (signal?.aborted) {
            throw new Error("Readiness transaction aborted");
          }
          await transaction.unsafe(
            `SET LOCAL statement_timeout = ${options.statementTimeoutMs}`,
          );
          const pidRows = await transaction.unsafe<
            { backendPid: number | string }[]
          >('SELECT pg_backend_pid() AS "backendPid"');
          const backendPid = numericRowValue(pidRows[0]?.backendPid);
          if (backendPid === undefined) {
            throw new Error("Readiness backend identity is unavailable");
          }
          const context: ReadinessTransactionContext = {
            backendPid,
            async readMigrationMetadata() {
              const rows = await transaction.unsafe<
                { hash: string; createdAt: number | string }[]
              >(`
                SELECT hash, created_at AS "createdAt"
                FROM drizzle.__drizzle_migrations
                ORDER BY created_at DESC
                LIMIT 1
              `);
              const row = rows[0];
              const createdAt = numericRowValue(row?.createdAt);
              if (typeof row?.hash !== "string" || createdAt === undefined) {
                throw new Error("Readiness migration metadata is unavailable");
              }
              return {
                tag: EXPECTED_MIGRATION.tag,
                createdAt,
                hash: row.hash,
              };
            },
            async writeProbeSentinel(sentinel) {
              await transaction.unsafe(`
                CREATE TEMP TABLE qhb_health_probe (
                  sentinel text NOT NULL
                ) ON COMMIT DROP
              `);
              await transaction.unsafe(
                "INSERT INTO qhb_health_probe (sentinel) VALUES ($1)",
                [sentinel],
              );
            },
            async readProbeSentinel() {
              const rows = await transaction.unsafe<{ sentinel: string }[]>(
                "SELECT sentinel FROM qhb_health_probe LIMIT 1",
              );
              const value = rows[0]?.sentinel;
              if (typeof value !== "string") {
                throw new Error("Readiness probe sentinel is unavailable");
              }
              return value;
            },
          };
          await callback(context);
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await closeClient();
      }
    },
  };
}

export function createCancellablePostgresReadinessProbe(
  createClient: ReadinessSqlClientFactory,
  options: Readonly<{
    statementTimeoutMs: number;
    deadlineMs?: number;
  }>,
): ReadinessProbe {
  const port = createCancellablePostgresReadinessTransactionPort(
    createClient,
    options,
  );
  return {
    assertReady: () =>
      assertReadinessTransaction(port, {
        deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      }),
  };
}

export function createPostgresReadinessProbe(
  database: Database,
  options: Readonly<{
    statementTimeoutMs: number;
    deadlineMs?: number;
  }>,
): ReadinessProbe {
  const port = createPostgresReadinessTransactionPort(database, options);
  return {
    assertReady: () =>
      assertReadinessTransaction(port, {
        deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      }),
  };
}
