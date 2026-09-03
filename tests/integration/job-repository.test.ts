import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql as drizzleSql } from "../../apps/control-plane/node_modules/drizzle-orm";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import {
  Aes256GcmEncryptor,
  JobCoordinator,
} from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import { createTestDatabase, type TestDatabase } from "./support/postgres.js";

const db = createTestDatabase();

const SHA256_A = `sha256:${"a".repeat(64)}`;
const SHA256_B = `sha256:${"b".repeat(64)}`;
const FIXTURE_NAMESPACE = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const DEFAULT_OWNER_ID = `integration-owner-${FIXTURE_NAMESPACE}`;
const DEFAULT_REPOSITORY_ID = `novelty-studio-${FIXTURE_NAMESPACE}`;

type CreateInput = {
  ownerId: string;
  clientRequestId: string;
  repositoryId: string;
  requestCiphertext: string;
  requestDigest: string;
};

type ApprovalFixture = {
  approvalId: string;
  jobId: string;
  ownerId: string;
  jobRevision: number;
  expiresAt: Date;
  actionFingerprint: string;
};

const createInput = (overrides: Partial<CreateInput> = {}): CreateInput => ({
  ownerId: DEFAULT_OWNER_ID,
  clientRequestId: crypto.randomUUID(),
  repositoryId: DEFAULT_REPOSITORY_ID,
  requestCiphertext: `ciphertext:v1:${crypto.randomUUID()}`,
  requestDigest: SHA256_A,
  ...overrides,
});

