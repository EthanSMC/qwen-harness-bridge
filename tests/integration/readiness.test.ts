import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../apps/control-plane/node_modules/drizzle-orm";
import { createTestDatabase } from "./support/postgres.js";

type ReadinessProbe = Readonly<{
  assertReady(): Promise<void>;
}>;

const database = createTestDatabase();

const assertSafeExternalTestDatabase = (): void => {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl === undefined || externalUrl.length === 0) {
    return;
  }

  if (process.env.QHB_TEST_DATABASE_IS_EPHEMERAL !== "1") {
    throw new Error(
      "TEST_DATABASE_URL requires QHB_TEST_DATABASE_IS_EPHEMERAL=1",
    );
  }

  let databaseName: string;
  try {
    const parsed = new URL(externalUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported database URL protocol");
    }
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must name a PostgreSQL database with the qhb_issue_7_ prefix",
    );
  }

  if (!databaseName.startsWith("qhb_issue_7_")) {
    throw new Error(
      "TEST_DATABASE_URL must name a PostgreSQL database with the qhb_issue_7_ prefix",
    );
  }
};

beforeAll(async () => {
  assertSafeExternalTestDatabase();
  await database.start();
});

afterAll(async () => {
  await database.stop();
});

type ExpectedMigration = Readonly<{
  tag: string;
  createdAt: number;
  hash: string;
}>;

type ReadinessTransactionPort = Readonly<{
  readMigrationMetadata(): Promise<ExpectedMigration>;
  writeReadProbe(): Promise<string>;
}>;

const READINESS_PROBE_SENTINEL = "qhb_health_probe";

type HealthModule = Readonly<{
  EXPECTED_MIGRATION: ExpectedMigration;
  assertReadinessTransaction(port: ReadinessTransactionPort): Promise<void>;
  createPostgresReadinessProbe(
    database: typeof database.client,
    options?: { statementTimeoutMs: number },
  ): ReadinessProbe;
}>;

const loadHealthModule = async (): Promise<HealthModule> =>
  (await import("../../apps/control-plane/src/db/health.js")) as HealthModule;

const applicationRowCount = async (): Promise<number> => {
  const result = await database.query<{ row_count: string }>(
    `SELECT (
       (SELECT count(*) FROM owners) +
       (SELECT count(*) FROM repository_policies) +
       (SELECT count(*) FROM connectors) +
       (SELECT count(*) FROM jobs) +
       (SELECT count(*) FROM job_events) +
       (SELECT count(*) FROM approvals) +
       (SELECT count(*) FROM connector_messages) +
       (SELECT count(*) FROM idempotency_records)
     )::text AS row_count`,
  );
  return Number(result.rows[0]?.row_count ?? "0");
};

