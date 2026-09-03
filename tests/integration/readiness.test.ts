import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

type ReadinessTransactionContext = Readonly<{
  backendPid: number;
  readMigrationMetadata(): Promise<ExpectedMigration>;
  writeProbeSentinel(sentinel: string): Promise<void>;
  readProbeSentinel(): Promise<string>;
}>;

type ReadinessTransactionPort = Readonly<{
  withTransaction(
    callback: (context: ReadinessTransactionContext) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}>;

type ReadinessTransactionOptions = Readonly<{
  deadlineMs: number;
}>;

const READINESS_PROBE_SENTINEL = "qhb_health_probe";

type FakeReadinessTransaction = Readonly<{
  port: ReadinessTransactionPort;
  backendPid: number;
  events: string[];
  identities: number[];
  writtenSentinel: { value: string | undefined };
  abortObserved: { value: boolean };
  withTransaction: ReturnType<typeof vi.fn>;
}>;

const createFakeReadinessTransaction = (
  options: Readonly<{
    migration?: ExpectedMigration;
    readSentinel?: string;
    writeError?: Error;
    readError?: Error;
    hangOnWrite?: boolean;
    hangOnRead?: boolean;
  }> = {},
): FakeReadinessTransaction => {
  const backendPid = 7001;
  const events: string[] = [];
  const identities: number[] = [];
  const writtenSentinel = { value: undefined as string | undefined };
  const abortObserved = { value: false };
  let transactionSignal: AbortSignal | undefined;
  const abortableHang = (): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        abortObserved.value = true;
        reject(new Error("READINESS_ABORTED"));
      };
      transactionSignal?.addEventListener("abort", onAbort, { once: true });
    });
  const context: ReadinessTransactionContext = {
    backendPid,
    async readMigrationMetadata() {
      events.push("read-migration-metadata");
      identities.push(backendPid);
      return (
        options.migration ?? {
          tag: "0002_result_acknowledgement",
          createdAt: 1788244364352,
          hash: "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
        }
      );
    },
    async writeProbeSentinel(value) {
      events.push("write-probe-sentinel");
      identities.push(backendPid);
      if (options.writeError !== undefined) {
        throw options.writeError;
      }
      if (options.hangOnWrite) {
        await abortableHang();
      }
      writtenSentinel.value = value;
    },
    async readProbeSentinel() {
      events.push("read-probe-sentinel");
      identities.push(backendPid);
      if (options.hangOnRead) {
        return abortableHang();
      }
      if (options.readError !== undefined) {
        throw options.readError;
      }
      return options.readSentinel ?? writtenSentinel.value ?? "";
    },
  };
  const withTransaction = vi.fn<ReadinessTransactionPort["withTransaction"]>(
    async (callback, signal) => {
      transactionSignal = signal;
      events.push("begin");
      try {
        await callback(context);
        events.push("commit");
      } catch (error) {
        events.push("rollback");
        throw error;
      } finally {
        events.push("cleanup");
        transactionSignal = undefined;
      }
    },
  );

  return {
    port: { withTransaction },
    backendPid,
    events,
    identities,
    writtenSentinel,
    abortObserved,
    withTransaction,
  };
};

type HealthModule = Readonly<{
  EXPECTED_MIGRATION: ExpectedMigration;
  assertReadinessTransaction(
    port: ReadinessTransactionPort,
    options?: ReadinessTransactionOptions,
  ): Promise<void>;
  createPostgresReadinessTransactionPort(
    database: typeof database.client,
    options: { statementTimeoutMs: number },
  ): ReadinessTransactionPort;
  createPostgresReadinessProbe(
    database: typeof database.client,
    options?: { statementTimeoutMs: number; deadlineMs?: number },
  ): ReadinessProbe;
}>;