const seedJobDependencies = async (
  database: TestDatabase,
  input: Pick<CreateInput, "ownerId" | "repositoryId">,
): Promise<void> => {
  await database.query(
    `
      INSERT INTO owners (id, display_name)
      VALUES ($1, 'integration test owner')
      ON CONFLICT (id) DO NOTHING
    `,
    [input.ownerId],
  );
  await database.query(
    `
      INSERT INTO repository_policies
        (id, owner_id, display_name, canonical_path, allowed_action_classes)
      VALUES ($1, $2, $1, '/tmp/qhb-integration-repository',
        '["automatic", "approval_required"]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [input.repositoryId, input.ownerId],
  );
};

const seedConnector = async (
  database: TestDatabase,
  connectorId: string,
  ownerId: string,
): Promise<void> => {
  await database.query(
    `
      INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
      VALUES ($1, $2, $3, 'integration-test-hash')
      ON CONFLICT (id) DO NOTHING
    `,
    [connectorId, ownerId, connectorId],
  );
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForRowLockWaiter = async (timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%"jobs"%'
          AND query ILIKE '%for update%'`,
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for a PostgreSQL row lock waiter");
};

const expiryAfter = async (milliseconds: number): Promise<Date> => {
  const result = await db.query<{ expires_at: Date }>(
    `SELECT clock_timestamp() + interval '${milliseconds} milliseconds' AS expires_at`,
  );
  const expiresAt = result.rows[0]?.expires_at;
  if (expiresAt === undefined) throw new Error("expected a database expiry");
  return expiresAt;
};

const holdJobRowUntil = (
  jobId: string,
  expiresAt: Date,
): {
  ready: Promise<void>;
  releaseToExpiry: () => void;
  done: Promise<void>;
} => {
  let signalReady!: () => void;
  let releaseToExpiry!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const waitForExpiry = new Promise<void>((resolve) => {
    releaseToExpiry = resolve;
  });
  const done = db.client.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`,
    );
    signalReady();
    await waitForExpiry;
    await tx.execute(
      drizzleSql`SELECT pg_sleep_until(${expiresAt}::timestamptz + interval '25 milliseconds')`,
    );
  });
  return { ready, releaseToExpiry, done };
};

const createJob = async (
  repository: JobRepository,
  overrides: Partial<CreateInput> = {},
) => {
  const input = createInput(overrides);
  await seedJobDependencies(db, input);
  return repository.createIdempotent(input);
};

const event = (type: string, payload: Record<string, unknown> = {}) => ({
  type,
  payload,
});

const expectCode = async (
  operation: Promise<unknown>,
  code: string,
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
};

type ProductionMcpConnection = {
  client: Client;
  server: ReturnType<typeof createMcpServer>;
};

const connectProductionMcp = async (
  repository: JobRepository,
  ownerId: string,
): Promise<ProductionMcpConnection> => {
  const coordinator = new JobCoordinator({
    repository,
    encryptor: new Aes256GcmEncryptor(new Uint8Array(32).fill(7)),
    now: () => new Date(),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ coordinator, ownerId });
  const client = new Client({
    name: "qhb-postgres-integration-client",
    version: "1.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const closeProductionMcp = async (
  connection: ProductionMcpConnection,
): Promise<void> => {
  await connection.client.close();
  await connection.server.close();
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const insertApproval = async (
  database: TestDatabase,
  fixture: ApprovalFixture,
): Promise<void> => {
  const columns = await database.query<{
    column_name: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>(
    `
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'approvals'
      ORDER BY ordinal_position
    `,
  );

  const values: Record<string, unknown> = {
    id: fixture.approvalId,
    approval_id: fixture.approvalId,
    job_id: fixture.jobId,
    owner_id: fixture.ownerId,
    action_summary: "Install the approved dependency",
    impact_summary: "Changes the repository dependency lockfile",
    action_fingerprint: fixture.actionFingerprint,
    fingerprint: fixture.actionFingerprint,
    risk_class: "approval_required",
    job_revision: fixture.jobRevision,
    attempt: 1,
    expires_at: fixture.expiresAt,
    decision: null,
    decided_at: null,
    decision_at: null,
  };
  const knownColumns = columns.rows.filter((column) =>
    Object.hasOwn(values, column.column_name),
  );
  const missingRequiredColumns = columns.rows
    .filter(
      (column) =>
        column.is_nullable === "NO" &&
        column.column_default === null &&
        !Object.hasOwn(values, column.column_name),
    )
    .map((column) => column.column_name);
  if (missingRequiredColumns.length > 0) {
    throw new Error(
      `Approval fixture does not know required schema columns: ${missingRequiredColumns.join(", ")}`,
    );
  }

  const columnList = knownColumns
    .map((column) => quoteIdentifier(column.column_name))
    .join(", ");
  const parameters = knownColumns.map((_, index) => `$${index + 1}`).join(", ");
  await database.query(
    `INSERT INTO ${quoteIdentifier("approvals")} (${columnList}) VALUES (${parameters})`,
    knownColumns.map((column) => values[column.column_name]),
  );
};

const prepareApproval = async (
  repository: JobRepository,
  database: TestDatabase,
  expiresAt: Date,
  overrides: Partial<CreateInput> = {},
): Promise<{
  job: Awaited<ReturnType<JobRepository["transitionAndAppend"]>>;
  fixture: ApprovalFixture;
}> => {
  const job = await createJob(repository, overrides);
  if (job === null) {
    throw new Error("createIdempotent unexpectedly returned no job");
  }
  const dispatched = await repository.transitionAndAppend(
    job.jobId,
    job.revision,
    "dispatched",
    event("job.dispatched"),
  );
  const running = await repository.transitionAndAppend(
    dispatched.jobId,
    dispatched.revision,
    "running",
    event("job.running", { stage: "executing" }),
  );
  const approvalId = crypto.randomUUID();
  const waiting = await repository.transitionAndAppend(
    running.jobId,
    running.revision,
    "waiting_approval",
    event("approval.requested", {
      approval_id: approvalId,
      action_fingerprint: SHA256_A,
      job_revision: running.revision + 1,
    }),
  );
  await database.query("UPDATE jobs SET attempt = 1 WHERE id = $1", [
    waiting.jobId,
  ]);
  const fixture: ApprovalFixture = {
    approvalId,
    jobId: waiting.jobId,
    ownerId: waiting.ownerId,
    jobRevision: waiting.revision,
    expiresAt,
    actionFingerprint: SHA256_A,
  };
  await insertApproval(database, fixture);
  return { job: waiting, fixture };
};

beforeAll(async () => {
  await db.start();
});

afterAll(async () => {
  await db.stop();
});

describe("JobRepository schema", () => {
  it("creates every required table and preserves encrypted-request boundaries", async () => {
    const tableRows = await db.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `,
    );
    const tableNames = new Set(tableRows.rows.map((row) => row.table_name));
    for (const tableName of [
      "owners",
      "connectors",
      "repository_policies",
      "jobs",
      "job_events",
      "approvals",
      "idempotency_records",
      "connector_messages",
    ]) {
      expect(tableNames.has(tableName), `missing table ${tableName}`).toBe(
        true,
      );
    }

    const jobColumns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(
      `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'jobs'
      `,
    );
    const byName = new Map(
      jobColumns.rows.map((column) => [column.column_name, column]),
    );
    expect(byName.has("request_ciphertext")).toBe(true);
    expect(byName.has("request_digest")).toBe(true);
    expect(byName.has("request")).toBe(false);
    expect(byName.has("expires_at")).toBe(true);
    expect(byName.has("request_delete_at")).toBe(true);
    expect(byName.has("retention_delete_at")).toBe(true);
    expect(byName.has("acknowledged_at")).toBe(true);

    const revision = byName.get("revision");
    expect(revision).toMatchObject({
      data_type: "integer",
      is_nullable: "NO",
    });
    expect(revision?.column_default ?? "").toMatch(/(?:^|\D)0(?:\D|$)/);

    const enumValues = await db.query<{ enumlabel: string }>(
      `
        SELECT enumlabel
        FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
        WHERE pg_namespace.nspname = 'public' AND pg_type.typname = 'job_status'
        ORDER BY enumsortorder
      `,
    );
    expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
      "queued",
      "dispatched",
      "running",
      "waiting_approval",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ]);
  });

  it("enforces the three required composite uniqueness constraints", async () => {
    const uniqueIndexes = await db.query<{
      table_name: string;
      columns: string[];
    }>(
      `
        SELECT
          relation.relname AS table_name,
          array_agg(attribute.attname ORDER BY key.ordinality) AS columns
        FROM pg_index AS index
        JOIN pg_class AS relation ON relation.oid = index.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY($1::text[])
          AND index.indisunique
        GROUP BY relation.relname, index.indexrelid
      `,
      [["idempotency_records", "job_events", "connector_messages"]],
    );
    const hasUnique = (tableName: string, columns: string[]): boolean =>
      uniqueIndexes.rows.some(
        (index) =>
          index.table_name === tableName &&
          index.columns.join(",") === columns.join(","),
      );

    expect(
      hasUnique("idempotency_records", ["owner_id", "client_request_id"]),
    ).toBe(true);
    expect(hasUnique("job_events", ["job_id", "sequence"])).toBe(true);
    expect(
      hasUnique("connector_messages", [
        "connector_id",
        "direction",
        "sequence",
      ]),
    ).toBe(true);
  });

  it("rejects a job whose owner does not own the repository policy", async () => {
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const repositoryOwnerId = `owner-${crypto.randomUUID()}`;
    const jobOwnerId = `owner-${crypto.randomUUID()}`;
    await seedJobDependencies(db, {
      ownerId: repositoryOwnerId,
      repositoryId,
    });
    await db.query(
      "INSERT INTO owners (id, display_name) VALUES ($1, 'job owner')",
      [jobOwnerId],
    );

    await expect(
      db.query(
        `
          INSERT INTO jobs (short_id, owner_id, repository_id, request_digest)
          VALUES ($1, $2, $3, $4)
        `,
        [
          `QH-${crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`,
          jobOwnerId,
          repositoryId,
          SHA256_A,
        ],
      ),
    ).rejects.toThrow();
  });
});

