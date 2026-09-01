import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { createTestDatabase, type TestDatabase } from "./support/postgres.js";

const db = createTestDatabase();

const SHA256_A = `sha256:${"a".repeat(64)}`;
const SHA256_B = `sha256:${"b".repeat(64)}`;
const DEFAULT_OWNER_ID = "integration-owner";
const DEFAULT_REPOSITORY_ID = "novelty-studio";

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
): Promise<{
  job: Awaited<ReturnType<JobRepository["transitionAndAppend"]>>;
  fixture: ApprovalFixture;
}> => {
  const job = await createJob(repository);
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
    const dispatched = await repository.transitionAndAppend(
      job.jobId,
      job.revision,
      "dispatched",
      event("job.dispatched"),
    );
    const eventsBefore = await repository.events(job.jobId);

    await expect(
      repository.claimOffer(job.jobId, {
        connectorId,
        attempt: dispatched.attempt + 2,
        leaseId: crypto.randomUUID(),
      }),
    ).resolves.toBeNull();

    await expect(repository.get(job.jobId)).resolves.toEqual(dispatched);
    await expect(repository.events(job.jobId)).resolves.toEqual(eventsBefore);
  });

  it("allows one connector to claim a dispatched offer and rejects a concurrent loser", async () => {
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

    const claims = await Promise.all([
      repository.claimOffer(job.jobId, {
        connectorId: firstConnector,
        attempt: 1,
        leaseId: crypto.randomUUID(),
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
    expect([firstConnector, secondConnector]).toContain(stored?.connectorId);
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