const loadHealthModule = async (): Promise<HealthModule> =>
  (await import("../../apps/control-plane/src/http/health.js")) as HealthModule;

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
  it("begins one transaction and uses one context identity in contract order", async () => {
    const health = await loadHealthModule();
    const fake = createFakeReadinessTransaction();

    await expect(
      health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
    ).resolves.toBeUndefined();

    expect(fake.withTransaction).toHaveBeenCalledTimes(1);
    expect(fake.events).toEqual([
      "begin",
      "read-migration-metadata",
      "write-probe-sentinel",
      "read-probe-sentinel",
      "commit",
      "cleanup",
    ]);
    expect(fake.identities).toEqual([
      fake.backendPid,
      fake.backendPid,
      fake.backendPid,
    ]);
    expect(fake.writtenSentinel.value).toBe(READINESS_PROBE_SENTINEL);
  });

  it("rejects a wrong migration tag before the temporary write/read", async () => {
    const health = await loadHealthModule();
    const fake = createFakeReadinessTransaction({
      migration: {
        tag: "0001_initial",
        createdAt: 1788244364352,
        hash: "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
      },
    });

    await expect(
      health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
    ).rejects.toThrow();

    expect(fake.events).toEqual([
      "begin",
      "read-migration-metadata",
      "rollback",
      "cleanup",
    ]);
    expect(fake.identities).toEqual([fake.backendPid]);
  });

  it.each([
    ["createdAt", { createdAt: 1788244364351 }],
    ["hash", { hash: "0" }],
  ] as const)(
    "rejects a wrong migration %s before the temporary write/read",
    async (_field, mismatch) => {
      const health = await loadHealthModule();
      const fake = createFakeReadinessTransaction({
        migration: {
          tag: "0002_result_acknowledgement",
          createdAt: 1788244364352,
          hash: "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
          ...mismatch,
        },
      });

      await expect(
        health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
      ).rejects.toThrow();

      expect(fake.events).toEqual([
        "begin",
        "read-migration-metadata",
        "rollback",
        "cleanup",
      ]);
      expect(fake.identities).toEqual([fake.backendPid]);
    },
  );

  it("rejects when the temporary write/read returns the wrong sentinel", async () => {
    const health = await loadHealthModule();
    const fake = createFakeReadinessTransaction({
      readSentinel: "wrong-sentinel",
    });

    await expect(
      health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
    ).rejects.toThrow();

    expect(fake.events).toEqual([
      "begin",
      "read-migration-metadata",
      "write-probe-sentinel",
      "read-probe-sentinel",
      "rollback",
      "cleanup",
    ]);
    expect(fake.identities).toEqual([
      fake.backendPid,
      fake.backendPid,
      fake.backendPid,
    ]);
  });

  it("rolls back and cleans up when the temporary write throws", async () => {
    const health = await loadHealthModule();
    const fake = createFakeReadinessTransaction({
      writeError: new Error("READINESS_WRITE_FAILURE"),
    });

    await expect(
      health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
    ).rejects.toThrow("READINESS_WRITE_FAILURE");

    expect(fake.events).toEqual([
      "begin",
      "read-migration-metadata",
      "write-probe-sentinel",
      "rollback",
      "cleanup",
    ]);
    expect(fake.identities).toEqual([fake.backendPid, fake.backendPid]);
  });

  it("rolls back and cleans up when the temporary read throws", async () => {
    const health = await loadHealthModule();
    const fake = createFakeReadinessTransaction({
      readError: new Error("READINESS_READ_FAILURE"),
    });

    await expect(
      health.assertReadinessTransaction(fake.port, { deadlineMs: 250 }),
    ).rejects.toThrow("READINESS_READ_FAILURE");

    expect(fake.events).toEqual([
      "begin",
      "read-migration-metadata",
      "write-probe-sentinel",
      "read-probe-sentinel",
      "rollback",
      "cleanup",
    ]);
    expect(fake.identities).toEqual([
      fake.backendPid,
      fake.backendPid,
      fake.backendPid,
    ]);
  });

  it.each([
    [
      "write",
      { hangOnWrite: true },
      [
        "begin",
        "read-migration-metadata",
        "write-probe-sentinel",
        "rollback",
        "cleanup",
      ],
    ],
    [
      "read",
      { hangOnRead: true },
      [
        "begin",
        "read-migration-metadata",
        "write-probe-sentinel",
        "read-probe-sentinel",
        "rollback",
        "cleanup",
      ],
    ],
  ] as const)(
    "enforces a complete-operation deadline for a hanging sentinel %s phase",
    async (_phase, options, expectedEvents) => {
      vi.useFakeTimers();
      try {
        const health = await loadHealthModule();
        const fake = createFakeReadinessTransaction(options);
        const deadlineMs = 40;
        const pending = health.assertReadinessTransaction(fake.port, {
          deadlineMs,
        });
        const outcome = pending.then(
          () => "resolved" as const,
          () => "rejected" as const,
        );

        await vi.advanceTimersByTimeAsync(deadlineMs);
        await expect(outcome).resolves.toBe("rejected");
        expect(fake.events).toEqual(expectedEvents);
        expect(fake.identities).toEqual(
          expectedEvents
            .filter((event) =>
              [
                "read-migration-metadata",
                "write-probe-sentinel",
                "read-probe-sentinel",
              ].includes(event),
            )
            .map(() => fake.backendPid),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels a timed-out transaction and waits for cleanup before settling", async () => {
    vi.useFakeTimers();
    try {
      const health = await loadHealthModule();
      const fake = createFakeReadinessTransaction({ hangOnWrite: true });
      const pending = health.assertReadinessTransaction(fake.port, {
        deadlineMs: 40,
      });
      const observed = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(40);
      await expect(observed).resolves.toMatchObject({
        message: "Readiness probe deadline exceeded",
      });
      expect(fake.abortObserved.value).toBe(true);
      expect(fake.events.at(-2)).toBe("rollback");
      expect(fake.events.at(-1)).toBe("cleanup");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PostgreSQL readiness probe", () => {
  it("uses the real PostgreSQL transaction context for metadata and sentinel identity", async () => {
    const health = await loadHealthModule();
    const before = await applicationRowCount();
    const port = health.createPostgresReadinessTransactionPort(
      database.client,
      {
        statementTimeoutMs: 250,
      },
    );
    const operations: Array<Readonly<{ name: string; backendPid: number }>> =
      [];

    await port.withTransaction(async (context) => {
      expect(Number.isInteger(context.backendPid)).toBe(true);
      operations.push({ name: "transaction", backendPid: context.backendPid });
      const migration = await context.readMigrationMetadata();
      operations.push({ name: "migration", backendPid: context.backendPid });
      expect(migration).toEqual(health.EXPECTED_MIGRATION);
      await context.writeProbeSentinel(READINESS_PROBE_SENTINEL);
      operations.push({ name: "write", backendPid: context.backendPid });
      await expect(context.readProbeSentinel()).resolves.toBe(
        READINESS_PROBE_SENTINEL,
      );
      operations.push({ name: "read", backendPid: context.backendPid });
    });

    expect(operations.map((operation) => operation.name)).toEqual([
      "transaction",
      "migration",
      "write",
      "read",
    ]);
    expect(
      new Set(operations.map((operation) => operation.backendPid)).size,
    ).toBe(1);
    expect(await applicationRowCount()).toBe(before);
    const relation = await database.query<{ relation: string | null }>(
      "SELECT to_regclass('public.qhb_health_probe')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
  });

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
      ).rejects.toThrow("ROLLBACK_MIGRATION_FIXTURE");

      await health
        .createPostgresReadinessProbe(database.client, {
          statementTimeoutMs: 250,
        })
        .assertReady();
    },
  );

  it("rejects a newer migration row inside a rolled-back transaction", async () => {
    const health = await loadHealthModule();
    const rollback = new Error("ROLLBACK_NEWER_MIGRATION_FIXTURE");

    await expect(
      database.client.transaction(async (transaction) => {
        await transaction.execute(sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES ('synthetic-newer-migration', ${health.EXPECTED_MIGRATION.createdAt + 1})
        `);
        const probe = health.createPostgresReadinessProbe(
          transaction as typeof database.client,
          { statementTimeoutMs: 250 },
        );
        await expect(probe.assertReady()).rejects.toThrow();
        throw rollback;
      }),
    ).rejects.toThrow("ROLLBACK_NEWER_MIGRATION_FIXTURE");

    const syntheticRow = await database.query<{ row_count: string }>(
      `SELECT count(*)::text AS row_count
       FROM drizzle.__drizzle_migrations
       WHERE hash = 'synthetic-newer-migration'`,
    );
    expect(Number(syntheticRow.rows[0]?.row_count ?? "0")).toBe(0);
    await health
      .createPostgresReadinessProbe(database.client, {
        statementTimeoutMs: 250,
      })
      .assertReady();
  });

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
      deadlineMs: statementTimeoutMs * 50,
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