describe("readiness transaction orchestrator contract", () => {
  it("checks migration metadata before the temporary write/read", async () => {
    const health = await loadHealthModule();
    const callOrder: string[] = [];

    await expect(
      health.assertReadinessTransaction({
        async readMigrationMetadata() {
          callOrder.push("read-migration-metadata");
          return health.EXPECTED_MIGRATION;
        },
        async writeReadProbe() {
          callOrder.push("write-read-probe");
          return READINESS_PROBE_SENTINEL;
        },
      }),
    ).resolves.toBeUndefined();

    expect(callOrder).toEqual(["read-migration-metadata", "write-read-probe"]);
  });

  it("rejects a wrong migration tag before the temporary write/read", async () => {
    const health = await loadHealthModule();
    const callOrder: string[] = [];

    await expect(
      health.assertReadinessTransaction({
        async readMigrationMetadata() {
          callOrder.push("read-migration-metadata");
          return { ...health.EXPECTED_MIGRATION, tag: "0001_initial" };
        },
        async writeReadProbe() {
          callOrder.push("write-read-probe");
          return READINESS_PROBE_SENTINEL;
        },
      }),
    ).rejects.toThrow();

    expect(callOrder).toEqual(["read-migration-metadata"]);
  });

  it.each([
    ["createdAt", { createdAt: 1788244364351 }],
    ["hash", { hash: "0" }],
  ] as const)(
    "rejects a wrong migration %s before the temporary write/read",
    async (_field, mismatch) => {
      const health = await loadHealthModule();
      const callOrder: string[] = [];

      await expect(
        health.assertReadinessTransaction({
          async readMigrationMetadata() {
            callOrder.push("read-migration-metadata");
            return { ...health.EXPECTED_MIGRATION, ...mismatch };
          },
          async writeReadProbe() {
            callOrder.push("write-read-probe");
            return READINESS_PROBE_SENTINEL;
          },
        }),
      ).rejects.toThrow();

      expect(callOrder).toEqual(["read-migration-metadata"]);
    },
  );

  it("rejects when the temporary write/read returns the wrong sentinel", async () => {
    const health = await loadHealthModule();
    const callOrder: string[] = [];

    await expect(
      health.assertReadinessTransaction({
        async readMigrationMetadata() {
          callOrder.push("read-migration-metadata");
          return health.EXPECTED_MIGRATION;
        },
        async writeReadProbe() {
          callOrder.push("write-read-probe");
          return "wrong-sentinel";
        },
      }),
    ).rejects.toThrow();

    expect(callOrder).toEqual(["read-migration-metadata", "write-read-probe"]);
  });

  it("rejects when the temporary write/read throws", async () => {
    const health = await loadHealthModule();
    const callOrder: string[] = [];
    const failure = new Error("READINESS_WRITE_READ_FAILURE");

    await expect(
      health.assertReadinessTransaction({
        async readMigrationMetadata() {
          callOrder.push("read-migration-metadata");
          return health.EXPECTED_MIGRATION;
        },
        async writeReadProbe() {
          callOrder.push("write-read-probe");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(callOrder).toEqual(["read-migration-metadata", "write-read-probe"]);
  });
});

describe("PostgreSQL readiness probe", () => {
  it("checks the exact migration and rolls back its temporary write/read probe", async () => {
    const health = await loadHealthModule();
    expect(health.EXPECTED_MIGRATION).toEqual({
      tag: "0002_result_acknowledgement",
      createdAt: 1788244364352,
      hash: "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
    });
    const before = await applicationRowCount();
    const probe = health.createPostgresReadinessProbe(database.client, {
      statementTimeoutMs: 250,
    });

    await probe.assertReady();

    expect(await applicationRowCount()).toBe(before);
    const relation = await database.query<{ relation: string | null }>(
      "SELECT to_regclass('public.qhb_health_probe')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
  });

  it.each([
    [
      "hash",
      sql`UPDATE drizzle.__drizzle_migrations
          SET hash = '0'
          WHERE id = (
            SELECT id FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC
            LIMIT 1
          )`,
    ],
    [
      "created_at",
      sql`UPDATE drizzle.__drizzle_migrations
          SET created_at = created_at - 1
          WHERE id = (
            SELECT id FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC
            LIMIT 1
          )`,
    ],
  ])(
    "rejects an exact migration %s mismatch without persisting it",
    async (_field, mutation) => {
      const health = await loadHealthModule();
      const rollback = new Error("ROLLBACK_MIGRATION_FIXTURE");

      await expect(
        database.client.transaction(async (transaction) => {
          await transaction.execute(mutation);
          const probe = health.createPostgresReadinessProbe(
            transaction as typeof database.client,
            { statementTimeoutMs: 250 },
          );
          await expect(probe.assertReady()).rejects.toThrow();
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      await health
        .createPostgresReadinessProbe(database.client, {
          statementTimeoutMs: 250,
        })
        .assertReady();
    },
  );

  it("does not read or transiently mutate application tables", async () => {
    const health = await loadHealthModule();
    const before = await applicationRowCount();
    let releaseLocks = (): void => {};
    const release = new Promise<void>((resolve) => {
      releaseLocks = resolve;
    });
    let markLocked = (): void => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holder = database.client.transaction(async (transaction) => {
      await transaction.execute(sql`LOCK TABLE
        owners,
        repository_policies,
        connectors,
        jobs,
        job_events,
        approvals,
        connector_messages,
        idempotency_records
        IN ACCESS EXCLUSIVE MODE`);
      markLocked();
      await release;
    });
    await locked;
    const probe = health.createPostgresReadinessProbe(database.client, {
      statementTimeoutMs: 250,
    });

    try {
      await expect(probe.assertReady()).resolves.toBeUndefined();
    } finally {
      releaseLocks();
      await holder;
    }

    expect(await applicationRowCount()).toBe(before);
  });

  it("fails within the configured bound when migration metadata is locked", async () => {
    const health = await loadHealthModule();
    const before = await applicationRowCount();
    const statementTimeoutMs = 100;
    let releaseLock = (): void => {};
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let markLocked = (): void => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holder = database.client.transaction(async (transaction) => {
      await transaction.execute(
        sql`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`,
      );
      markLocked();
      await release;
    });
    await locked;
    const probe = health.createPostgresReadinessProbe(database.client, {
      statementTimeoutMs,
    });
    const startedAt = performance.now();

    try {
      await expect(probe.assertReady()).rejects.toThrow();
      expect(performance.now() - startedAt).toBeLessThan(
        statementTimeoutMs * 10,
      );
    } finally {
      releaseLock();
      await holder;
    }

    expect(await applicationRowCount()).toBe(before);
    const relation = await database.query<{ relation: string | null }>(
      "SELECT to_regclass('public.qhb_health_probe')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
  });
});