describe("JobRepository idempotency and reads", () => {
  it("creates short IDs from the four-character Crockford Base32 alphabet", async () => {
    const repository = new JobRepository(db.client);
    const shortIds: string[] = [];

    for (let index = 0; index < 32; index += 1) {
      shortIds.push((await createJob(repository)).shortId);
    }

    expect(
      shortIds.every((shortId) =>
        /^QH-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(shortId),
      ),
    ).toBe(true);
    expect(
      shortIds.some((shortId) =>
        /[GHJKMNPQRSTVWXYZ]/.test(shortId.slice("QH-".length)),
      ),
    ).toBe(true);
  });

  it("returns the original job for a repeated equal digest", async () => {
    const repository = new JobRepository(db.client);
    const input = createInput();
    await seedJobDependencies(db, input);
    const first = await repository.createIdempotent(input);
    const second = await repository.createIdempotent({
      ...input,
      requestCiphertext: "ciphertext:v1:second-payload",
    });

    expect(second.jobId).toBe(first.jobId);
    const stored = await db.query<{ request_ciphertext: string }>(
      "SELECT request_ciphertext FROM jobs WHERE id = $1",
      [first.jobId],
    );
    expect(stored.rows[0]?.request_ciphertext).toBe(input.requestCiphertext);
  });

  it("rejects a repeated idempotency key with a different digest", async () => {
    const repository = new JobRepository(db.client);
    const input = createInput();
    await seedJobDependencies(db, input);
    const first = await repository.createIdempotent(input);

    await expectCode(
      repository.createIdempotent({
        ...input,
        requestDigest: SHA256_B,
      }),
      "IDEMPOTENCY_CONFLICT",
    );

    const jobs = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE id = $1",
      [first.jobId],
    );
    expect(Number(jobs.rows[0]?.count)).toBe(1);
  });

  it("preserves one job and one idempotency record under equal-digest concurrency", async () => {
    const repository = new JobRepository(db.client);
    const input = createInput();
    await seedJobDependencies(db, input);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.createIdempotent(input)),
    );

    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    const records = await db.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM idempotency_records
        WHERE owner_id = $1 AND client_request_id = $2
      `,
      [input.ownerId, input.clientRequestId],
    );
    expect(Number(records.rows[0]?.count)).toBe(1);
  });

  it("allows only one winner when concurrent calls use unequal digests", async () => {
    const repository = new JobRepository(db.client);
    const input = createInput();
    await seedJobDependencies(db, input);
    const results = await Promise.allSettled([
      repository.createIdempotent(input),
      repository.createIdempotent({ ...input, requestDigest: SHA256_B }),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<JobRepository["createIdempotent"]>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("gets a job and lists only the requested owner's jobs", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ownFirst = await createJob(repository, { ownerId, repositoryId });
    const ownSecond = await createJob(repository, { ownerId, repositoryId });
    await createJob(repository, {
      ownerId: crypto.randomUUID(),
      repositoryId: `${repositoryId}-other`,
    });

    await expect(repository.get(ownFirst.jobId)).resolves.toMatchObject({
      jobId: ownFirst.jobId,
      status: "queued",
      revision: 0,
    });
    await expect(repository.get(crypto.randomUUID())).resolves.toBeNull();

    const listed = await repository.list({ ownerId, limit: 5 });
    expect(listed.map((job) => job.jobId)).toEqual(
      expect.arrayContaining([ownFirst.jobId, ownSecond.jobId]),
    );
    expect(listed.every((job) => job.ownerId === ownerId)).toBe(true);
  });
});

describe("JobRepository transactional transitions", () => {
  it("increments revision and appends exactly one ordered event per valid transition", async () => {
    const repository = new JobRepository(db.client);
    const job = await createJob(repository);

    const dispatched = await repository.transitionAndAppend(
      job.jobId,
      0,
      "dispatched",
      event("job.dispatched"),
    );
    const running = await repository.transitionAndAppend(
      job.jobId,
      dispatched.revision,
      "running",
      event("job.running", { stage: "executing" }),
    );

    expect(dispatched).toMatchObject({ status: "dispatched", revision: 1 });
    expect(running).toMatchObject({ status: "running", revision: 2 });
    await expect(repository.events(job.jobId)).resolves.toMatchObject([
      { sequence: 1, type: "job.dispatched" },
      { sequence: 2, type: "job.running" },
    ]);
  });

  it("returns REVISION_CONFLICT without changing state or appending an event", async () => {
    const repository = new JobRepository(db.client);
    const job = await createJob(repository);
    const dispatched = await repository.transitionAndAppend(
      job.jobId,
      0,
      "dispatched",
      event("job.dispatched"),
    );
    const before = await repository.events(job.jobId);

    await expectCode(
      repository.transitionAndAppend(
        job.jobId,
        0,
        "running",
        event("job.running"),
      ),
      "REVISION_CONFLICT",
    );

    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: dispatched.status,
      revision: dispatched.revision,
    });
    await expect(repository.events(job.jobId)).resolves.toEqual(before);
  });

  it("rejects an invalid state transition before writing a revision or event", async () => {
    const repository = new JobRepository(db.client);
    const job = await createJob(repository);

    await expect(
      repository.transitionAndAppend(
        job.jobId,
        0,
        "running",
        event("job.running"),
      ),
    ).rejects.toThrow("INVALID_JOB_TRANSITION");

    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "queued",
      revision: 0,
    });
    await expect(repository.events(job.jobId)).resolves.toEqual([]);
  });

  it("serializes concurrent transitions so only one expected revision wins", async () => {
    const repository = new JobRepository(db.client);
    const job = await createJob(repository);
    const results = await Promise.allSettled([
      repository.transitionAndAppend(
        job.jobId,
        0,
        "dispatched",
        event("job.dispatched"),
      ),
      repository.transitionAndAppend(
        job.jobId,
        0,
        "cancelled",
        event("job.cancelled"),
      ),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<unknown> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      revision: 1,
    });
    await expect(repository.events(job.jobId)).resolves.toHaveLength(1);
  });
});

describe("JobRepository offer claims", () => {
  it("rejects a non-next attempt without changing a dispatched job or its events", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository);
    await seedConnector(db, connectorId, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    await db.query(
      `UPDATE jobs
          SET connector_id = $2, lease_id = $3,
              lease_expires_at = now() + interval '30 seconds'
        WHERE id = $1`,
      [job.jobId, connectorId, leaseId],
    );
    const dispatched = await repository.get(job.jobId);
    if (dispatched === null) throw new Error("expected dispatched job");
    const eventsBefore = await repository.events(job.jobId);

    await expect(
      repository.claimOffer(job.jobId, {
        connectorId,
        attempt: dispatched.attempt + 2,
        leaseId,
      }),
    ).resolves.toBeNull();

    await expect(repository.get(job.jobId)).resolves.toEqual(dispatched);
    await expect(repository.events(job.jobId)).resolves.toEqual(eventsBefore);
  });

  it("rejects a dispatched claim when the job has expired", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository);
    await seedConnector(db, connectorId, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    await db.query(
      `UPDATE jobs
          SET connector_id = $2,
              lease_id = $3,
              lease_expires_at = now() + interval '30 seconds',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [job.jobId, connectorId, leaseId],
    );

    await expect(
      repository.claimOffer(job.jobId, {
        connectorId,
        attempt: 1,
        leaseId,
      }),
    ).resolves.toBeNull();
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "dispatched",
      attempt: 0,
      revision: 1,
    });
    await expect(repository.events(job.jobId)).resolves.toMatchObject([
      { sequence: 1, type: "job.dispatched" },
    ]);
    await db.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("uses PostgreSQL time for claim expiry rather than a future-skewed process clock", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository, {
      repositoryId: `claim-clock-${crypto.randomUUID()}`,
    });
    await seedConnector(db, connectorId, job.ownerId);
    const leaseId = crypto.randomUUID();
    const expiresAt = await expiryAfter(60_000);
    await db.query(
      `UPDATE jobs
          SET connector_id = $2,
              status = 'dispatched'::job_status,
              lease_id = $3,
              lease_expires_at = $4,
              expires_at = $5
        WHERE id = $1`,
      [job.jobId, connectorId, leaseId, expiresAt, expiresAt],
    );

    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    try {
      await expect(
        repository.claimOffer(job.jobId, {
          connectorId,
          attempt: 1,
          leaseId,
        }),
      ).resolves.toMatchObject({ status: "running", attempt: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a claim that waits past the job and lease expiry", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository);
    await seedConnector(db, connectorId, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    const expiresAt = await expiryAfter(250);
    await db.query(
      `UPDATE jobs
          SET connector_id = $2,
              lease_id = $3,
              lease_expires_at = $4,
              expires_at = $4
        WHERE id = $1`,
      [job.jobId, connectorId, leaseId, expiresAt],
    );

    const holder = holdJobRowUntil(job.jobId, expiresAt);
    await holder.ready;
    const claim = repository.claimOffer(job.jobId, {
      connectorId,
      attempt: 1,
      leaseId,
    });
    try {
      await waitForRowLockWaiter();
    } finally {
      holder.releaseToExpiry();
    }
    await holder.done;

    await expect(claim).resolves.toBeNull();
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "dispatched",
      attempt: 0,
      revision: 1,
      leaseId,
    });
    await expect(repository.events(job.jobId)).resolves.toMatchObject([
      { sequence: 1, type: "job.dispatched" },
    ]);
    await db.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("bounds a running lease by the job expiry after a successful claim", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository);
    await seedConnector(db, connectorId, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    const jobExpiresAt = new Date(Date.now() + 5_000);
    await db.query(
      `UPDATE jobs
          SET connector_id = $2,
              lease_id = $3,
              lease_expires_at = now() + interval '30 seconds',
              expires_at = $4
        WHERE id = $1`,
      [job.jobId, connectorId, leaseId, jobExpiresAt],
    );

    const claimed = await repository.claimOffer(job.jobId, {
      connectorId,
      attempt: 1,
      leaseId,
    });

    expect(claimed).toMatchObject({ status: "running", attempt: 1 });
    expect(claimed?.leaseExpiresAt?.getTime()).toBeLessThanOrEqual(
      jobExpiresAt.getTime(),
    );
    expect(claimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    await db.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("allows only the exact offered connector and lease to win a concurrent claim", async () => {
    const repository = new JobRepository(db.client);
    const firstConnector = crypto.randomUUID();
    const secondConnector = crypto.randomUUID();
    const job = await createJob(repository);
    await seedConnector(db, firstConnector, job.ownerId);
    await seedConnector(db, secondConnector, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      0,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    await db.query(
      `UPDATE jobs
          SET connector_id = $2, lease_id = $3,
              lease_expires_at = now() + interval '30 seconds'
        WHERE id = $1`,
      [job.jobId, firstConnector, leaseId],
    );

    const claims = await Promise.all([
      repository.claimOffer(job.jobId, {
        connectorId: firstConnector,
        attempt: 1,
        leaseId,
      }),
      repository.claimOffer(job.jobId, {
        connectorId: secondConnector,
        attempt: 1,
        leaseId: crypto.randomUUID(),
      }),
    ]);
    const winners = claims.filter(
      (claim): claim is NonNullable<typeof claim> =>
        claim !== null && claim !== undefined,
    );

    expect(winners).toHaveLength(1);
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      revision: 2,
    });
    const stored = await repository.get(job.jobId);
    expect(stored?.connectorId).toBe(firstConnector);
  });

  it("does not allow a second claim to replace the winning attempt or lease", async () => {
    const repository = new JobRepository(db.client);
    const job = await createJob(repository);
    const firstConnector = crypto.randomUUID();
    const secondConnector = crypto.randomUUID();
    await seedConnector(db, firstConnector, job.ownerId);
    await seedConnector(db, secondConnector, job.ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const leaseId = crypto.randomUUID();
    await db.query(
      `UPDATE jobs
          SET connector_id = $2, lease_id = $3,
              lease_expires_at = now() + interval '30 seconds'
        WHERE id = $1`,
      [job.jobId, firstConnector, leaseId],
    );
    const first = await repository.claimOffer(job.jobId, {
      connectorId: firstConnector,
      attempt: 1,
      leaseId,
    });
    const second = await repository.claimOffer(job.jobId, {
      connectorId: secondConnector,
      attempt: 2,
      leaseId: crypto.randomUUID(),
    });

    expect(first).not.toBeNull();
    expect(second === null || second === undefined).toBe(true);
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      attempt: 1,
      leaseId,
      revision: 2,
    });
  });
});

