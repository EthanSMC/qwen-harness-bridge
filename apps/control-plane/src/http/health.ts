import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

export const EXPECTED_MIGRATION = {
  tag: "0002_result_acknowledgement",
  createdAt: 1788244364352,
  hash: "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
} as const;

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
  ): Promise<void>;
}>;

export type ReadinessTransactionOptions = Readonly<{
  deadlineMs: number;
}>;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = port.withTransaction(async (context) => {
    const migration = await context.readMigrationMetadata();
    assertExpectedMigration(migration);
    await context.writeProbeSentinel(PROBE_SENTINEL);
    const sentinel = await context.readProbeSentinel();
    if (sentinel !== PROBE_SENTINEL) {
      throw new Error("Readiness probe sentinel did not round-trip");
    }
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Readiness probe deadline exceeded")),
      options.deadlineMs,
    );
  });

  try {
    await Promise.race([operation, deadline]);
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
    async withTransaction(callback) {
      await database.transaction(async (transaction) => {
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