describe("JobRepository approval decisions", () => {
  it("records the first valid approval decision exactly once", async () => {
    const repository = new JobRepository(db.client);
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );

    await repository.recordApprovalDecision({
      approvalId: fixture.approvalId,
      decision: "approve",
      expectedJobRevision: job.revision,
    });
    const stored = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(stored.rows[0]?.decision).toBe("approve");

    await expectCode(
      repository.recordApprovalDecision({
        approvalId: fixture.approvalId,
        decision: "reject",
        expectedJobRevision: job.revision,
      }),
      "APPROVAL_ALREADY_DECIDED",
    );
    const afterRepeat = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(afterRepeat.rows[0]?.decision).toBe("approve");
  });

  it("accepts only one winner for concurrent opposite approval decisions", async () => {
    const repository = new JobRepository(db.client);
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );
    const results = await Promise.allSettled([
      repository.recordApprovalDecision({
        approvalId: fixture.approvalId,
        decision: "approve",
        expectedJobRevision: job.revision,
      }),
      repository.recordApprovalDecision({
        approvalId: fixture.approvalId,
        decision: "reject",
        expectedJobRevision: job.revision,
      }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<unknown> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "APPROVAL_ALREADY_DECIDED",
    });

    const stored = await db.query<{ decision: "approve" | "reject" | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(["approve", "reject"]).toContain(stored.rows[0]?.decision);
  });

  it("fails closed for an expired approval without recording approval", async () => {
    const repository = new JobRepository(db.client);
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() - 1_000),
    );

    await expectCode(
      repository.recordApprovalDecision({
        approvalId: fixture.approvalId,
        decision: "approve",
        expectedJobRevision: job.revision,
      }),
      "APPROVAL_EXPIRED",
    );
    const stored = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(stored.rows[0]?.decision).not.toBe("approve");
  });

  it("rejects a decision whose expected job revision is stale", async () => {
    const repository = new JobRepository(db.client);
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );

    await expectCode(
      repository.recordApprovalDecision({
        approvalId: fixture.approvalId,
        decision: "approve",
        expectedJobRevision: job.revision - 1,
      }),
      "APPROVAL_MISMATCH",
    );
    const stored = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(stored.rows[0]?.decision).toBeNull();
  });
});

describe("JobRepository Task 4 owner-scoped reads and atomic commands", () => {
  it("reads policies and connector health only inside the authenticated owner scope", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const otherOwnerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const connectorId = crypto.randomUUID();

    await seedJobDependencies(db, { ownerId, repositoryId });
    await seedJobDependencies(db, {
      ownerId: otherOwnerId,
      repositoryId: `${repositoryId}-other`,
    });
    await seedConnector(db, connectorId, ownerId);
    await db.query(
      "UPDATE connectors SET health = 'fresh', last_heartbeat_at = now() WHERE id = $1",
      [connectorId],
    );

    await expect(
      repository.getRepositoryPolicy(ownerId, repositoryId),
    ).resolves.toMatchObject({
      id: repositoryId,
      ownerId,
      enabled: true,
    });
    await expect(
      repository.getRepositoryPolicy(otherOwnerId, repositoryId),
    ).resolves.toBeNull();
    await expect(repository.getConnectorHealth(ownerId)).resolves.toBe("fresh");
    await expect(repository.getConnectorHealth(otherOwnerId)).resolves.toBe(
      "offline",
    );
  });

  it("applies owner, unread, status, and five-item bounds to reads", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const jobs = [];
    for (let index = 0; index < 7; index += 1) {
      jobs.push(
        await createJob(repository, {
          ownerId,
          repositoryId,
          requestDigest: index % 2 === 0 ? SHA256_A : SHA256_B,
        }),
      );
    }
    await db.query(
      "UPDATE jobs SET unread_terminal = (id = ANY($1::uuid[])), status = CASE WHEN id = ANY($1::uuid[]) THEN 'succeeded'::job_status ELSE status END WHERE owner_id = $2",
      [[jobs[0]?.jobId, jobs[1]?.jobId], ownerId],
    );

    const unread = await repository.list({
      ownerId,
      unreadOnly: true,
      limit: 5,
    });
    expect(unread).toHaveLength(2);
    expect(unread.every((job) => job.ownerId === ownerId)).toBe(true);
    expect(unread.every((job) => job.unreadTerminal)).toBe(true);
    await expect(
      repository.list({ ownerId: crypto.randomUUID(), limit: 5 }),
    ).resolves.toEqual([]);
  });

  it("returns only the recent five owner-scoped events and pending approvals", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      await db.query(
        "INSERT INTO job_events (job_id, sequence, event_type, payload) VALUES ($1, $2, 'progress', $3::jsonb)",
        [job.jobId, sequence, JSON.stringify({ sequence })],
      );
    }

    const events = await repository.events(ownerId, job.jobId, 5);
    expect(events.map((item) => item.sequence)).toEqual([4, 5, 6, 7, 8]);
    const legacyEvents = await repository.events(job.jobId);
    expect(legacyEvents.map((item) => item.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    await expect(
      repository.events(crypto.randomUUID(), job.jobId, 5),
    ).resolves.toEqual([]);

    const approvalFixtures = await Promise.all(
      Array.from({ length: 6 }, () =>
        prepareApproval(repository, db, new Date(Date.now() + 5 * 60_000), {
          ownerId,
          repositoryId,
        }),
      ),
    );
    const approvalIds = approvalFixtures.map(
      ({ fixture }) => fixture.approvalId,
    );
    await insertApproval(db, {
      approvalId: crypto.randomUUID(),
      jobId: job.jobId,
      ownerId,
      jobRevision: job.revision,
      expiresAt: new Date(Date.now() - 1_000),
      actionFingerprint: SHA256_A,
    });

    const approvals = await repository.listPendingApprovals(
      ownerId,
      5,
      new Date(),
    );
    expect(approvals).toHaveLength(5);
    expect(approvals.every((approval) => approval.decision === null)).toBe(
      true,
    );
    await expect(
      repository.getPendingApproval(
        ownerId,
        approvalFixtures[5]?.job.jobId as string,
        new Date(),
      ),
    ).resolves.toMatchObject({ approvalId: approvalIds[5] });
    await expect(
      repository.listPendingApprovals(crypto.randomUUID(), 5, new Date()),
    ).resolves.toEqual([]);
  });

  it("lists pending approvals only for jobs still waiting for approval", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const valid = await prepareApproval(repository, db, expiresAt, {
      ownerId,
      repositoryId,
    });
    const cancelled = await prepareApproval(repository, db, expiresAt, {
      ownerId,
      repositoryId,
    });
    const failed = await prepareApproval(repository, db, expiresAt, {
      ownerId,
      repositoryId,
    });

    await db.query(
      "UPDATE jobs SET status = CASE WHEN id = $1 THEN 'cancelled'::job_status WHEN id = $2 THEN 'failed'::job_status ELSE status END WHERE id IN ($1, $2)",
      [cancelled.job.jobId, failed.job.jobId],
    );

    const listed = await repository.listPendingApprovals(
      ownerId,
      5,
      new Date(),
    );
    expect(listed.map((approval) => approval.approvalId)).toEqual([
      valid.fixture.approvalId,
    ]);

    await expect(
      repository.getPendingApproval(ownerId, failed.job.jobId, new Date()),
    ).resolves.toBeNull();
  });

  it("cancels queued work idempotently without creating a connector message", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });

    const first = await repository.cancelAtomically({
      ownerId,
      jobId: job.jobId,
      expectedRevision: job.revision,
    });
    const repeated = await repository.cancelAtomically({
      ownerId,
      jobId: job.jobId,
      expectedRevision: job.revision,
    });

    expect(first).toMatchObject({ status: "cancelled", revision: 1 });
    expect(repeated).toMatchObject({ status: "cancelled", revision: 1 });
    const messages = await db.query(
      "SELECT id FROM connector_messages WHERE payload->>'job_id' = $1",
      [job.jobId],
    );
    expect(messages.rows).toEqual([]);
  });

  it("moves running work to cancelling and allocates one locked server sequence", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const connectorId = crypto.randomUUID();
    const job = await createJob(repository, { ownerId, repositoryId });
    await seedConnector(db, connectorId, ownerId);
    await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const running = await repository.transitionAndAppend(
      job.jobId,
      1,
      "running",
      event("job.running"),
    );
    await db.query(
      "UPDATE jobs SET connector_id = $1, attempt = 2 WHERE id = $2",
      [connectorId, job.jobId],
    );

    const first = await repository.cancelAtomically({
      ownerId,
      jobId: job.jobId,
      expectedRevision: running.revision,
    });
    const repeated = await repository.cancelAtomically({
      ownerId,
      jobId: job.jobId,
      expectedRevision: running.revision,
    });
    expect(first).toMatchObject({ status: "cancelling", revision: 3 });
    expect(repeated).toMatchObject({ status: "cancelling", revision: 3 });

    const messages = await db.query<{
      sequence: number;
      type: string;
      payload: { job_id: string; attempt: number; job_revision: number };
    }>(
      "SELECT sequence, type, payload FROM connector_messages WHERE connector_id = $1 AND direction = 'server'",
      [connectorId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({
      sequence: "1",
      type: "job.cancel",
      payload: { job_id: job.jobId, attempt: 2, job_revision: 3 },
    });
    const connector = await db.query<{ last_server_sequence: number }>(
      "SELECT last_server_sequence FROM connectors WHERE id = $1",
      [connectorId],
    );
    expect(Number(connector.rows[0]?.last_server_sequence)).toBe(1);
  });

  it("rejects a stale active cancellation and owner mismatch without writes", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });

    await expectCode(
      repository.cancelAtomically({
        ownerId,
        jobId: job.jobId,
        expectedRevision: job.revision + 1,
      }),
      "REVISION_CONFLICT",
    );
    await expectCode(
      repository.cancelAtomically({
        ownerId: crypto.randomUUID(),
        jobId: job.jobId,
        expectedRevision: job.revision,
      }),
      "NOT_FOUND",
    );
    await expect(repository.get(ownerId, job.jobId)).resolves.toMatchObject({
      status: "queued",
      revision: 0,
    });
  });

  it("commits the first owner-scoped approval decision and its outbox command together", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );
    await seedConnector(db, connectorId, job.ownerId);
    await db.query(
      "UPDATE jobs SET connector_id = $1, attempt = $2 WHERE id = $3",
      [connectorId, 1, job.jobId],
    );

    const first = await repository.recordApprovalDecision({
      ownerId: job.ownerId,
      approvalId: fixture.approvalId,
      decision: "approve",
      expectedJobRevision: fixture.jobRevision,
      actionFingerprint: fixture.actionFingerprint,
    });
    expect(first).toMatchObject({
      approvalId: fixture.approvalId,
      decision: "approve",
    });
    await expectCode(
      repository.recordApprovalDecision({
        ownerId: job.ownerId,
        approvalId: fixture.approvalId,
        decision: "reject",
        expectedJobRevision: fixture.jobRevision,
        actionFingerprint: fixture.actionFingerprint,
      }),
      "APPROVAL_MISMATCH",
    );
    const messages = await db.query<{
      sequence: number;
      type: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT sequence, type, payload FROM connector_messages WHERE connector_id = $1 AND direction = 'server'",
      [connectorId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({
      sequence: "1",
      type: "approval.decision",
      payload: {
        approval_id: fixture.approvalId,
        job_id: fixture.jobId,
        attempt: 1,
        job_revision: fixture.jobRevision,
        action_fingerprint: fixture.actionFingerprint,
        decision: "approve",
      },
    });
  });

  it("returns an exact owner-scoped approval retry without a second outbox command", async () => {
    const repository = new JobRepository(db.client);
    const connectorId = crypto.randomUUID();
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );
    await seedConnector(db, connectorId, job.ownerId);
    await db.query(
      "UPDATE jobs SET connector_id = $1, attempt = $2 WHERE id = $3",
      [connectorId, 1, job.jobId],
    );

    const input = {
      ownerId: job.ownerId,
      approvalId: fixture.approvalId,
      decision: "approve" as const,
      expectedJobRevision: fixture.jobRevision,
      actionFingerprint: fixture.actionFingerprint,
    };
    const [first, repeated] = await Promise.all([
      repository.recordApprovalDecision(input),
      repository.recordApprovalDecision(input),
    ]);

    expect(repeated).toMatchObject({
      approvalId: first.approvalId,
      decision: first.decision,
      actionFingerprint: fixture.actionFingerprint,
    });
    await expectCode(
      repository.recordApprovalDecision({
        ...input,
        actionFingerprint: SHA256_B,
      }),
      "APPROVAL_MISMATCH",
    );
    await expectCode(
      repository.recordApprovalDecision({
        ...input,
        expectedJobRevision: input.expectedJobRevision + 1,
      }),
      "APPROVAL_MISMATCH",
    );
    const messages = await db.query(
      "SELECT id FROM connector_messages WHERE connector_id = $1 AND direction = 'server'",
      [connectorId],
    );
    expect(messages.rows).toHaveLength(1);
  });

  it("rolls back an approval update when the required connector outbox cannot be written", async () => {
    const repository = new JobRepository(db.client);
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
    );
    await db.query("UPDATE jobs SET attempt = $1 WHERE id = $2", [
      1,
      job.jobId,
    ]);

    await expectCode(
      repository.recordApprovalDecision({
        ownerId: job.ownerId,
        approvalId: fixture.approvalId,
        decision: "approve",
        expectedJobRevision: fixture.jobRevision,
        actionFingerprint: fixture.actionFingerprint,
      }),
      "CONNECTOR_OWNER_MISMATCH",
    );
    const stored = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [fixture.approvalId],
    );
    expect(stored.rows[0]?.decision).toBeNull();
  });

  it("acknowledges a terminal result once and returns the persisted timestamp on retry", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });
    await db.query(
      "UPDATE jobs SET status = 'succeeded', terminal_at = now(), unread_terminal = true, summary = $1::jsonb WHERE id = $2",
      [
        JSON.stringify({
          summary: "All checks passed",
          changed_files: ["src/index.ts"],
          tests: { passed: 8, failed: 0, summary: "8 passed" },
          artifacts: [],
        }),
        job.jobId,
      ],
    );

    const first = await repository.acknowledgeResult(ownerId, job.jobId);
    const second = await repository.acknowledgeResult(ownerId, job.jobId);
    expect(first?.acknowledgedAt).toBeInstanceOf(Date);
    expect(second?.acknowledgedAt?.getTime()).toBe(
      first?.acknowledgedAt?.getTime(),
    );
    expect(second?.summary).toBe("All checks passed");
    const stored = await db.query<{
      acknowledged_at: string;
      unread_terminal: boolean;
    }>("SELECT acknowledged_at, unread_terminal FROM jobs WHERE id = $1", [
      job.jobId,
    ]);
    expect(stored.rows[0]?.acknowledged_at).toBeTruthy();
    expect(stored.rows[0]?.unread_terminal).toBe(false);
    await expect(
      repository.acknowledgeResult(crypto.randomUUID(), job.jobId),
    ).resolves.toBeNull();

    const missingResult = await createJob(repository, {
      ownerId,
      repositoryId,
    });
    await db.query(
      "UPDATE jobs SET status = 'failed', terminal_at = now(), unread_terminal = true WHERE id = $1",
      [missingResult.jobId],
    );
    await expect(
      repository.acknowledgeResult(ownerId, missingResult.jobId),
    ).resolves.toBeNull();
    const unacknowledged = await db.query<{
      acknowledged_at: string | null;
      unread_terminal: boolean;
    }>("SELECT acknowledged_at, unread_terminal FROM jobs WHERE id = $1", [
      missingResult.jobId,
    ]);
    expect(unacknowledged.rows[0]).toEqual({
      acknowledged_at: null,
      unread_terminal: true,
    });
  });

  it("submits through the real coordinator and PostgreSQL seam within two seconds", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await seedJobDependencies(db, { ownerId, repositoryId });
    const coordinator = new JobCoordinator({
      repository,
      encryptor: new Aes256GcmEncryptor(new Uint8Array(32).fill(7)),
      now: () => new Date(),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ coordinator, ownerId });
    const client = new Client({
      name: "qhb-postgres-timing-client",
      version: "1.0.0",
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = performance.now();
      const result = await client.callTool({
        name: "submit_task",
        arguments: {
          client_request_id: crypto.randomUUID(),
          repository_id: repositoryId,
          request: "Run the PostgreSQL integration checks",
          mode: "normal",
        },
      });

      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "queued",
        connector_status: "offline",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists and gets only the authenticated owner's jobs through production MCP", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const ownerRepositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const otherOwnerId = crypto.randomUUID();
    const otherRepositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ownJob = await createJob(repository, {
      ownerId,
      repositoryId: ownerRepositoryId,
    });
    const otherJob = await createJob(repository, {
      ownerId: otherOwnerId,
      repositoryId: otherRepositoryId,
    });
    const connection = await connectProductionMcp(repository, ownerId);

    try {
      const listed = await connection.client.callTool({
        name: "list_tasks",
        arguments: { limit: 5, unread_only: false },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        tasks: [
          {
            short_id: ownJob.shortId,
            status: "queued",
            freshness: "offline",
          },
        ],
      });
      expect(JSON.stringify(listed.structuredContent)).not.toContain(
        otherJob.shortId,
      );

      const detail = await connection.client.callTool({
        name: "get_task",
        arguments: { job_id: ownJob.jobId },
      });
      expect(detail.isError).not.toBe(true);
      expect(detail.structuredContent).toMatchObject({
        job_id: ownJob.jobId,
        repository: ownerRepositoryId,
        status: "queued",
        current_stage: "queued",
        revision: 0,
        recent_events: [],
        pending_approval: null,
        terminal_summary: null,
      });
      expect(Object.keys(detail.structuredContent as object).sort()).toEqual([
        "current_stage",
        "freshness",
        "job_id",
        "pending_approval",
        "recent_events",
        "repository",
        "revision",
        "status",
        "terminal_summary",
        "text",
        "title",
      ]);

      const otherDetail = await connection.client.callTool({
        name: "get_task",
        arguments: { job_id: otherJob.jobId },
      });
      expect(otherDetail.isError).toBe(true);
      expect(otherDetail.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_FOUND" },
      });
    } finally {
      await closeProductionMcp(connection);
    }
  });

  it("cancels through production MCP and persists the terminal job state", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });
    const connection = await connectProductionMcp(repository, ownerId);

    try {
      const cancelled = await connection.client.callTool({
        name: "cancel_task",
        arguments: { job_id: job.jobId, expected_revision: 0 },
      });
      expect(cancelled.isError).not.toBe(true);
      expect(cancelled.structuredContent).toEqual({
        job_id: job.jobId,
        status: "cancelled",
        revision: 1,
      });

      const repeated = await connection.client.callTool({
        name: "cancel_task",
        arguments: { job_id: job.jobId, expected_revision: 0 },
      });
      expect(repeated.isError).not.toBe(true);
      expect(repeated.structuredContent).toEqual(cancelled.structuredContent);

      const stored = await db.query<{
        status: string;
        revision: number;
        terminal_at: string | null;
        unread_terminal: boolean;
      }>(
        "SELECT status, revision, terminal_at, unread_terminal FROM jobs WHERE id = $1",
        [job.jobId],
      );
      expect(stored.rows[0]).toMatchObject({
        status: "cancelled",
        revision: 1,
        unread_terminal: true,
      });
      expect(stored.rows[0]?.terminal_at).toBeTruthy();
    } finally {
      await closeProductionMcp(connection);
    }
  });

  it("lists pending approvals through production MCP with owner isolation and bounds", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    for (let index = 0; index < 6; index += 1) {
      await prepareApproval(repository, db, expiresAt, {
        ownerId,
        repositoryId,
      });
    }
    const connection = await connectProductionMcp(repository, ownerId);
    const otherConnection = await connectProductionMcp(
      repository,
      crypto.randomUUID(),
    );

    try {
      const listed = await connection.client.callTool({
        name: "list_pending_approvals",
        arguments: { limit: 5 },
      });
      expect(listed.isError).not.toBe(true);
      const content = listed.structuredContent as {
        approvals: Array<Record<string, unknown>>;
      };
      expect(content.approvals).toHaveLength(5);
      for (const approval of content.approvals) {
        expect(Object.keys(approval).sort()).toEqual([
          "action_summary",
          "approval_id",
          "expires_at",
          "impact_summary",
          "job_id",
          "job_revision",
          "job_short_id",
          "risk_class",
        ]);
        expect(String(approval.action_summary).length).toBeLessThanOrEqual(600);
        expect(String(approval.impact_summary).length).toBeLessThanOrEqual(600);
        expect(String(approval.job_short_id).length).toBeLessThanOrEqual(7);
      }

      const otherOwner = await otherConnection.client.callTool({
        name: "list_pending_approvals",
        arguments: { limit: 5 },
      });
      expect(otherOwner.isError).not.toBe(true);
      expect(otherOwner.structuredContent).toEqual({ approvals: [] });
    } finally {
      await closeProductionMcp(otherConnection);
      await closeProductionMcp(connection);
    }
  });

  it("decides an approval through production MCP with one persisted outbox effect", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const connectorId = crypto.randomUUID();
    const { job, fixture } = await prepareApproval(
      repository,
      db,
      new Date(Date.now() + 5 * 60_000),
      { ownerId, repositoryId },
    );
    await seedConnector(db, connectorId, ownerId);
    await db.query(
      "UPDATE jobs SET connector_id = $1, attempt = 1 WHERE id = $2",
      [connectorId, job.jobId],
    );
    const connection = await connectProductionMcp(repository, ownerId);

    try {
      const decision = {
        name: "decide_approval" as const,
        arguments: {
          approval_id: fixture.approvalId,
          decision: "approve" as const,
          expected_job_revision: fixture.jobRevision,
        },
      };
      const first = await connection.client.callTool(decision);
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toEqual({
        approval_id: fixture.approvalId,
        job_id: fixture.jobId,
        decision: "approve",
        revision: fixture.jobRevision,
      });

      const retry = await connection.client.callTool(decision);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toEqual(first.structuredContent);

      const approval = await db.query<{
        decision: string | null;
        decided_at: string | null;
      }>("SELECT decision, decided_at FROM approvals WHERE id = $1", [
        fixture.approvalId,
      ]);
      expect(approval.rows[0]).toMatchObject({ decision: "approve" });
      expect(approval.rows[0]?.decided_at).toBeTruthy();

      const storedJob = await db.query<{
        status: string;
        revision: number;
      }>("SELECT status, revision FROM jobs WHERE id = $1", [fixture.jobId]);
      expect(storedJob.rows[0]).toMatchObject({
        status: "waiting_approval",
        revision: fixture.jobRevision,
      });

      const events = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_events WHERE job_id = $1 AND event_type = 'approval.decided'",
        [fixture.jobId],
      );
      expect(Number(events.rows[0]?.count)).toBe(1);

      const messages = await db.query<{
        count: string;
        type: string;
      }>(
        "SELECT count(*)::text AS count, max(type) AS type FROM connector_messages WHERE connector_id = $1 AND direction = 'server' AND type = 'approval.decision' AND payload->>'approval_id' = $2",
        [connectorId, fixture.approvalId],
      );
      expect(messages.rows[0]).toEqual({
        count: "1",
        type: "approval.decision",
      });
    } finally {
      await closeProductionMcp(connection);
    }
  });

  it("keeps get_task_result terminal-only and acknowledges through production MCP idempotently", async () => {
    const repository = new JobRepository(db.client);
    const ownerId = crypto.randomUUID();
    const repositoryId = `repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const job = await createJob(repository, { ownerId, repositoryId });
    const connection = await connectProductionMcp(repository, ownerId);

    try {
      const queued = await connection.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.jobId },
      });
      expect(queued.isError).toBe(true);
      expect(queued.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_MUTABLE" },
      });

      await db.query(
        "UPDATE jobs SET status = 'succeeded', terminal_at = now(), unread_terminal = true, summary = $1::jsonb WHERE id = $2",
        [
          JSON.stringify({
            summary: "Integration checks passed",
            changed_files: ["src/index.ts"],
            tests: { passed: 8, failed: 0, summary: "8 passed" },
            artifacts: [],
          }),
          job.jobId,
        ],
      );

      const first = await connection.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.jobId },
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        job_id: job.jobId,
        summary: "Integration checks passed",
        changed_files: ["src/index.ts"],
        tests: { passed: 8, failed: 0, summary: "8 passed" },
      });
      const firstAcknowledgedAt = (
        first.structuredContent as { acknowledged_at: string }
      ).acknowledged_at;
      expect(firstAcknowledgedAt).toBeTruthy();

      const retry = await connection.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.jobId },
      });
      expect(retry.isError).not.toBe(true);
      expect(
        (retry.structuredContent as { acknowledged_at: string })
          .acknowledged_at,
      ).toBe(firstAcknowledgedAt);

      const stored = await db.query<{
        status: string;
        acknowledged_at: string | null;
        unread_terminal: boolean;
      }>(
        "SELECT status, acknowledged_at, unread_terminal FROM jobs WHERE id = $1",
        [job.jobId],
      );
      expect(stored.rows[0]).toMatchObject({
        status: "succeeded",
        unread_terminal: false,
      });
      expect(stored.rows[0]?.acknowledged_at).toBeTruthy();
    } finally {
      await closeProductionMcp(connection);
    }
  });
});
