import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
} from "@qhb/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "../../apps/control-plane/node_modules/drizzle-orm";
import {
  type ConnectorStoreError,
  PostgresConnectorStore,
  SERVER_REPLAY_BATCH_SIZE,
  type StoredServerMessage,
  storedServerMessageContainsPlaintextRequest,
} from "../../apps/control-plane/src/connector/outbox.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { Aes256GcmEncryptor } from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createTestDatabase } from "./support/postgres.js";

const database = createTestDatabase();
const FIXTURE_NAMESPACE = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const OWNER_ID = `connector-outbox-owner-${FIXTURE_NAMESPACE}`;
const REPOSITORY_ID = `connector-outbox-repository-${FIXTURE_NAMESPACE}`;
const CONNECTOR_ID = crypto.randomUUID();
const CREDENTIAL_ID = `connector-outbox-credential-${FIXTURE_NAMESPACE}`;
const REQUEST = "Run the focused connector outbox integration tests";
const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(51));

const identity = {
  ownerId: OWNER_ID,
  connectorId: CONNECTOR_ID,
  protocolVersion: "1.0",
} as const;

const envelope = <T extends ConnectorClientMessage["type"]>(
  type: T,
  sequence: number,
  payload: Extract<ConnectorClientMessage, { type: T }>["payload"],
  overrides: {
    messageId?: string;
    correlationId?: string;
    sentAt?: Date;
    expiresAt?: Date | string;
  } = {},
): Extract<ConnectorClientMessage, { type: T }> => {
  const sentAt = overrides.sentAt ?? new Date();
  const expiresAt = overrides.expiresAt ?? new Date(sentAt.getTime() + 60_000);
  return ConnectorClientMessageSchema.parse({
    protocol_version: "1.0",
    message_id: overrides.messageId ?? crypto.randomUUID(),
    sequence,
    sent_at: sentAt.toISOString(),
    expires_at:
      expiresAt instanceof Date
        ? expiresAt.toISOString()
        : new Date(expiresAt).toISOString(),
    correlation_id: overrides.correlationId ?? crypto.randomUUID(),
    type,
    payload,
  }) as Extract<ConnectorClientMessage, { type: T }>;
};

const uncheckedEnvelope = <T extends ConnectorClientMessage["type"]>(
  type: T,
  sequence: number,
  payload: Extract<ConnectorClientMessage, { type: T }>["payload"],
  sentAt = new Date(),
): Extract<ConnectorClientMessage, { type: T }> =>
  ({
    protocol_version: "1.0",
    message_id: crypto.randomUUID(),
    sequence,
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + 60_000).toISOString(),
    correlation_id: crypto.randomUUID(),
    type,
    payload,
  }) as Extract<ConnectorClientMessage, { type: T }>;

const insertConnector = async (
  connectorId = crypto.randomUUID(),
): Promise<{
  ownerId: string;
  connectorId: string;
  protocolVersion: "1.0";
}> => {
  await database.query(
    `INSERT INTO connectors
       (id, owner_id, credential_id, credential_hash, protocol_version)
     VALUES ($1, $2, $3, 'scrypt$fixture', '1.0')`,
    [connectorId, OWNER_ID, `outbox-${crypto.randomUUID()}`],
  );
  return { ...identity, connectorId };
};

const createJob = async (
  repositoryId = `outbox-job-${crypto.randomUUID()}`,
  request = "Outbox integration request",
): Promise<{ jobId: string; revision: number; repositoryId: string }> => {
  await database.query(
    `INSERT INTO repository_policies
       (id, owner_id, display_name, canonical_path, allowed_action_classes)
     VALUES ($1, $2, 'Outbox job repository', '/private/redacted', '[]'::jsonb)`,
    [repositoryId, OWNER_ID],
  );
  const job = await new JobRepository(database.client).createIdempotent({
    ownerId: OWNER_ID,
    clientRequestId: crypto.randomUUID(),
    repositoryId,
    requestCiphertext: cipher.encrypt(request),
    requestDigest: `sha256:${crypto.randomUUID().replaceAll("-", "")}`,
  });
  return { ...job, repositoryId };
};

const insertConnectedJob = async (
  connectorId: string,
  status:
    | "queued"
    | "dispatched"
    | "running"
    | "waiting_approval"
    | "cancelling",
  expiresAt: Date,
  attempt: number,
  leaseId: string | null,
  leaseExpiresAt: Date | null,
): Promise<{ jobId: string; revision: number; leaseId: string | null }> => {
  const job = await createJob();
  await database.query(
    `UPDATE jobs
        SET connector_id = $1,
            status = $2::job_status,
            attempt = $3,
            lease_id = $4,
            lease_expires_at = $5,
            expires_at = $6,
            current_stage = $2,
            revision = 0
      WHERE id = $7`,
    [
      connectorId,
      status,
      attempt,
      leaseId,
      leaseExpiresAt,
      expiresAt,
      job.jobId,
    ],
  );
  return {
    jobId: job.jobId,
    revision: 0,
    leaseId,
  };
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const advisoryWaiterCount = async (keys: number[]): Promise<number> => {
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND classid = 0
        AND objid = ANY($1::oid[])`,
    [keys],
  );
  return Number(result.rows[0]?.count ?? 0);
};

const waitForAdvisoryWaiters = async (
  keys: number[],
  expected: number,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount(keys)) >= expected) return;
    await delay(10);
  }
  throw new Error(
    `Timed out waiting for ${expected} advisory lock waiters on ${keys.join(",")}`,
  );
};

const waitForRowLockWaiter = async (
  relation: "connectors" | "jobs",
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%"${relation}"%'
          AND query ILIKE '%for update%'`,
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for a PostgreSQL row lock waiter");
};

const expiryAfter = async (milliseconds: number): Promise<Date> => {
  const result = await database.query<{ expires_at: Date }>(
    `SELECT clock_timestamp() + interval '${milliseconds} milliseconds' AS expires_at`,
  );
  const expiresAt = result.rows[0]?.expires_at;
  if (expiresAt === undefined) throw new Error("expected a database expiry");
  return expiresAt;
};

const waitForTableWriteWaiter = async (
  table: "approvals" | "connector_messages" | "job_events" | "jobs",
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiters = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_locks l
         JOIN pg_class c ON c.oid = l.relation
        WHERE c.relname = $1
          AND l.mode = 'RowExclusiveLock'
          AND l.granted = false`,
      [table],
    );
    if (Number(waiters.rows[0]?.count ?? 0) > 0) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for a ${table} write lock waiter`);
};

const createWriteBoundaryGate = async (
  table: "connector_messages" | "job_events" | "jobs",
  expiresAt: Date,
): Promise<{
  waitUntilBlocked(): Promise<void>;
  releaseAtExpiry(): Promise<void>;
  dispose(): Promise<void>;
}> => {
  let signalReady!: () => void;
  let releaseHolder!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  const holder = database.client.transaction(async (tx) => {
    await tx.execute(
      table === "jobs"
        ? drizzleSql`LOCK TABLE jobs IN SHARE MODE`
        : table === "job_events"
          ? drizzleSql`LOCK TABLE job_events IN SHARE MODE`
          : drizzleSql`LOCK TABLE connector_messages IN SHARE MODE`,
    );
    signalReady();
    await released;
    await tx.execute(
      drizzleSql`SELECT pg_sleep_until(${expiresAt}::timestamptz + interval '25 milliseconds')`,
    );
  });
  await ready;

  return {
    waitUntilBlocked: () => waitForTableWriteWaiter(table),
    releaseAtExpiry: async () => {
      releaseHolder();
      await holder;
    },
    dispose: async () => {
      releaseHolder();
      await holder;
    },
  };
};

const holdConnectorRowUntil = (
  connectorId: string,
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
  const done = database.client.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT id FROM connectors WHERE id = ${connectorId} FOR UPDATE`,
    );
    signalReady();
    await waitForExpiry;
    await tx.execute(
      drizzleSql`SELECT pg_sleep_until(${expiresAt}::timestamptz + interval '25 milliseconds')`,
    );
  });
  return { ready, releaseToExpiry, done };
};

const serverMessagesBySequence = async (
  connectorId: string,
  count: number,
): Promise<Array<{ sequence: number; messageId: string; type: string }>> => {
  const result = await database.query<{
    sequence: number;
    message_id: string;
    type: string;
  }>(
    `SELECT sequence, message_id, type
       FROM connector_messages
      WHERE connector_id = $1 AND direction = 'server'
      ORDER BY sequence
      LIMIT $2`,
    [connectorId, count],
  );
  return result.rows.map((row) => ({
    sequence: Number(row.sequence),
    messageId: row.message_id,
    type: row.type,
  }));
};

const expectStoreError = async (
  operation: Promise<unknown>,
  code: ConnectorStoreError["code"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
};

const expectClientCursor = async (
  connectorId: string,
  sequence: number,
): Promise<void> => {
  const result = await database.query<{ last_client_sequence: number }>(
    "SELECT last_client_sequence FROM connectors WHERE id = $1",
    [connectorId],
  );
  expect(Number(result.rows[0]?.last_client_sequence)).toBe(sequence);
};

beforeAll(async () => {
  await database.start();
  await database.query(
    `INSERT INTO owners (id, display_name) VALUES ($1, 'Connector outbox owner')`,
    [OWNER_ID],
  );
  await database.query(
    `INSERT INTO connectors
       (id, owner_id, credential_id, credential_hash, protocol_version)
     VALUES ($1, $2, $3, 'scrypt$fixture', '1.0')`,
    [CONNECTOR_ID, OWNER_ID, CREDENTIAL_ID],
  );
  await database.query(
    `INSERT INTO repository_policies
       (id, owner_id, display_name, canonical_path, allowed_action_classes)
     VALUES ($1, $2, 'Outbox repository', '/private/redacted', '[]'::jsonb)`,
    [REPOSITORY_ID, OWNER_ID],
  );
});

afterAll(async () => {
  await database.stop();
});

describe("PostgreSQL Connector outbox", () => {
  it("retains cancelled-before-claim precedence without incrementing an exhausted attempt", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const lease = crypto.randomUUID();
    const job = await insertConnectedJob(
      owner.connectorId,
      "dispatched",
      new Date(Date.now() + 600_000),
      2147483647,
      lease,
      new Date(Date.now() + 30_000),
    );
    await database.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [
      job.jobId,
    ]);
    const before = await database.query("SELECT * FROM jobs WHERE id = $1", [
      job.jobId,
    ]);
    const accepted = await store.acceptClientMessage(
      owner,
      envelope("job.claim", 2, {
        job_id: job.jobId,
        attempt: 2147483648,
        lease_id: lease,
      }),
    );
    expect(accepted.replay[0]?.payload).toEqual({
      code: "CLAIM_REJECTED",
      message: "The offered job was cancelled before it was claimed.",
    });
    expect(accepted.response?.payload).toEqual({ sequence: 2 });
    expect(
      await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId]),
    ).toEqual(before);
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });

  it("hard denies a guessed exhausted claim before deadline consumption", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const lease = crypto.randomUUID();
    const job = await insertConnectedJob(
      owner.connectorId,
      "dispatched",
      new Date(Date.now() - 1000),
      2147483647,
      lease,
      new Date(Date.now() - 1000),
    );
    const snapshot = async () => ({
      job: await database.query("SELECT * FROM jobs WHERE id = $1", [
        job.jobId,
      ]),
      connector: await database.query(
        "SELECT * FROM connectors WHERE id = $1",
        [owner.connectorId],
      ),
      messages: await database.query(
        "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
        [owner.connectorId],
      ),
      events: await database.query(
        "SELECT * FROM job_events WHERE job_id = $1",
        [job.jobId],
      ),
    });
    const before = await snapshot();
    await expect(
      store.acceptClientMessage(
        owner,
        envelope("job.claim", 2, {
          job_id: job.jobId,
          attempt: 1,
          lease_id: lease,
        }),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_REJECTED" });
    expect(await snapshot()).toEqual(before);
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });

  it.each(["proven", "unproven", "legacy"])(
    "guards historical offered attempt exhaustion without forged consumption: %s",
    async (kind) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities:
            kind === "legacy"
              ? ["durable-receipts-v1"]
              : ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      await createJob();
      const offer = await store.dispatchNext(owner);
      if (!offer) throw new Error("missing dispatch");
      const jobId = String(offer.payload.job_id);
      await database.query(
        "UPDATE jobs SET attempt = 2147483647 WHERE id = $1",
        [jobId],
      );
      // Model a retained offer made before the explicit pre-overflow guard.
      if (kind !== "unproven")
        await database.query(
          "UPDATE job_events SET payload = jsonb_set(payload, '{attempt}', '2147483648') WHERE job_id = $1 AND event_type = 'job.dispatched'",
          [jobId],
        );
      const request = envelope("job.claim", 2, {
        job_id: jobId,
        attempt: 2147483648,
        lease_id: String(offer.payload.lease_id),
      });
      const snapshot = async () => ({
        job: await database.query("SELECT * FROM jobs WHERE id = $1", [jobId]),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1",
          [jobId],
        ),
        connector: await database.query(
          "SELECT * FROM connectors WHERE id = $1",
          [owner.connectorId],
        ),
        messages: await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
          [owner.connectorId],
        ),
      });
      const before = await snapshot();
      if (kind === "proven") {
        const accepted = await store.acceptClientMessage(owner, request);
        expect(accepted.replay[0]?.payload).toEqual({
          code: "CLAIM_REJECTED",
          message: "The job business limit has been reached.",
        });
        expect(accepted.response?.payload).toEqual({ sequence: 2 });
        expect((await snapshot()).job).toEqual(before.job);
        expect((await snapshot()).events).toEqual(before.events);
      } else {
        await expect(
          store.acceptClientMessage(owner, request),
        ).rejects.toMatchObject({
          code: "CLAIM_REJECTED",
          message: "The job business limit has been reached.",
        });
        expect(await snapshot()).toEqual(before);
      }
      await database.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    },
  );

  it("hard fails an unexpected zero-row dispatch without storing an offer", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const job = await createJob();
    const fn = `dispatch_zero_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${job.jobId}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
    );
    try {
      const snapshot = async () => ({
        job: await database.query("SELECT * FROM jobs WHERE id = $1", [
          job.jobId,
        ]),
        connector: await database.query(
          "SELECT * FROM connectors WHERE id = $1",
          [owner.connectorId],
        ),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1",
          [job.jobId],
        ),
        messages: await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1",
          [owner.connectorId],
        ),
      });
      const before = await snapshot();
      await expect(store.dispatchNext(owner)).rejects.toMatchObject({
        code: "INTERNAL",
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      await database.query(
        `DROP TRIGGER ${fn} ON jobs; DROP FUNCTION ${fn}();`,
      );
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it("hard guards unsafe next client sequence before receipt insertion", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await database.query(
      "UPDATE connectors SET last_client_sequence = $1 WHERE id = $2",
      [Number.MAX_SAFE_INTEGER, owner.connectorId],
    );
    const before = await database.query(
      "SELECT * FROM connectors WHERE id = $1",
      [owner.connectorId],
    );
    await expect(
      store.acceptClientMessage(
        owner,
        uncheckedEnvelope(
          "connector.heartbeat",
          Number.MAX_SAFE_INTEGER + 1,
          {},
        ),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(
      await database.query("SELECT * FROM connectors WHERE id = $1", [
        owner.connectorId,
      ]),
    ).toEqual(before);
    expect(
      (
        await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1",
          [owner.connectorId],
        )
      ).rows,
    ).toEqual([]);
  });

  it.each(["job.event", "job.cancelled"] as const)(
    "preserves legitimate terminal repeats at the revision limit: %s",
    async (type) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      const job = await insertConnectedJob(
        owner.connectorId,
        "running",
        new Date(Date.now() - 1000),
        1,
        null,
        null,
      );
      await database.query(
        "UPDATE jobs SET status = 'failed', revision = 2147483647 WHERE id = $1",
        [job.jobId],
      );
      const before = await database.query("SELECT * FROM jobs WHERE id = $1", [
        job.jobId,
      ]);
      const request =
        type === "job.event"
          ? envelope(type, 2, {
              job_id: job.jobId,
              attempt: 1,
              event_type: "job.succeeded",
              payload: { summary: "Finished" },
              source: "connector",
            })
          : envelope(type, 2, {
              job_id: job.jobId,
              attempt: 1,
              reason: "Cancelled",
            });
      const accepted = await store.acceptClientMessage(owner, request);
      expect(accepted.replay).toEqual([]);
      expect(accepted.response).toMatchObject({
        type: "ack",
        payload: { sequence: 2 },
      });
      expect(
        await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId]),
      ).toEqual(before);
      expect(
        (
          await database.query("SELECT * FROM job_events WHERE job_id = $1", [
            job.jobId,
          ])
        ).rows,
      ).toHaveLength(1);
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    },
  );

  it.each(["XX000", "23505"])(
    "keeps unexpected business storage errors hard under coordination: %s",
    async (code) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      const job = await insertConnectedJob(
        owner.connectorId,
        "running",
        new Date(Date.now() + 600_000),
        1,
        null,
        null,
      );
      const fn = `coordination_error_${crypto.randomUUID().replaceAll("-", "")}`;
      await database.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id = '${job.jobId}'::uuid THEN RAISE EXCEPTION 'fixture failure' USING ERRCODE = '${code}'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
      );
      try {
        const snapshot = async () => ({
          job: await database.query("SELECT * FROM jobs WHERE id = $1", [
            job.jobId,
          ]),
          events: await database.query(
            "SELECT * FROM job_events WHERE job_id = $1",
            [job.jobId],
          ),
          connector: await database.query(
            "SELECT * FROM connectors WHERE id = $1",
            [owner.connectorId],
          ),
          messages: await database.query(
            "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
            [owner.connectorId],
          ),
        });
        const before = await snapshot();
        await expect(
          store.acceptClientMessage(
            owner,
            envelope("job.event", 2, {
              job_id: job.jobId,
              attempt: 1,
              event_type: "progress",
              payload: { stage: "Checking" },
              source: "connector",
            }),
          ),
        ).rejects.toBeDefined();
        expect(await snapshot()).toEqual(before);
      } finally {
        await database.query(
          `DROP TRIGGER ${fn} ON job_events; DROP FUNCTION ${fn}();`,
        );
        await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
      }
    },
  );

  it("observes the committed row after waiting for the actual job lock", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      new Date(Date.now() + 600_000),
      1,
      null,
      null,
    );
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = database.client.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE jobs SET revision = 9 WHERE id = ${job.jobId}`,
      );
      ready();
      await released;
    });
    await locked;
    const observing = store.acceptClientMessage(
      owner,
      envelope("job.sync", 2, {
        job_id: job.jobId,
        attempt: 1,
        nonce: crypto.randomUUID(),
      }),
    );
    try {
      await waitForRowLockWaiter("jobs");
      release();
      await writer;
      const observed = await observing;
      expect(observed.replay[0]?.payload.job_revision).toBe(9);
    } finally {
      release();
      await Promise.allSettled([writer, observing]);
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it.each([
    "missing",
    "missing-job",
    "cross-owner",
    "source",
    "owner",
    "connector",
    "repository",
    "attempt",
    "lease",
    "deadline",
    "ambiguous",
  ])(
    "hard denies unproven historical sync with full no-effect snapshots: %s",
    async (fault) => {
      const owner = await insertConnector();
      const replacement = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      const job = await insertConnectedJob(
        replacement.connectorId,
        "running",
        new Date(Date.now() + 600_000),
        1,
        null,
        null,
      );
      const proof: Record<string, unknown> = {
        owner_id: OWNER_ID,
        connector_id: owner.connectorId,
        repository_id: (
          await database.query("SELECT repository_id FROM jobs WHERE id = $1", [
            job.jobId,
          ])
        ).rows[0]?.repository_id,
        attempt: 1,
        lease_id: crypto.randomUUID(),
        lease_expires_at: new Date().toISOString(),
      };
      if (fault === "owner") proof.owner_id = "wrong-owner";
      if (fault === "connector") proof.connector_id = replacement.connectorId;
      if (fault === "repository") proof.repository_id = "wrong-repository";
      if (fault === "attempt") proof.attempt = "1";
      if (fault === "lease") proof.lease_id = "invalid";
      if (fault === "deadline") proof.lease_expires_at = "invalid";
      if (fault !== "missing")
        await database.query(
          "INSERT INTO job_events (job_id, sequence, event_type, payload, source) VALUES ($1, 1, 'job.dispatched', $2::jsonb, $3)",
          [
            job.jobId,
            JSON.stringify(proof),
            fault === "source" ? "connector" : "control-plane",
          ],
        );
      if (fault === "ambiguous")
        await database.query(
          "INSERT INTO job_events (job_id, sequence, event_type, payload, source) VALUES ($1, 2, 'job.redispatched', $2::jsonb, 'control-plane')",
          [
            job.jobId,
            JSON.stringify({ ...proof, lease_id: crypto.randomUUID() }),
          ],
        );
      let requester = owner;
      if (fault === "cross-owner") {
        const otherOwner = `coordination-other-${crypto.randomUUID()}`;
        await database.query("INSERT INTO owners (id) VALUES ($1)", [
          otherOwner,
        ]);
        await database.query(
          "UPDATE connectors SET owner_id = $1 WHERE id = $2",
          [otherOwner, owner.connectorId],
        );
        requester = { ...owner, ownerId: otherOwner };
      }
      const snapshot = async () => ({
        job: await database.query("SELECT * FROM jobs WHERE id = $1", [
          job.jobId,
        ]),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence",
          [job.jobId],
        ),
        connectors: await database.query(
          "SELECT * FROM connectors WHERE id = $1",
          [owner.connectorId],
        ),
        messages: await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
          [owner.connectorId],
        ),
      });
      const before = await snapshot();
      await expect(
        store.acceptClientMessage(
          requester,
          envelope("job.sync", 2, {
            job_id: fault === "missing-job" ? crypto.randomUUID() : job.jobId,
            attempt: 1,
            nonce: crypto.randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
      expect(await snapshot()).toEqual(before);
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    },
  );

  it.each(["valid", "wrong-lease", "wrong-attempt", "missing-proof"])(
    "requires exact real offer proof for a claim status conflict: %s",
    async (kind) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      await createJob();
      const offer = await store.dispatchNext(owner);
      if (!offer) throw new Error("missing dispatch");
      const jobId = String(offer.payload.job_id);
      await database.query(
        "UPDATE jobs SET status = 'failed', attempt = 1 WHERE id = $1",
        [jobId],
      );
      if (kind === "missing-proof")
        await database.query("DELETE FROM job_events WHERE job_id = $1", [
          jobId,
        ]);
      const request = envelope("job.claim", 2, {
        job_id: jobId,
        attempt: kind === "wrong-attempt" ? 2 : 1,
        lease_id:
          kind === "wrong-lease"
            ? crypto.randomUUID()
            : String(offer.payload.lease_id),
      });
      const snapshot = async () => ({
        job: await database.query("SELECT * FROM jobs WHERE id = $1", [jobId]),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1",
          [jobId],
        ),
        connector: await database.query(
          "SELECT * FROM connectors WHERE id = $1",
          [owner.connectorId],
        ),
        messages: await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
          [owner.connectorId],
        ),
      });
      const before = await snapshot();
      if (kind === "valid") {
        const accepted = await store.acceptClientMessage(owner, request);
        expect(accepted.replay[0]?.payload).toEqual({
          code: "CLAIM_REJECTED",
          message: "The job authority has changed.",
        });
        expect(accepted.response?.payload).toEqual({ sequence: 2 });
        expect((await snapshot()).job).toEqual(before.job);
        expect((await snapshot()).events).toEqual(before.events);
        const state = await store.acceptClientMessage(
          owner,
          envelope("job.sync", 3, {
            job_id: jobId,
            attempt: 1,
            nonce: crypto.randomUUID(),
          }),
        );
        expect(state.replay[0]?.payload.status).toBe("failed");
      } else {
        await expect(
          store.acceptClientMessage(owner, request),
        ).rejects.toMatchObject({ code: "CLAIM_REJECTED" });
        expect(await snapshot()).toEqual(before);
      }
      await database.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    },
  );

  it.each(["ack-insert", "ack-metadata", "client-cursor"])(
    "rolls back the whole sync transaction at %s failure",
    async (boundary) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      const job = await insertConnectedJob(
        owner.connectorId,
        "running",
        new Date(Date.now() + 600_000),
        1,
        null,
        null,
      );
      const fn = `sync_failure_${crypto.randomUUID().replaceAll("-", "")}`;
      const table =
        boundary === "client-cursor" ? "connectors" : "connector_messages";
      const condition =
        boundary === "client-cursor"
          ? `NEW.id = '${owner.connectorId}'::uuid AND NEW.last_client_sequence = 2`
          : `NEW.connector_id = '${owner.connectorId}'::uuid AND ${boundary === "ack-insert" ? "NEW.direction = 'server' AND NEW.type = 'ack'" : "NEW.direction = 'client' AND NEW.payload ? '__qhb_receipt_ack'"}`;
      await database.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${boundary === "client-cursor" ? "RETURN NULL" : "RAISE EXCEPTION 'fixture failure' USING ERRCODE = 'XX000'"}; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE ${boundary === "ack-insert" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
      );
      try {
        const snapshot = async () => ({
          connector: await database.query(
            "SELECT * FROM connectors WHERE id = $1",
            [owner.connectorId],
          ),
          messages: await database.query(
            "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
            [owner.connectorId],
          ),
          job: await database.query("SELECT * FROM jobs WHERE id = $1", [
            job.jobId,
          ]),
          events: await database.query(
            "SELECT * FROM job_events WHERE job_id = $1",
            [job.jobId],
          ),
          approvals: await database.query(
            "SELECT * FROM approvals WHERE job_id = $1",
            [job.jobId],
          ),
        });
        const before = await snapshot();
        await expect(
          store.acceptClientMessage(
            owner,
            envelope("job.sync", 2, {
              job_id: job.jobId,
              attempt: 1,
              nonce: crypto.randomUUID(),
            }),
          ),
        ).rejects.toBeDefined();
        expect(await snapshot()).toEqual(before);
      } finally {
        await database.query(
          `DROP TRIGGER ${fn} ON ${table}; DROP FUNCTION ${fn}();`,
        );
        await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
      }
    },
  );

  it.each([false, true])(
    "renews only delivery for immutable expired state (tombstone=%s)",
    async (tombstone) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      const job = await insertConnectedJob(
        owner.connectorId,
        "running",
        new Date(Date.now() - 1000),
        1,
        null,
        null,
      );
      const sync = envelope("job.sync", 2, {
        job_id: job.jobId,
        attempt: 2,
        nonce: crypto.randomUUID(),
      });
      const original = await store.acceptClientMessage(owner, sync);
      await database.query(
        "UPDATE connector_messages SET expires_at = clock_timestamp() - interval '1 second' WHERE connector_id = $1 AND direction = 'server' AND sequence > 1",
        [owner.connectorId],
      );
      if (tombstone) {
        const pending = await store.pendingServerMessages(owner, 1);
        expect(pending.map((row) => row.type)).toEqual([
          "protocol.error",
          "protocol.error",
        ]);
        expect(pending.map((row) => row.payload.code)).toEqual([
          "MESSAGE_EXPIRED",
          "MESSAGE_EXPIRED",
        ]);
      }
      await database.query(
        "UPDATE jobs SET status = 'expired', revision = 8, connector_id = NULL WHERE id = $1",
        [job.jobId],
      );
      const restored = await store.acceptClientMessage(owner, sync);
      expect(restored.replay[0]?.payload).toEqual(original.replay[0]?.payload);
      expect(restored.response?.payload).toEqual({ sequence: 2 });
      expect(restored.replay[0]?.messageId).not.toBe(
        original.replay[0]?.messageId,
      );
      expect(restored.response?.messageId).not.toBe(
        original.response?.messageId,
      );
      expect(restored.replay[0]?.sequence).toBe(original.replay[0]?.sequence);
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    },
  );

  it("observes actual cancellation provenance after later progress and preserves legacy null", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      new Date(Date.now() + 600_000),
      1,
      null,
      null,
    );
    await new JobRepository(database.client).cancelAtomically({
      ownerId: OWNER_ID,
      jobId: job.jobId,
      expectedRevision: 0,
    });
    await store.acceptClientMessage(
      owner,
      envelope("job.event", 2, {
        job_id: job.jobId,
        attempt: 1,
        event_type: "progress",
        payload: { stage: "Draining" },
        source: "connector",
      }),
    );
    const observed = await store.acceptClientMessage(
      owner,
      envelope("job.sync", 3, {
        job_id: job.jobId,
        attempt: 1,
        nonce: crypto.randomUUID(),
      }),
    );
    expect(observed.replay[0]?.payload).toMatchObject({
      status: "cancelling",
      job_revision: 2,
      cancel_revision: 1,
    });
    await database.query(
      "UPDATE jobs SET cancel_revision = NULL WHERE id = $1",
      [job.jobId],
    );
    const legacy = await store.acceptClientMessage(
      owner,
      envelope("job.sync", 4, {
        job_id: job.jobId,
        attempt: 1,
        nonce: crypto.randomUUID(),
      }),
    );
    expect(legacy.replay[0]?.payload).toMatchObject({
      status: "cancelling",
      job_revision: 2,
      cancel_revision: null,
    });
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });

  it.each(["claim", "event", "approval", "cancelled"] as const)(
    "consumes authorized 32-bit revision exhaustion without business effects: %s",
    async (kind) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        }),
      );
      await createJob();
      const offer = await store.dispatchNext(owner);
      if (!offer) throw new Error("expected dispatch");
      const jobId = String(offer.payload.job_id);
      await database.query(
        "UPDATE jobs SET revision = 2147483647, status = $1::job_status, attempt = $2 WHERE id = $3",
        [
          kind === "claim"
            ? "dispatched"
            : kind === "cancelled"
              ? "cancelling"
              : "running",
          kind === "claim" ? 0 : 1,
          jobId,
        ],
      );
      const request =
        kind === "claim"
          ? envelope("job.claim", 2, {
              job_id: jobId,
              attempt: 1,
              lease_id: String(offer.payload.lease_id),
            })
          : kind === "event"
            ? envelope("job.event", 2, {
                job_id: jobId,
                attempt: 1,
                event_type: "progress",
                payload: { stage: "Checking" },
                source: "connector",
              })
            : kind === "cancelled"
              ? envelope("job.cancelled", 2, {
                  job_id: jobId,
                  attempt: 1,
                  reason: "Cancelled",
                })
              : envelope("approval.requested", 2, {
                  job_id: jobId,
                  attempt: 1,
                  job_revision: 2147483648,
                  approval_id: crypto.randomUUID(),
                  action_summary: "Run checks",
                  impact_summary: "Checks only",
                  risk_class: "low",
                  action_fingerprint: `sha256:${"b".repeat(64)}`,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                });
      const snapshot = async () => ({
        jobs: await database.query("SELECT * FROM jobs WHERE id = $1", [jobId]),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence",
          [jobId],
        ),
        approvals: await database.query(
          "SELECT * FROM approvals WHERE job_id = $1",
          [jobId],
        ),
      });
      const before = await snapshot();
      const accepted = await store.acceptClientMessage(owner, request);
      expect(accepted.replay[0]).toMatchObject({
        type: "protocol.error",
        payload: {
          code: kind === "claim" ? "CLAIM_REJECTED" : "EVENT_REJECTED",
          message: "The job business limit has been reached.",
        },
      });
      expect(accepted.response).toMatchObject({
        type: "ack",
        payload: { sequence: 2 },
      });
      expect(await snapshot()).toEqual(before);
      expect(await store.acceptClientMessage(owner, request)).toEqual({
        ...accepted,
        duplicate: true,
      });
      await database.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    },
  );

  it.each(["revision", "attempt"])(
    "hard guards dispatch %s exhaustion before any write",
    async (field) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      const job = await createJob();
      await database.query(
        field === "revision"
          ? "UPDATE jobs SET revision = 2147483647 WHERE id = $1"
          : "UPDATE jobs SET attempt = 2147483647 WHERE id = $1",
        [job.jobId],
      );
      const snapshot = async () => ({
        job: await database.query("SELECT * FROM jobs WHERE id = $1", [
          job.jobId,
        ]),
        connector: await database.query(
          "SELECT * FROM connectors WHERE id = $1",
          [owner.connectorId],
        ),
        messages: await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1",
          [owner.connectorId],
        ),
        events: await database.query(
          "SELECT * FROM job_events WHERE job_id = $1",
          [job.jobId],
        ),
      });
      const before = await snapshot();
      await expect(store.dispatchNext(owner)).rejects.toMatchObject({
        code: "CLAIM_REJECTED",
        message: "The job business limit has been reached.",
      });
      expect(await snapshot()).toEqual(before);
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    },
  );

  it("uses real retained dispatch proof for historical sync without disclosing replacement state", async () => {
    const owner = await insertConnector();
    const replacement = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    await createJob();
    const offer = await store.dispatchNext(owner);
    if (!offer) throw new Error("expected real dispatch");
    const jobId = String(offer.payload.job_id);
    const attempt = Number(offer.payload.attempt);
    await database.query(
      "UPDATE jobs SET connector_id = $1, revision = revision + 1 WHERE id = $2",
      [replacement.connectorId, jobId],
    );
    const before = await database.query("SELECT * FROM jobs WHERE id = $1", [
      jobId,
    ]);
    const sync = envelope("job.sync", 2, {
      job_id: jobId,
      attempt,
      nonce: crypto.randomUUID(),
    });
    const accepted = await store.acceptClientMessage(owner, sync);
    expect(
      accepted.replay.map((row) => ({ type: row.type, payload: row.payload })),
    ).toEqual([
      {
        type: "protocol.error",
        payload: {
          code: "JOB_AUTHORITY_UNAVAILABLE",
          message: "The job authority is unavailable.",
        },
      },
    ]);
    expect(accepted.response).toMatchObject({
      type: "ack",
      payload: { sequence: 2 },
    });
    expect(
      await database.query("SELECT * FROM jobs WHERE id = $1", [jobId]),
    ).toEqual(before);
    expect(await store.acceptClientMessage(owner, sync)).toEqual({
      ...accepted,
      duplicate: true,
    });
    await database.query(
      "UPDATE job_events SET payload = payload - 'owner_id' WHERE job_id = $1 AND event_type = 'job.dispatched'",
      [jobId],
    );
    await expect(
      store.acceptClientMessage(
        owner,
        envelope("job.sync", 3, {
          job_id: jobId,
          attempt,
          nonce: crypto.randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await database.query("DELETE FROM jobs WHERE id = $1", [jobId]);
  });

  for (const capabilities of [
    [],
    ["durable-receipts-v1"],
    ["durable-receipts-v1", "job-coordination-v1"],
  ]) {
    it.each([
      ["approval-status", "approval.requested", "queued", 1, 0],
      ["approval-attempt", "approval.requested", "running", 2, 0],
      ["approval-revision", "approval.requested", "running", 1, 4],
      ["event-attempt", "job.event", "running", 2, 0],
      ["event-unclaimed", "job.event", "queued", 1, 0],
      ["event-terminal-progress", "job.event", "succeeded", 1, 0],
      ["event-transition", "job.event", "cancelling", 1, 0],
      ["cancel-attempt", "job.cancelled", "cancelling", 2, 0],
      ["cancel-status", "job.cancelled", "running", 1, 0],
    ] as const)(
      `classifies %s with ${capabilities.length} negotiated profiles`,
      async (_category, type, status, attempt, revision) => {
        const owner = await insertConnector();
        const store = new PostgresConnectorStore(database.client);
        await store.acceptClientMessage(
          owner,
          envelope("connector.hello", 1, {
            connector_id: owner.connectorId,
            last_server_sequence: 0,
            capabilities,
          }),
        );
        const job = await insertConnectedJob(
          owner.connectorId,
          "running",
          new Date(Date.now() + 600_000),
          1,
          null,
          null,
        );
        await database.query(
          "UPDATE jobs SET status = $1::job_status, revision = $2 WHERE id = $3",
          [status, revision, job.jobId],
        );
        const payload =
          type === "approval.requested"
            ? {
                job_id: job.jobId,
                attempt,
                job_revision: 1,
                approval_id: crypto.randomUUID(),
                action_summary: "Run checks",
                impact_summary: "Checks only",
                risk_class: "low",
                action_fingerprint: `sha256:${"a".repeat(64)}`,
                expires_at: new Date(Date.now() + 30_000).toISOString(),
              }
            : type === "job.event"
              ? {
                  job_id: job.jobId,
                  attempt,
                  event_type: "progress",
                  payload: { status: "running" },
                  source: "connector",
                }
              : { job_id: job.jobId, attempt, reason: "Cancelled" };
        const before = await database.query(
          "SELECT * FROM jobs WHERE id = $1",
          [job.jobId],
        );
        const request = envelope(type, 2, payload);
        if (capabilities.length < 2) {
          const receipt = await database.query(
            "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
            [owner.connectorId],
          );
          const connector = await database.query(
            "SELECT * FROM connectors WHERE id = $1",
            [owner.connectorId],
          );
          await expect(
            store.acceptClientMessage(owner, request),
          ).rejects.toMatchObject({ code: "EVENT_REJECTED" });
          expect(
            await database.query(
              "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
              [owner.connectorId],
            ),
          ).toEqual(receipt);
          expect(
            await database.query("SELECT * FROM connectors WHERE id = $1", [
              owner.connectorId,
            ]),
          ).toEqual(connector);
          expect(
            await database.query("SELECT * FROM jobs WHERE id = $1", [
              job.jobId,
            ]),
          ).toEqual(before);
          await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
          return;
        }
        const accepted = await store.acceptClientMessage(owner, request);
        expect(accepted.replay[0]).toMatchObject({
          type: "protocol.error",
          payload: {
            code: "EVENT_REJECTED",
            message: "The job authority has changed.",
          },
        });
        expect(accepted.response).toMatchObject({
          type: "ack",
          payload: { sequence: 2 },
        });
        expect(
          await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId]),
        ).toEqual(before);
        expect(
          (
            await database.query("SELECT * FROM job_events WHERE job_id = $1", [
              job.jobId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await database.query("SELECT * FROM approvals WHERE job_id = $1", [
              job.jobId,
            ])
          ).rows,
        ).toEqual([]);
        const state = await store.acceptClientMessage(
          owner,
          envelope("job.sync", 3, {
            job_id: job.jobId,
            attempt: 1,
            nonce: crypto.randomUUID(),
          }),
        );
        expect(state.replay[0]?.payload).toMatchObject({
          status,
          current_attempt: 1,
          job_revision: revision,
        });
        expect(await store.acceptClientMessage(owner, request)).toEqual({
          ...accepted,
          duplicate: true,
        });
        await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
      },
    );
  }

  it.each([
    "nonce",
    "request",
    "job-binding",
    "attempt-binding",
    "request-id",
    "profile",
    "missing-profile",
    "pair",
    "state-as-ack",
    "correlation",
    "missing-correlation",
    "sequence",
    "ack-order",
    "ack-payload",
    "ack-correlation",
    "unknown-replacement",
    "tombstone-message",
  ])("rejects corrupt coordination replay atomically: %s", async (fault) => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      new Date(Date.now() + 600_000),
      1,
      null,
      null,
    );
    const sync = envelope("job.sync", 2, {
      job_id: job.jobId,
      attempt: 1,
      nonce: crypto.randomUUID(),
    });
    await store.acceptClientMessage(owner, sync);
    const saved = await database.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM connector_messages WHERE message_id = $1",
      [sync.message_id],
    );
    const metadata = saved.rows[0]?.payload;
    if (!metadata) throw new Error("missing receipt");
    const original = metadata.__qhb_original_response as {
      type: string;
      payload: Record<string, unknown>;
      sequence: number;
      correlation_id: string;
    };
    if (fault === "nonce") original.payload.nonce = crypto.randomUUID();
    if (fault === "request") original.payload.request_sequence = 1;
    if (fault === "job-binding") original.payload.job_id = crypto.randomUUID();
    if (fault === "attempt-binding") original.payload.requested_attempt = 2;
    if (fault === "request-id")
      original.payload.request_message_id = crypto.randomUUID();
    if (
      [
        "nonce",
        "request",
        "job-binding",
        "attempt-binding",
        "request-id",
      ].includes(fault)
    )
      await database.query(
        "UPDATE connector_messages SET payload = $1::jsonb WHERE connector_id = $2 AND direction = 'server' AND sequence = $3",
        [
          JSON.stringify(original.payload),
          owner.connectorId,
          original.sequence,
        ],
      );
    if (fault === "profile") metadata.__qhb_coordination_profile = "unknown";
    if (fault === "missing-profile") delete metadata.__qhb_coordination_profile;
    if (fault === "pair") delete metadata.__qhb_receipt_ack;
    if (fault === "state-as-ack")
      metadata.__qhb_original_response = metadata.__qhb_receipt_ack;
    if (fault === "correlation") original.correlation_id = crypto.randomUUID();
    if (fault === "missing-correlation")
      Reflect.deleteProperty(original, "correlation_id");
    if (fault === "sequence") original.sequence += 1;
    const ack = metadata.__qhb_receipt_ack as {
      sequence: number;
      payload: Record<string, unknown>;
      correlation_id: string;
    };
    if (fault === "ack-order") ack.sequence = original.sequence;
    if (fault === "ack-payload") ack.payload.sequence = 1;
    if (fault === "ack-correlation") ack.correlation_id = crypto.randomUUID();
    await database.query(
      "UPDATE connector_messages SET payload = $1::jsonb WHERE message_id = $2",
      [JSON.stringify(metadata), sync.message_id],
    );
    if (fault === "tombstone-message")
      await database.query(
        "UPDATE connector_messages SET type = 'protocol.error', payload = $1::jsonb WHERE connector_id = $2 AND direction = 'server' AND sequence = $3",
        [
          JSON.stringify({
            code: "MESSAGE_EXPIRED",
            message: "not the server tombstone",
          }),
          owner.connectorId,
          original.sequence,
        ],
      );
    if (fault === "unknown-replacement")
      await database.query(
        "UPDATE connector_messages SET type = 'protocol.error', payload = $1::jsonb WHERE connector_id = $2 AND direction = 'server' AND sequence = $3",
        [
          JSON.stringify({ code: "UNKNOWN", message: "Unknown replacement" }),
          owner.connectorId,
          original.sequence,
        ],
      );
    const snapshot = async () => ({
      connector: await database.query(
        "SELECT * FROM connectors WHERE id = $1",
        [owner.connectorId],
      ),
      messages: await database.query(
        "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
        [owner.connectorId],
      ),
      job: await database.query("SELECT * FROM jobs WHERE id = $1", [
        job.jobId,
      ]),
    });
    const before = await snapshot();
    await expect(store.acceptClientMessage(owner, sync)).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });

  it.each([
    [
      ["durable-receipts-v1", "job-coordination-v1"],
      ["durable-receipts-v1", "job-coordination-v1"],
    ],
    [["durable-receipts-v1"], ["durable-receipts-v1"]],
    [["job-coordination-v1"], undefined],
    [[], undefined],
  ])(
    "negotiates coordination only with both profiles: %j",
    async (capabilities, expected) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      const hello = envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities,
      });
      const accepted = await store.acceptClientMessage(owner, hello);
      expect(accepted.response?.payload.capabilities).toEqual(expected);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 2, {
          connector_id: owner.connectorId,
          last_server_sequence: 1,
        }),
      );
      expect((await store.acceptClientMessage(owner, hello)).response).toEqual(
        accepted.response,
      );
      const saved = await database.query(
        "SELECT capabilities FROM connectors WHERE id = $1",
        [owner.connectorId],
      );
      expect(saved.rows[0]?.capabilities).toEqual([]);
    },
  );

  it("observes a locked read-only running row with immutable state then separate ACK", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      }),
    );
    const lease = crypto.randomUUID();
    const job = await insertConnectedJob(
      owner.connectorId,
      "dispatched",
      new Date(Date.now() + 600_000),
      0,
      lease,
      new Date(Date.now() + 30_000),
    );
    await database.query("UPDATE jobs SET mode = 'read_only' WHERE id = $1", [
      job.jobId,
    ]);
    await store.acceptClientMessage(
      owner,
      envelope("job.claim", 2, {
        job_id: job.jobId,
        attempt: 1,
        lease_id: lease,
      }),
    );
    const before = await database.query(
      "SELECT to_jsonb(jobs) AS job FROM jobs WHERE id = $1",
      [job.jobId],
    );
    const events = await database.query(
      "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence",
      [job.jobId],
    );
    const sync = envelope("job.sync", 3, {
      job_id: job.jobId,
      attempt: 9,
      nonce: crypto.randomUUID(),
    });
    const started = Date.now();
    const accepted = await store.acceptClientMessage(
      owner,
      sync,
      new Date("2099-01-01T00:00:00Z"),
    );
    expect(accepted.replay).toHaveLength(1);
    const state = accepted.replay[0];
    expect(state).toMatchObject({
      type: "job.state",
      correlationId: sync.correlation_id,
      payload: {
        job_id: job.jobId,
        mode: "read_only",
        requested_attempt: 9,
        current_attempt: 1,
        status: "running",
        job_revision: 1,
        cancel_revision: null,
        lease_id: lease,
        request_message_id: sync.message_id,
        request_sequence: 3,
        nonce: sync.payload.nonce,
      },
    });
    expect(accepted.response).toMatchObject({
      type: "ack",
      sequence: (state?.sequence ?? -10) + 1,
      payload: { sequence: 3 },
    });
    const observed = Date.parse(String(state?.payload.observed_at));
    expect(observed).toBeGreaterThanOrEqual(started - 1000);
    expect(observed).toBeLessThanOrEqual(Date.now() + 1000);
    expect(
      Date.parse(String(state?.payload.state_valid_until)) - observed,
    ).toBe(2000);
    expect(
      await database.query(
        "SELECT to_jsonb(jobs) AS job FROM jobs WHERE id = $1",
        [job.jobId],
      ),
    ).toEqual(before);
    expect(
      await database.query(
        "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence",
        [job.jobId],
      ),
    ).toEqual(events);
    await database.query(
      "UPDATE jobs SET revision = 8, connector_id = NULL WHERE id = $1",
      [job.jobId],
    );
    await database.query(
      "UPDATE connectors SET capabilities = '[]' WHERE id = $1",
      [owner.connectorId],
    );
    expect(await store.acceptClientMessage(owner, sync)).toEqual({
      ...accepted,
      duplicate: true,
    });
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });

  it("hard denies a nonnegotiated sync without consuming its sequence", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const before = await database.query(
      "SELECT * FROM connectors WHERE id = $1",
      [owner.connectorId],
    );
    await expect(
      store.acceptClientMessage(
        owner,
        envelope("job.sync", 1, {
          job_id: crypto.randomUUID(),
          attempt: 1,
          nonce: crypto.randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(
      await database.query("SELECT * FROM connectors WHERE id = $1", [
        owner.connectorId,
      ]),
    ).toEqual(before);
    expect(
      (
        await database.query(
          "SELECT * FROM connector_messages WHERE connector_id = $1",
          [owner.connectorId],
        )
      ).rows,
    ).toEqual([]);
  });

  it("cannot manufacture original-offer proof through a client-authored dispatch audit lookalike", async () => {
    const owner = await insertConnector();
    const replacement = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      await expiryAfter(60_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(30_000),
    );
    const leaseId = crypto.randomUUID();
    const repositoryId = (
      await database.query("SELECT repository_id FROM jobs WHERE id = $1", [
        job.jobId,
      ])
    ).rows[0]?.repository_id;
    try {
      await store.acceptClientMessage(
        owner,
        envelope("job.event", 2, {
          job_id: job.jobId,
          attempt: 1,
          event_type: "job.dispatched",
          source: "control-plane",
          payload: {
            owner_id: owner.ownerId,
            connector_id: owner.connectorId,
            repository_id: repositoryId,
            attempt: 1,
            lease_id: leaseId,
            lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
          },
        }),
      );
      expect(
        (
          await database.query(
            "SELECT payload FROM job_events WHERE job_id = $1 AND event_type = 'job.dispatched'",
            [job.jobId],
          )
        ).rows,
      ).toEqual([{ payload: {} }]);
      await database.query(
        "UPDATE jobs SET connector_id = $1, status = 'dispatched' WHERE id = $2",
        [replacement.connectorId, job.jobId],
      );
      const before = (
        await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId])
      ).rows;
      await expect(
        store.acceptClientMessage(
          owner,
          envelope("job.claim", 3, {
            job_id: job.jobId,
            attempt: 1,
            lease_id: leaseId,
          }),
        ),
      ).rejects.toMatchObject({ code: "CLAIM_REJECTED" });
      await expectClientCursor(owner.connectorId, 2);
      expect(
        (await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId]))
          .rows,
      ).toEqual(before);
    } finally {
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it.each([
    "valid",
    "missing-deadline",
    "invalid-deadline",
    "live-deadline",
    "owner",
    "connector",
    "repository",
    "attempt",
    "lease",
    "job",
    "source",
    "legacy",
  ])(
    "requires complete authoritative expired-offer evidence after reassignment: %s",
    async (variant) => {
      const owner = await insertConnector();
      const replacement = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          ...(variant === "legacy"
            ? {}
            : { capabilities: ["durable-receipts-v1"] }),
        }),
      );
      const leaseId = crypto.randomUUID();
      const job = await insertConnectedJob(
        replacement.connectorId,
        "dispatched",
        await expiryAfter(60_000),
        0,
        crypto.randomUUID(),
        await expiryAfter(30_000),
      );
      const repositoryId = (
        await database.query("SELECT repository_id FROM jobs WHERE id = $1", [
          job.jobId,
        ])
      ).rows[0]?.repository_id;
      // A bounded historical audit fixture; the gateway regression separately
      // proves real dispatch authorship, tombstoning and elapsed lease time.
      const proof: Record<string, unknown> = {
        owner_id: owner.ownerId,
        connector_id: owner.connectorId,
        repository_id: repositoryId,
        attempt: 1,
        lease_id: leaseId,
        lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      };
      if (variant === "missing-deadline") delete proof.lease_expires_at;
      if (variant === "invalid-deadline")
        proof.lease_expires_at = "not-a-deadline";
      if (variant === "live-deadline")
        proof.lease_expires_at = new Date(Date.now() + 30_000).toISOString();
      if (variant === "owner") proof.owner_id = "another-owner";
      if (variant === "connector") proof.connector_id = replacement.connectorId;
      if (variant === "repository") proof.repository_id = "another-repository";
      if (variant === "attempt") proof.attempt = 2;
      if (variant === "lease") proof.lease_id = crypto.randomUUID();
      await database.query(
        "INSERT INTO job_events (job_id, sequence, event_type, source, payload) VALUES ($1, 1, 'job.dispatched', $2, $3::jsonb)",
        [
          job.jobId,
          variant === "source" ? "connector" : "control-plane",
          JSON.stringify(proof),
        ],
      );
      const claim = envelope("job.claim", 2, {
        job_id: variant === "job" ? crypto.randomUUID() : job.jobId,
        attempt: 1,
        lease_id: leaseId,
      });
      const snapshot = async () => ({
        jobs: (
          await database.query("SELECT * FROM jobs WHERE id = $1", [job.jobId])
        ).rows,
        audit: (
          await database.query(
            "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence",
            [job.jobId],
          )
        ).rows,
      });
      const before = await snapshot();
      try {
        if (variant === "valid") {
          const result = await store.acceptClientMessage(owner, claim);
          expect(result.replay[0]).toMatchObject({
            type: "protocol.error",
            payload: { code: "CLAIM_REJECTED" },
            correlationId: claim.correlation_id,
          });
          expect(result.response).toMatchObject({
            type: "ack",
            payload: { sequence: 2 },
            correlationId: claim.correlation_id,
          });
          await expectClientCursor(owner.connectorId, 2);
        } else {
          await expect(
            store.acceptClientMessage(owner, claim),
          ).rejects.toMatchObject({ code: "CLAIM_REJECTED" });
          await expectClientCursor(owner.connectorId, 1);
          expect(
            (
              await database.query(
                "SELECT id FROM connector_messages WHERE connector_id = $1 AND message_id = $2",
                [owner.connectorId, claim.message_id],
              )
            ).rows,
          ).toEqual([]);
        }
        expect(await snapshot()).toEqual(before);
      } finally {
        await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
      }
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "uses the stored receipt profile for expired heartbeat replay (durable=%s, current=%s)",
    async (durable, current) => {
      const owner = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 1, {
          connector_id: owner.connectorId,
          last_server_sequence: 0,
          ...(durable ? { capabilities: ["durable-receipts-v1"] } : {}),
        }),
      );
      const expiresAt = await expiryAfter(500);
      const heartbeat = envelope("connector.heartbeat", 2, {}, { expiresAt });
      const accepted = await store.acceptClientMessage(owner, heartbeat);
      await store.acceptClientMessage(
        owner,
        envelope("connector.hello", 3, {
          connector_id: owner.connectorId,
          last_client_sequence: 2,
          last_server_sequence: 2,
          ...(current ? { capabilities: ["durable-receipts-v1"] } : {}),
        }),
      );
      await database.query(
        "UPDATE connector_messages SET expires_at = clock_timestamp() - interval '1 second' WHERE connector_id = $1 AND direction = 'server' AND sequence = 2",
        [owner.connectorId],
      );
      await store.pendingServerMessages(owner, 0);
      await database.query(
        "UPDATE connectors SET health = 'stale', last_heartbeat_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
        [owner.connectorId],
      );
      const snapshot = async () => ({
        connector: (
          await database.query("SELECT * FROM connectors WHERE id = $1", [
            owner.connectorId,
          ])
        ).rows,
        messages: (
          await database.query(
            "SELECT * FROM connector_messages WHERE connector_id = $1 ORDER BY direction, sequence",
            [owner.connectorId],
          )
        ).rows,
      });
      const before = await snapshot();
      await database.query(
        "SELECT pg_sleep_until($1::timestamptz + interval '25 milliseconds')",
        [expiresAt],
      );
      if (durable) {
        const replay = await store.acceptClientMessage(owner, heartbeat);
        expect(replay).toMatchObject({
          duplicate: true,
          response: {
            type: "ack",
            sequence: 2,
            payload: { sequence: 2 },
            correlationId: heartbeat.correlation_id,
          },
        });
        expect(replay.response?.messageId).not.toBe(
          accepted.response?.messageId,
        );
        expect((await snapshot()).connector).toEqual(before.connector);
      } else {
        await expect(
          store.acceptClientMessage(owner, heartbeat),
        ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });
        expect(await snapshot()).toEqual(before);
      }
    },
  );

  it("keeps approval payload expiry immutable when an offline delivery lease is renewed", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      await expiryAfter(60_000),
      1,
      null,
      null,
    );
    const approvalId = crypto.randomUUID();
    const message = envelope(
      "approval.requested",
      2,
      {
        approval_id: approvalId,
        job_id: job.jobId,
        attempt: 1,
        job_revision: 1,
        action_summary: "Run tests",
        impact_summary: "Test execution",
        risk_class: "approval_required",
        action_fingerprint: `sha256:${"a".repeat(64)}`,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        sentAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() + 50_000),
      },
    );
    const accepted = await store.acceptClientMessage(owner, message);
    expect(accepted.replay[0]?.payload.code).toBe("EVENT_REJECTED");
    expect(accepted.response?.payload).toEqual({ sequence: 2 });
    expect(
      (
        await database.query("SELECT id FROM approvals WHERE id = $1", [
          approvalId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await database.query(
          "SELECT revision, status FROM jobs WHERE id = $1",
          [job.jobId],
        )
      ).rows,
    ).toEqual([{ revision: 0, status: "running" }]);
    expect(
      (
        await store.acceptClientMessage(
          owner,
          envelope("connector.heartbeat", 3, {}),
        )
      ).response?.payload,
    ).toEqual({ sequence: 3 });
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });
  it("does not consume unknown database failures in the negotiated business savepoint", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      }),
    );
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      await expiryAfter(60_000),
      1,
      null,
      null,
    );
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const fn = `receipt_failure_${suffix}`;
    await database.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id = '${job.jobId}'::uuid THEN RAISE EXCEPTION 'fixture failure' USING ERRCODE = 'XX000'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
    );
    try {
      await expect(
        store.acceptClientMessage(
          owner,
          envelope("job.event", 2, {
            job_id: job.jobId,
            attempt: 1,
            event_type: "progress",
            payload: { stage: "testing" },
            source: "harness",
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await database.query("SELECT revision FROM jobs WHERE id = $1", [
            job.jobId,
          ])
        ).rows,
      ).toEqual([{ revision: 0 }]);
      expect(
        (
          await database.query(
            "SELECT last_client_sequence FROM connectors WHERE id = $1",
            [owner.connectorId],
          )
        ).rows[0]?.last_client_sequence,
      ).toBe("1");
      expect(
        (
          await database.query(
            "SELECT sequence FROM connector_messages WHERE connector_id = $1 AND direction = 'client'",
            [owner.connectorId],
          )
        ).rows,
      ).toEqual([{ sequence: "1" }]);
    } finally {
      await database.query(
        `DROP TRIGGER ${fn} ON job_events; DROP FUNCTION ${fn}();`,
      );
      await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
    expect(
      (
        await store.acceptClientMessage(
          owner,
          envelope("connector.heartbeat", 2, {}),
        )
      ).response?.payload,
    ).toEqual({ sequence: 2 });
  });
  it("binds renewal and response semantics to each receipt across capability changes", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const legacy = envelope("connector.hello", 1, {
      connector_id: owner.connectorId,
      last_server_sequence: 0,
    });
    const legacyWelcome = await store.acceptClientMessage(owner, legacy);
    expect(legacyWelcome.response?.payload).not.toHaveProperty("capabilities");
    const capable = envelope("connector.hello", 2, {
      connector_id: owner.connectorId,
      last_client_sequence: 1,
      last_server_sequence: 1,
      capabilities: ["durable-receipts-v1"],
    });
    await store.acceptClientMessage(owner, capable);
    await expect(
      store.acceptClientMessage(owner, {
        ...legacy,
        expires_at: new Date(Date.now() + 45_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });
    expect((await store.acceptClientMessage(owner, legacy)).response).toEqual(
      legacyWelcome.response,
    );
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 3, {
        connector_id: owner.connectorId,
        last_client_sequence: 2,
        last_server_sequence: 2,
      }),
    );
    expect(
      (
        await store.acceptClientMessage(owner, {
          ...capable,
          expires_at: new Date(Date.now() + 45_000).toISOString(),
        })
      ).response?.payload.capabilities,
    ).toEqual(["durable-receipts-v1"]);
    expect(
      (
        await store.acceptClientMessage(
          owner,
          envelope("ack", 4, { sequence: 1 }),
        )
      ).response,
    ).toBeNull();
  });

  it("rolls back partial negotiated business writes before committing an expired receipt", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      }),
    );
    const expiry = await expiryAfter(500);
    const job = await insertConnectedJob(
      owner.connectorId,
      "running",
      expiry,
      1,
      null,
      null,
    );
    const event = envelope("job.event", 2, {
      job_id: job.jobId,
      attempt: 1,
      event_type: "progress",
      payload: { stage: "testing" },
      source: "harness",
    });
    const gate = await createWriteBoundaryGate("job_events", expiry);
    try {
      const accepted = store.acceptClientMessage(owner, event);
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      const result = await accepted;
      expect(result.replay[0]?.payload.code).toBe("EVENT_REJECTED");
      expect(result.response?.payload).toEqual({ sequence: 2 });
      expect(
        (
          await database.query(
            "SELECT revision, status FROM jobs WHERE id = $1",
            [job.jobId],
          )
        ).rows,
      ).toEqual([{ revision: 0, status: "running" }]);
      expect(
        (
          await database.query(
            "SELECT id FROM job_events WHERE job_id = $1 AND source = 'harness'",
            [job.jobId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await gate.dispose();
    }
    await expect(
      store.acceptClientMessage(
        owner,
        envelope("job.event", 3, {
          ...event.payload,
          job_id: crypto.randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_REJECTED" });
    expect(
      (
        await database.query(
          "SELECT last_client_sequence FROM connectors WHERE id = $1",
          [owner.connectorId],
        )
      ).rows[0]?.last_client_sequence,
    ).toBe("2");
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });
  it("negotiates durable receipts, renews only delivery expiry, and receipts client ACKs", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const hello = envelope(
      "connector.hello",
      1,
      {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      },
      {
        sentAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() + 50_000),
      },
    );
    const welcome = await store.acceptClientMessage(owner, hello);
    expect(welcome.response?.payload.capabilities).toEqual([
      "durable-receipts-v1",
    ]);
    const renewed = {
      ...hello,
      expires_at: new Date(Date.now() + 55_000).toISOString(),
    };
    expect((await store.acceptClientMessage(owner, renewed)).duplicate).toBe(
      true,
    );
    for (const modified of [
      { ...renewed, message_id: crypto.randomUUID() },
      { ...renewed, sequence: 2 },
      { ...renewed, correlation_id: crypto.randomUUID() },
      { ...renewed, sent_at: renewed.sent_at.replace("Z", "0001Z") },
      {
        ...renewed,
        payload: {
          ...renewed.payload,
          capabilities: ["durable-receipts-v1", "changed"],
        },
      },
    ]) {
      await expect(
        store.acceptClientMessage(owner, modified),
      ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });
    }
    await expect(
      store.acceptClientMessage(owner, {
        ...renewed,
        sent_at: new Date(Date.now() - 119_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });
    if (welcome.response === null) throw new Error("fixture welcome missing");
    const ack = envelope("ack", 2, { sequence: welcome.response.sequence });
    const receipt = await store.acceptClientMessage(owner, ack);
    expect(receipt.response).toMatchObject({
      type: "ack",
      payload: { sequence: 2 },
      correlationId: ack.correlation_id,
    });
    expect((await store.acceptClientMessage(owner, ack)).response).toEqual(
      receipt.response,
    );
    await expect(
      store.acceptClientMessage(
        owner,
        envelope(
          "connector.heartbeat",
          3,
          {},
          {
            expiresAt: new Date(Date.now() + 120_000),
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });
  });

  it("consumes an authorized expired claim without business effects and replays outcome before ACK", async () => {
    const owner = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    await store.acceptClientMessage(
      owner,
      envelope("connector.hello", 1, {
        connector_id: owner.connectorId,
        last_server_sequence: 0,
        capabilities: ["durable-receipts-v1"],
      }),
    );
    const leaseId = crypto.randomUUID();
    const job = await insertConnectedJob(
      owner.connectorId,
      "dispatched",
      new Date(Date.now() + 60_000),
      0,
      leaseId,
      new Date(Date.now() - 1_000),
    );
    const claim = envelope("job.claim", 2, {
      job_id: job.jobId,
      attempt: 1,
      lease_id: leaseId,
    });
    const result = await store.acceptClientMessage(owner, claim);
    expect(result.replay).toHaveLength(1);
    expect(result.replay[0]).toMatchObject({
      type: "protocol.error",
      payload: { code: "CLAIM_REJECTED" },
      correlationId: claim.correlation_id,
    });
    expect(result.response).toMatchObject({
      type: "ack",
      payload: { sequence: 2 },
      correlationId: claim.correlation_id,
    });
    expect((result.replay[0]?.sequence ?? 0) + 1).toBe(
      result.response?.sequence,
    );
    const rows = await database.query(
      "SELECT status, attempt, revision FROM jobs WHERE id = $1",
      [job.jobId],
    );
    expect(rows.rows).toEqual([
      { status: "dispatched", attempt: 0, revision: 0 },
    ]);
    expect(
      (
        await database.query(
          "SELECT id FROM job_events WHERE job_id = $1 AND source = 'connector'",
          [job.jobId],
        )
      ).rows,
    ).toHaveLength(0);
    const duplicate = await store.acceptClientMessage(owner, claim);
    expect(duplicate).toEqual({ ...result, duplicate: true });
    await database.query(
      "UPDATE connector_messages SET expires_at = clock_timestamp() - interval '1 second' WHERE connector_id = $1 AND direction = 'server' AND sequence > 1",
      [owner.connectorId],
    );
    await store.pendingServerMessages(owner, 1);
    const restored = await store.acceptClientMessage(owner, claim);
    expect(
      restored.replay.map(({ type, sequence, payload }) => ({
        type,
        sequence,
        payload,
      })),
    ).toEqual(
      result.replay.map(({ type, sequence, payload }) => ({
        type,
        sequence,
        payload,
      })),
    );
    expect(restored.response).toMatchObject({
      type: "ack",
      sequence: result.response?.sequence,
      payload: { sequence: 2 },
      correlationId: claim.correlation_id,
    });
    expect(
      (
        await store.acceptClientMessage(
          owner,
          envelope("connector.heartbeat", 3, {}),
        )
      ).response?.payload,
    ).toEqual({ sequence: 3 });
    await database.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
  });
  it("looks up only the stored Connector credential identity", async () => {
    const store = new PostgresConnectorStore(database.client);
    await expect(store.findByCredentialId(CREDENTIAL_ID)).resolves.toEqual({
      credentialId: CREDENTIAL_ID,
      credentialHash: "scrypt$fixture",
      ownerId: OWNER_ID,
      connectorId: CONNECTOR_ID,
      protocolVersion: "1.0",
    });
    await expect(store.findByCredentialId("unknown")).resolves.toBeNull();
  });

  it("dispatches transactionally without persisting the plaintext request", async () => {
    const repository = new JobRepository(database.client);
    const job = await repository.createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId: REPOSITORY_ID,
      requestCiphertext: cipher.encrypt(REQUEST),
      requestDigest: `sha256:${"5".repeat(64)}`,
    });
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(identity);
    if (offer === null) throw new Error("expected a durable job offer");
    expect(offer.type).toBe("job.offer");
    expect(storedServerMessageContainsPlaintextRequest(offer)).toBe(false);
    expect(JSON.stringify(offer)).not.toContain(REQUEST);

    const stored = await database.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text
         FROM connector_messages
        WHERE connector_id = $1 AND type = 'job.offer'`,
      [CONNECTOR_ID],
    );
    expect(stored.rows[0]?.payload_text).not.toContain(REQUEST);

    const materialized = await store.materializeServerMessage(offer, cipher);
    expect(materialized).toMatchObject({
      type: "job.offer",
      payload: { job_id: job.jobId, request: REQUEST },
    });
  });

  it("caps an offer lease at the job expiry", async () => {
    const repositoryId = `offer-expiry-cap-${crypto.randomUUID()}`;
    const job = await createJob(repositoryId, "Offer expiry cap");
    const now = new Date();
    const jobExpiresAt = new Date(String(await expiryAfter(5_000)));
    await database.query("UPDATE jobs SET expires_at = $1 WHERE id = $2", [
      jobExpiresAt,
      job.jobId,
    ]);

    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(identity, now);

    expect(offer?.expiresAt).toEqual(jobExpiresAt);
    const stored = await database.query<{
      lease_expires_at: string;
      expires_at: string;
    }>("SELECT lease_expires_at, expires_at FROM jobs WHERE id = $1", [
      job.jobId,
    ]);
    expect(new Date(stored.rows[0]?.lease_expires_at ?? 0)).toEqual(
      jobExpiresAt,
    );
    expect(
      new Date(stored.rows[0]?.lease_expires_at ?? 0).getTime(),
    ).toBeLessThanOrEqual(new Date(stored.rows[0]?.expires_at ?? 0).getTime());
    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("does not dispatch a job that expires while waiting for the connector row lock", async () => {
    const testIdentity = await insertConnector();
    const job = await createJob(
      `dispatch-expiry-lock-${crypto.randomUUID()}`,
      "Dispatch expiry lock",
    );
    const callerNow = new Date();
    const expiresAt = await expiryAfter(2_000);
    await database.query("UPDATE jobs SET expires_at = $1 WHERE id = $2", [
      expiresAt,
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const holder = holdConnectorRowUntil(testIdentity.connectorId, expiresAt);
    await holder.ready;
    const dispatch = store.dispatchNext(testIdentity, callerNow);
    try {
      await waitForRowLockWaiter("connectors");
    } finally {
      holder.releaseToExpiry();
    }
    await holder.done;

    await expect(dispatch).resolves.toBeNull();
    await expect(
      database.query<{
        status: string;
        connector_id: string | null;
        lease_id: string | null;
        lease_expires_at: string | null;
        revision: number;
        attempt: number;
      }>(
        `SELECT status, connector_id, lease_id, lease_expires_at, revision, attempt
           FROM jobs
          WHERE id = $1`,
        [job.jobId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "queued",
          connector_id: null,
          lease_id: null,
          lease_expires_at: null,
          revision: 0,
          attempt: 0,
        },
      ],
    });
    await expect(
      database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_events WHERE job_id = $1",
        [job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server' AND type = 'job.offer'`,
        [testIdentity.connectorId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expectClientCursor(testIdentity.connectorId, 0);
    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("uses PostgreSQL time for concurrency admission under a future-skewed caller clock", async () => {
    const testIdentity = await insertConnector();
    const repositoryId = `dispatch-clock-skew-${crypto.randomUUID()}`;
    const repository = new JobRepository(database.client);
    const queued = await createJob(repositoryId, "Queued behind a live lease");
    const active = await repository.createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: cipher.encrypt("Already dispatched"),
      requestDigest: `sha256:${crypto.randomUUID().replaceAll("-", "")}`,
    });
    const liveLease = await expiryAfter(60_000);
    const jobExpiry = await expiryAfter(10 * 60_000);
    await database.query(
      `UPDATE jobs
          SET connector_id = $1,
              status = 'dispatched'::job_status,
              lease_id = $2,
              lease_expires_at = $3,
              expires_at = $4
        WHERE id = $5`,
      [
        testIdentity.connectorId,
        crypto.randomUUID(),
        liveLease,
        jobExpiry,
        active.jobId,
      ],
    );

    const futureSkewedNow = new Date(Date.now() + 5 * 60_000);
    const store = new PostgresConnectorStore(database.client);
    await expect(
      store.dispatchNext(testIdentity, futureSkewedNow),
    ).resolves.toBeNull();
    await expect(repository.get(queued.jobId)).resolves.toMatchObject({
      status: "queued",
      attempt: 0,
      revision: 0,
    });

    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id IN ($1, $2)",
      [active.jobId, queued.jobId],
    );
  });

  it.each([
    ["future", new Date("2100-01-01T00:00:00.000Z")],
    ["past", new Date("2000-01-01T00:00:00.000Z")],
  ] as const)(
    "uses PostgreSQL time for client envelope expiry under a %s-skewed caller clock",
    async (_case, callerNow) => {
      const testIdentity = await insertConnector();
      const sentAt = new Date();
      const message = envelope("connector.heartbeat", 1, {}, { sentAt });
      const store = new PostgresConnectorStore(database.client);

      await expect(
        store.acceptClientMessage(testIdentity, message, callerNow),
      ).resolves.toMatchObject({
        duplicate: false,
        response: { type: "ack" },
      });
    },
  );

  it.each([
    ["future", new Date("2100-01-01T00:00:00.000Z")],
    ["past", new Date("2000-01-01T00:00:00.000Z")],
  ] as const)(
    "uses PostgreSQL time for replay expiry under a %s-skewed caller clock",
    async (_case, callerNow) => {
      const testIdentity = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      const expired = await store.enqueueServer(
        testIdentity,
        "ack",
        { sequence: 1 },
        new Date(Date.now() - 1_000),
      );

      await expect(
        store.pendingServerMessages(testIdentity, 0, callerNow),
      ).resolves.toMatchObject([
        {
          sequence: expired.sequence,
          type: "protocol.error",
          payload: { code: "MESSAGE_EXPIRED" },
        },
      ]);
    },
  );

  it.each([
    ["future", new Date("2100-01-01T00:00:00.000Z")],
    ["past", new Date("2000-01-01T00:00:00.000Z")],
  ] as const)(
    "uses PostgreSQL time for offer materialization under a %s-skewed caller clock",
    async (_case, callerNow) => {
      const testIdentity = await insertConnector();
      const repositoryId = `repo-mat-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const job = await createJob(repositoryId, "Materialize clock skew");
      const store = new PostgresConnectorStore(database.client);
      const offer = await store.dispatchNext(testIdentity);
      if (offer === null) throw new Error("expected a job offer");

      await expect(
        store.materializeServerMessage(offer, cipher, callerNow),
      ).resolves.toMatchObject({
        type: "job.offer",
        payload: { job_id: job.jobId, request: "Materialize clock skew" },
      });
    },
  );

  it("does not decrypt an offer already expired in PostgreSQL under a past caller clock", async () => {
    const testIdentity = await insertConnector();
    const repositoryId = `repo-mat-exp-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const job = await createJob(repositoryId, "DB expired offer");
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(testIdentity);
    if (offer === null) throw new Error("expected a job offer");
    await database.query(
      `UPDATE jobs
          SET expires_at = now() - interval '1 second',
              lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [job.jobId],
    );
    await database.query(
      `UPDATE connector_messages
          SET expires_at = now() - interval '1 second'
        WHERE connector_id = $1 AND sequence = $2`,
      [testIdentity.connectorId, offer.sequence],
    );
    let decryptCalls = 0;

    await expect(
      store.materializeServerMessage(
        offer,
        {
          decrypt: async () => {
            decryptCalls += 1;
            return "must not be returned";
          },
        },
        new Date("2000-01-01T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_EXPIRED" });
    expect(decryptCalls).toBe(0);
  });

  it.each([
    ["future", new Date("2100-01-01T00:00:00.000Z")],
    ["past", new Date("2000-01-01T00:00:00.000Z")],
  ] as const)(
    "uses PostgreSQL time for health thresholds under a %s-skewed caller clock",
    async (_case, callerNow) => {
      const testIdentity = await insertConnector();
      await database.query(
        `UPDATE connectors
            SET health = 'fresh'::connector_health,
                last_heartbeat_at = now() - interval '1 minute'
          WHERE id = $1`,
        [testIdentity.connectorId],
      );

      await new PostgresConnectorStore(database.client).refreshHealth(
        callerNow,
      );

      await expect(
        database.query<{ health: string }>(
          "SELECT health FROM connectors WHERE id = $1",
          [testIdentity.connectorId],
        ),
      ).resolves.toMatchObject({ rows: [{ health: "offline" }] });
    },
  );

  it("does not let an expired active job consume a live dispatch slot", async () => {
    const testIdentity = await insertConnector();
    const repositoryId = `repo-exp-cap-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const active = await createJob(repositoryId, "Expired active job");
    const queued = await new JobRepository(database.client).createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: cipher.encrypt("Live queued job"),
      requestDigest: `sha256:${"d".repeat(64)}`,
    });
    await database.query(
      `UPDATE jobs
          SET status = 'running'::job_status,
              connector_id = $1,
              attempt = 1,
              expires_at = now() - interval '1 second'
        WHERE id = $2`,
      [testIdentity.connectorId, active.jobId],
    );

    const offer = await new PostgresConnectorStore(
      database.client,
    ).dispatchNext(testIdentity);

    expect(offer?.payload.job_id).toBe(queued.jobId);
  });

  it("deduplicates exact client messages and rejects gaps or modified replay", async () => {
    const store = new PostgresConnectorStore(database.client);
    const hello = envelope("connector.hello", 1, {
      connector_id: CONNECTOR_ID,
      connector_version: "integration-1.0",
      capabilities: ["tests"],
      last_server_sequence: 0,
      last_client_sequence: 0,
    });
    const accepted = await store.acceptClientMessage(identity, hello);
    expect(accepted.duplicate).toBe(false);
    expect(accepted.response?.type).toBe("connector.welcome");
    expect(accepted.response?.payload.server_sequence).toBe(
      accepted.response?.sequence,
    );

    const duplicate = await store.acceptClientMessage(identity, hello);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.response?.messageId).toBe(accepted.response?.messageId);

    const equivalentTimestampDuplicate = ConnectorClientMessageSchema.parse({
      ...hello,
      sent_at: hello.sent_at.replace(/Z$/, "+00:00"),
      expires_at: hello.expires_at.replace(/Z$/, "+00:00"),
    });
    await expect(
      store.acceptClientMessage(identity, equivalentTimestampDuplicate),
    ).resolves.toMatchObject({
      duplicate: true,
      response: { messageId: accepted.response?.messageId },
    });
    const changedSubMillisecondTimestamp = ConnectorClientMessageSchema.parse({
      ...hello,
      sent_at: hello.sent_at.replace(/Z$/, "001Z"),
    });
    await expectStoreError(
      store.acceptClientMessage(identity, changedSubMillisecondTimestamp),
      "CLIENT_REPLAY_MISMATCH",
    );
    const responseCount = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM connector_messages
        WHERE connector_id = $1
          AND direction = 'server'
          AND correlation_id = $2`,
      [CONNECTOR_ID, hello.correlation_id],
    );
    expect(responseCount.rows[0]?.count).toBe("1");

    const modified = {
      ...hello,
      correlation_id: crypto.randomUUID(),
    } as ConnectorClientMessage;
    await expectStoreError(
      store.acceptClientMessage(identity, modified),
      "CLIENT_REPLAY_MISMATCH",
    );

    const gap = envelope("connector.heartbeat", 3, {});
    await expectStoreError(
      store.acceptClientMessage(identity, gap),
      "CLIENT_SEQUENCE_GAP",
    );
  });

  it("replays an exact expired negotiated client message without reapplying it", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const expiresAt = await expiryAfter(250);
    const sentAt = new Date(Date.parse(String(expiresAt)) - 60_000);
    const hello = envelope(
      "connector.hello",
      1,
      {
        connector_id: testIdentity.connectorId,
        connector_version: "integration-1.0",
        capabilities: ["tests", "durable-receipts-v1"],
        last_server_sequence: 0,
        last_client_sequence: 0,
      },
      {
        sentAt,
        expiresAt,
      },
    );
    const accepted = await store.acceptClientMessage(testIdentity, hello);
    if (accepted.response === null) throw new Error("expected a welcome");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    await database.query(
      "SELECT pg_sleep_until($1::timestamptz + interval '25 milliseconds')",
      [expiresAt],
    );

    const replayed = await store.acceptClientMessage(testIdentity, hello);
    if (replayed.response === null) throw new Error("expected replay response");
    expect(replayed).toMatchObject({
      duplicate: true,
      response: {
        sequence: accepted.response.sequence,
        type: "connector.welcome",
        payload: accepted.response.payload,
      },
    });
    expect(replayed.response.messageId).not.toBe(accepted.response.messageId);
    await expectClientCursor(testIdentity.connectorId, 1);
    await expect(
      database.query<{ client_count: string; server_count: string }>(
        `SELECT count(*) FILTER (WHERE direction = 'client')::text AS client_count,
                count(*) FILTER (WHERE direction = 'server')::text AS server_count
           FROM connector_messages
          WHERE connector_id = $1`,
        [testIdentity.connectorId],
      ),
    ).resolves.toMatchObject({
      rows: [{ client_count: "1", server_count: "1" }],
    });

    await expectStoreError(
      store.acceptClientMessage(testIdentity, {
        ...hello,
        correlation_id: crypto.randomUUID(),
      }),
      "CLIENT_REPLAY_MISMATCH",
    );
    const freshExpired = envelope(
      "connector.heartbeat",
      2,
      {},
      {
        sentAt,
        expiresAt,
      },
    );
    await expectStoreError(
      store.acceptClientMessage(testIdentity, freshExpired),
      "CLIENT_REPLAY_MISMATCH",
    );
  });

  it("restores the response identified by durable sequence metadata without correlation scans", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const correlationId = crypto.randomUUID();
    for (let index = 0; index < 128; index += 1) {
      await store.enqueueServer(
        testIdentity,
        "ack",
        { sequence: 1 },
        new Date(Date.now() + 60_000),
        correlationId,
      );
    }
    const heartbeat = envelope("connector.heartbeat", 1, {}, { correlationId });
    const accepted = await store.acceptClientMessage(testIdentity, heartbeat);
    if (accepted.response === null) throw new Error("expected an ACK");

    await expect(
      store.acceptClientMessage(testIdentity, heartbeat),
    ).resolves.toMatchObject({
      duplicate: true,
      response: {
        messageId: accepted.response.messageId,
        sequence: accepted.response.sequence,
      },
    });
  });

  it("restores a tombstoned connector welcome for an exact duplicate hello", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const hello = envelope("connector.hello", 1, {
      connector_id: testIdentity.connectorId,
      connector_version: "integration-1.0",
      capabilities: ["tests"],
      last_server_sequence: 0,
      last_client_sequence: 0,
    });
    const accepted = await store.acceptClientMessage(testIdentity, hello);
    if (accepted.response === null) throw new Error("expected a welcome");
    expect(accepted.response.type).toBe("connector.welcome");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );

    const maintained = await store.pendingServerMessages(
      testIdentity,
      0,
      new Date(),
    );
    expect(maintained).toMatchObject([
      {
        sequence: accepted.response.sequence,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      },
    ]);

    const retryNow = new Date();
    const retried = await store.acceptClientMessage(
      testIdentity,
      hello,
      retryNow,
    );
    if (retried.response === null)
      throw new Error("expected a retried welcome");
    expect(retried).toMatchObject({ duplicate: true });
    expect(retried.response).toMatchObject({
      type: "connector.welcome",
      sequence: accepted.response.sequence,
      payload: accepted.response.payload,
    });
    expect(retried.response.messageId).not.toBe(accepted.response.messageId);
    expect(retried.response.messageId).not.toBe(maintained[0]?.messageId);
    expect(retried.response.expiresAt.getTime()).toBeGreaterThan(
      retryNow.getTime(),
    );

    await expectClientCursor(testIdentity.connectorId, 1);
    await expect(
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server'`,
        [testIdentity.connectorId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("rejects incompatible tombstone response metadata without mutating the tombstone", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const hello = envelope("connector.hello", 1, {
      connector_id: testIdentity.connectorId,
      connector_version: "integration-1.0",
      capabilities: ["tests"],
      last_server_sequence: 0,
      last_client_sequence: 0,
    });
    const accepted = await store.acceptClientMessage(testIdentity, hello);
    if (accepted.response === null) throw new Error("expected a welcome");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    const maintained = await store.pendingServerMessages(
      testIdentity,
      0,
      new Date(),
    );
    const tombstone = maintained[0];
    if (tombstone === undefined) throw new Error("expected a tombstone");
    expect(tombstone).toMatchObject({
      type: "protocol.error",
      sequence: accepted.response.sequence,
      payload: { code: "MESSAGE_EXPIRED" },
    });

    await database.query(
      `UPDATE connector_messages
          SET payload = jsonb_set(
            payload,
            '{__qhb_original_response,type}',
            '"protocol.error"'::jsonb
          )
        WHERE connector_id = $1 AND direction = 'client' AND message_id = $2`,
      [testIdentity.connectorId, hello.message_id],
    );

    await expectStoreError(
      store.acceptClientMessage(testIdentity, hello, new Date()),
      "INTERNAL",
    );
    await expect(
      database.query<{
        message_id: string;
        sequence: number;
        type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT message_id, sequence::integer AS sequence, type, payload
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server'
            AND sequence = $2`,
        [testIdentity.connectorId, tombstone.sequence],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          message_id: tombstone.messageId,
          sequence: tombstone.sequence,
          type: "protocol.error",
          payload: {
            code: "MESSAGE_EXPIRED",
            message: "A Connector message expired before delivery.",
          },
        },
      ],
    });
  });

  it("restores a legacy tombstoned response without stored correlation metadata", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const hello = envelope("connector.hello", 1, {
      connector_id: testIdentity.connectorId,
      connector_version: "integration-1.0",
      capabilities: ["tests"],
      last_server_sequence: 0,
      last_client_sequence: 0,
    });
    const accepted = await store.acceptClientMessage(testIdentity, hello);
    if (accepted.response === null) throw new Error("expected a welcome");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    const maintained = await store.pendingServerMessages(
      testIdentity,
      0,
      new Date(),
    );
    const tombstone = maintained[0];
    if (tombstone === undefined) throw new Error("expected a tombstone");
    expect(tombstone).toMatchObject({
      type: "protocol.error",
      sequence: accepted.response.sequence,
      correlationId: hello.correlation_id,
      payload: { code: "MESSAGE_EXPIRED" },
    });

    await database.query(
      `UPDATE connector_messages
          SET payload = payload #- '{__qhb_original_response,correlation_id}'
        WHERE connector_id = $1 AND direction = 'client' AND message_id = $2`,
      [testIdentity.connectorId, hello.message_id],
    );
    const legacyRows = await database.query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT payload->'__qhb_original_response' AS metadata
         FROM connector_messages
        WHERE connector_id = $1 AND direction = 'client' AND message_id = $2`,
      [testIdentity.connectorId, hello.message_id],
    );
    expect(legacyRows.rows[0]?.metadata).toMatchObject({
      type: "connector.welcome",
      payload: accepted.response.payload,
      sequence: accepted.response.sequence,
    });
    expect(legacyRows.rows[0]?.metadata).not.toHaveProperty("correlation_id");

    const retried = await store.acceptClientMessage(
      testIdentity,
      hello,
      new Date(),
    );
    if (retried.response === null) {
      throw new Error("expected a restored legacy welcome");
    }
    expect(retried).toMatchObject({ duplicate: true });
    expect(retried.response).toMatchObject({
      type: "connector.welcome",
      sequence: accepted.response.sequence,
      payload: accepted.response.payload,
    });
    expect(retried.response.messageId).not.toBe(accepted.response.messageId);
  });

  it("rejects tombstoned response metadata with an omitted type", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `retry-invalid-metadata-${crypto.randomUUID()}`,
      "Reject invalid response metadata",
    );
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(testIdentity);
    if (offer === null) throw new Error("expected a job offer");
    const claim = envelope("job.claim", 1, {
      job_id: job.jobId,
      attempt: offer.payload.attempt as number,
      lease_id: offer.payload.lease_id as string,
    });
    const dispatched = await repository.get(job.jobId);
    if (dispatched === null) throw new Error("expected a dispatched job");
    await expect(
      repository.cancelAtomically({
        ownerId: OWNER_ID,
        jobId: job.jobId,
        expectedRevision: dispatched.revision,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const accepted = await store.acceptClientMessage(testIdentity, claim);
    if (accepted.response === null) {
      throw new Error("expected a CLAIM_REJECTED response");
    }
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    const maintained = await store.pendingServerMessages(
      testIdentity,
      0,
      new Date(),
    );
    const tombstone = maintained.find(
      (message) => message.sequence === accepted.response?.sequence,
    );
    if (tombstone === undefined) throw new Error("expected a tombstone");
    await database.query(
      `UPDATE connector_messages
          SET payload = payload #- '{__qhb_original_response,type}'
        WHERE connector_id = $1 AND direction = 'client' AND message_id = $2`,
      [testIdentity.connectorId, claim.message_id],
    );

    await expectStoreError(
      store.acceptClientMessage(testIdentity, claim, new Date()),
      "INTERNAL",
    );
    await expect(
      database.query<{
        message_id: string;
        sequence: number;
        type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT message_id, sequence::integer AS sequence, type, payload
           FROM connector_messages
          WHERE connector_id = $1 AND sequence = $2 AND direction = 'server'`,
        [testIdentity.connectorId, tombstone.sequence],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          message_id: tombstone.messageId,
          sequence: tombstone.sequence,
          type: "protocol.error",
          payload: { code: "MESSAGE_EXPIRED" },
        },
      ],
    });
  });

  it("validates ACK ownership and keeps a valid duplicate idempotent", async () => {
    const ackIdentity = await insertConnector();
    const otherIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const serverMessage = await store.enqueueServer(
      ackIdentity,
      "ack",
      { sequence: 1 },
      new Date("2030-01-02T03:05:05.000Z"),
    );
    const now = new Date("2030-01-02T03:04:05.000Z");
    const ack = envelope(
      "ack",
      1,
      { sequence: serverMessage.sequence },
      { sentAt: now },
    );

    await expect(
      store.acceptClientMessage(ackIdentity, ack, now),
    ).resolves.toMatchObject({ duplicate: false, response: null });
    await expect(
      store.acceptClientMessage(ackIdentity, ack, now),
    ).resolves.toMatchObject({ duplicate: true, response: null });

    for (const [
      identityForAck,
      clientSequence,
      acknowledgedSequence,
      cursor,
    ] of [
      [ackIdentity, 2, serverMessage.sequence + 1, 1],
      [ackIdentity, 2, 999, 1],
      [otherIdentity, 1, serverMessage.sequence, 0],
    ] as const) {
      const invalidAck = envelope(
        "ack",
        clientSequence,
        { sequence: acknowledgedSequence },
        { sentAt: now },
      );
      await expectStoreError(
        store.acceptClientMessage(identityForAck, invalidAck, now),
        "CLIENT_REPLAY_MISMATCH",
      );
      await expectClientCursor(identityForAck.connectorId, cursor);
    }
  });

  it("advances a non-heartbeat client sequence without refreshing durable health", async () => {
    const testIdentity = await insertConnector();
    const previousHeartbeat = new Date("2030-01-02T03:03:40.000Z");
    const now = new Date("2030-01-02T03:04:05.000Z");
    await database.query(
      `UPDATE connectors
          SET health = 'stale'::connector_health,
              last_heartbeat_at = $2
        WHERE id = $1`,
      [testIdentity.connectorId, previousHeartbeat],
    );
    const store = new PostgresConnectorStore(database.client);
    const serverMessage = await store.enqueueServer(
      testIdentity,
      "ack",
      { sequence: 1 },
      new Date(now.getTime() + 60_000),
    );
    const ack = envelope(
      "ack",
      1,
      { sequence: serverMessage.sequence },
      { sentAt: now },
    );

    await expect(
      store.acceptClientMessage(testIdentity, ack, now),
    ).resolves.toMatchObject({ duplicate: false, response: null });

    const durable = await database.query<{
      last_client_sequence: number;
      last_heartbeat_at: string;
      health: string;
    }>(
      `SELECT last_client_sequence, last_heartbeat_at::text, health
         FROM connectors
        WHERE id = $1`,
      [testIdentity.connectorId],
    );
    expect(Number(durable.rows[0]?.last_client_sequence)).toBe(1);
    expect(new Date(durable.rows[0]?.last_heartbeat_at ?? 0)).toEqual(
      previousHeartbeat,
    );
    expect(durable.rows[0]?.health).toBe("stale");
  });

  it("refreshes stale liveness for an exact duplicate heartbeat without replaying it", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const sentAt = new Date();
    const heartbeat = envelope("connector.heartbeat", 1, {}, { sentAt });
    const accepted = await store.acceptClientMessage(
      testIdentity,
      heartbeat,
      sentAt,
    );
    expect(accepted).toMatchObject({
      duplicate: false,
      response: { type: "ack", payload: { sequence: 1 } },
    });

    const staleAt = new Date(Date.now() - 60_000);
    await database.query(
      `UPDATE connectors
          SET health = 'stale'::connector_health,
              last_heartbeat_at = $2,
              updated_at = $2
        WHERE id = $1`,
      [testIdentity.connectorId, staleAt],
    );

    const duplicate = await store.acceptClientMessage(
      testIdentity,
      heartbeat,
      new Date(),
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      response: {
        messageId: accepted.response?.messageId,
        sequence: accepted.response?.sequence,
        type: "ack",
      },
    });

    const durable = await database.query<{
      last_client_sequence: number;
      last_heartbeat_at: string;
      health: string;
      updated_at: string;
      client_messages: string;
      server_messages: string;
    }>(
      `SELECT last_client_sequence,
              last_heartbeat_at::text,
              health,
              updated_at::text,
              (SELECT count(*)::text
                 FROM connector_messages
                WHERE connector_id = $1 AND direction = 'client') AS client_messages,
              (SELECT count(*)::text
                 FROM connector_messages
                WHERE connector_id = $1 AND direction = 'server') AS server_messages
         FROM connectors
        WHERE id = $1`,
      [testIdentity.connectorId],
    );
    const row = durable.rows[0];
    expect(Number(row?.last_client_sequence)).toBe(1);
    expect(new Date(row?.last_heartbeat_at ?? 0).getTime()).toBeGreaterThan(
      staleAt.getTime(),
    );
    expect(row?.health).toBe("fresh");
    expect(new Date(row?.updated_at ?? 0).getTime()).toBeGreaterThan(
      staleAt.getTime(),
    );
    expect(row?.client_messages).toBe("1");
    expect(row?.server_messages).toBe("1");
  });

  it("does not replay a durably received sequence when its ACK was lost", async () => {
    const cursorIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const helloNow = new Date("2030-01-02T03:04:05.000Z");
    const durable = await store.enqueueServer(
      cursorIdentity,
      "ack",
      { sequence: 77 },
      new Date("2030-01-02T04:04:05.000Z"),
    );
    const hello = envelope(
      "connector.hello",
      1,
      {
        connector_id: cursorIdentity.connectorId,
        connector_version: "integration-1.0",
        last_server_sequence: durable.sequence,
        last_client_sequence: 0,
      },
      { sentAt: helloNow },
    );

    await expect(
      store.acceptClientMessage(cursorIdentity, hello, helloNow),
    ).resolves.toMatchObject({ duplicate: false, replay: [] });
    const durableRow = await database.query<{
      message_id: string;
      acknowledged_at: string | null;
    }>(
      "SELECT message_id, acknowledged_at FROM connector_messages WHERE connector_id = $1 AND sequence = $2",
      [cursorIdentity.connectorId, durable.sequence],
    );
    expect(durableRow.rows[0]).toMatchObject({
      message_id: durable.messageId,
    });
    expect(durableRow.rows[0]?.acknowledged_at).toBeTruthy();

    const ordinary = await store.enqueueServer(
      cursorIdentity,
      "ack",
      { sequence: 78 },
      new Date("2030-01-02T04:04:05.000Z"),
    );
    await expect(
      store.pendingServerMessages(cursorIdentity, 2, helloNow),
    ).resolves.toMatchObject([
      {
        sequence: ordinary.sequence,
        messageId: ordinary.messageId,
        type: "ack",
      },
    ]);
  });

  it("tombstones an expired ACKed row when the durable cursor lags", async () => {
    const cursorIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const now = new Date();
    const expired = await store.enqueueServer(
      cursorIdentity,
      "ack",
      { sequence: 1 },
      new Date(now.getTime() - 1_000),
    );
    const ack = envelope(
      "ack",
      1,
      { sequence: expired.sequence },
      { sentAt: now },
    );
    await store.acceptClientMessage(cursorIdentity, ack, now);

    const hello = envelope(
      "connector.hello",
      2,
      {
        connector_id: cursorIdentity.connectorId,
        connector_version: "integration-1.0",
        last_server_sequence: expired.sequence - 1,
        last_client_sequence: 1,
      },
      { sentAt: now },
    );
    const reconnected = await store.acceptClientMessage(
      cursorIdentity,
      hello,
      now,
    );

    expect(reconnected.replay).toMatchObject([
      {
        sequence: expired.sequence,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      },
    ]);
    expect(reconnected.replay[0]?.messageId).not.toBe(expired.messageId);
    const durable = await database.query<{
      message_id: string;
      acknowledged_at: string | null;
      type: string;
    }>(
      "SELECT message_id, acknowledged_at, type FROM connector_messages WHERE connector_id = $1 AND sequence = $2",
      [cursorIdentity.connectorId, expired.sequence],
    );
    expect(durable.rows[0]).toMatchObject({
      acknowledged_at: expect.any(String),
      type: "protocol.error",
    });
    expect(durable.rows[0]?.message_id).not.toBe(expired.messageId);
  });

  it("makes an expired actionable row at N a same-sequence tombstone when hello reports N-1", async () => {
    const cursorIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const now = new Date();
    const offer = await store.enqueueServer(
      cursorIdentity,
      "job.offer",
      {
        job_id: crypto.randomUUID(),
        attempt: 1,
        lease_id: crypto.randomUUID(),
        repository_id: REPOSITORY_ID,
      },
      new Date(now.getTime() - 1_000),
    );
    const hello = envelope(
      "connector.hello",
      1,
      {
        connector_id: cursorIdentity.connectorId,
        connector_version: "integration-1.0",
        last_server_sequence: offer.sequence - 1,
        last_client_sequence: 0,
      },
      { sentAt: now },
    );

    await expect(
      store.acceptClientMessage(cursorIdentity, hello, now),
    ).resolves.toMatchObject({
      replay: [
        {
          sequence: offer.sequence,
          type: "protocol.error",
          payload: { code: "MESSAGE_EXPIRED" },
        },
      ],
    });
    const durableRow = await database.query<{
      message_id: string;
      type: string;
      sequence: number;
    }>(
      "SELECT message_id, type, sequence FROM connector_messages WHERE connector_id = $1 AND sequence = $2",
      [cursorIdentity.connectorId, offer.sequence],
    );
    expect(Number(durableRow.rows[0]?.sequence)).toBe(offer.sequence);
    expect(durableRow.rows[0]?.type).toBe("protocol.error");
    expect(durableRow.rows[0]?.message_id).not.toBe(offer.messageId);
  });

  it("claims a self-contained live lease, deduplicates, and redacts event data", async () => {
    const testIdentity = await insertConnector();
    const job = await createJob(
      `claim-live-${crypto.randomUUID()}`,
      "Claim the live offer",
    );
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const storedOffer = await store.dispatchNext(testIdentity);
    expect(storedOffer).toMatchObject({
      type: "job.offer",
      payload: { job_id: job.jobId, attempt: 1 },
    });
    if (storedOffer === null) throw new Error("expected a stored offer");
    const payload = storedOffer?.payload as {
      job_id: string;
      attempt: number;
      lease_id: string;
    };

    const wrongClaim = envelope("job.claim", 1, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      lease_id: crypto.randomUUID(),
    });
    await expectStoreError(
      store.acceptClientMessage(testIdentity, wrongClaim),
      "CLAIM_REJECTED",
    );

    const claim = envelope("job.claim", 1, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      lease_id: payload.lease_id,
    });
    await expect(
      store.acceptClientMessage(testIdentity, claim),
    ).resolves.toMatchObject({
      duplicate: false,
      response: { type: "ack" },
    });

    const rawExpressions = [
      "console.log('secret')",
      "process.env.API_KEY",
      "const apiKey = process.env.API_KEY",
      "sk-proj-1234567890abcdef-credential",
      "https://user:password@example.test/run?api_key=query-secret#token=fragment-secret",
    ];
    const progress = uncheckedEnvelope("job.event", 2, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      event_type: rawExpressions[0],
      payload: {
        stage: "testing",
        status: "succeeded",
        summary: {
          detail: rawExpressions[2],
          result: { message: rawExpressions[3], url: rawExpressions[4] },
        },
        results: [{ message: "process.env.DATABASE_URL" }],
      },
      source: rawExpressions[1],
    });
    await store.acceptClientMessage(testIdentity, progress);
    await store.acceptClientMessage(testIdentity, progress);

    const events = await database.query<{
      event_type: string;
      source: string;
      payload: Record<string, unknown>;
      summary: Record<string, unknown> | null;
    }>(
      `SELECT je.event_type, je.source, je.payload, j.summary
         FROM job_events AS je
         JOIN jobs AS j ON j.id = je.job_id
        WHERE je.job_id = $1 AND je.message_id = $2`,
      [payload.job_id, progress.message_id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.summary).not.toBeNull();
    const durableEvent = JSON.stringify(events.rows[0]);
    const durableMessages = await database.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text
         FROM connector_messages
        WHERE connector_id = $1 AND message_id = $2`,
      [testIdentity.connectorId, progress.message_id],
    );
    expect(durableMessages.rows).toHaveLength(1);
    const durableConnectorMessage = durableMessages.rows[0]?.payload_text ?? "";
    for (const expression of [...rawExpressions, "process.env.DATABASE_URL"]) {
      expect(`${durableEvent}\n${durableConnectorMessage}`).not.toContain(
        expression,
      );
    }
  });

  it("refreshes an expired successful claim ACK without repeating the claim", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `retry-ack-expired-${crypto.randomUUID()}`,
      "Retry an expired claim ACK",
    );
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(testIdentity);
    if (offer === null) throw new Error("expected a job offer");
    const claim = envelope("job.claim", 1, {
      job_id: job.jobId,
      attempt: offer.payload.attempt as number,
      lease_id: offer.payload.lease_id as string,
    });
    const accepted = await store.acceptClientMessage(testIdentity, claim);
    if (accepted.response === null) throw new Error("expected a claim ACK");
    expect(accepted.response).toMatchObject({
      type: "ack",
      payload: { sequence: claim.sequence },
    });

    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    const retryNow = new Date();
    const retried = await store.acceptClientMessage(
      testIdentity,
      claim,
      retryNow,
    );
    if (retried.response === null) throw new Error("expected a retried ACK");
    expect(retried).toMatchObject({ duplicate: true });
    expect(retried.response).toMatchObject({
      type: "ack",
      sequence: accepted.response.sequence,
      payload: accepted.response.payload,
    });
    expect(retried.response.messageId).not.toBe(accepted.response.messageId);
    expect(retried.response.expiresAt.getTime()).toBeGreaterThan(
      retryNow.getTime(),
    );
    expect(retried.response.expiresAt.getTime()).toBeLessThanOrEqual(
      retryNow.getTime() + 61_000,
    );

    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      revision: 2,
    });
    await expect(
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM job_events
          WHERE job_id = $1 AND event_type = 'job.claimed'`,
        [job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(
      database.query<{ message_id: string; sequence: number; type: string }>(
        `SELECT message_id, sequence::integer AS sequence, type
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server'
            AND sequence = $2`,
        [testIdentity.connectorId, accepted.response.sequence],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          message_id: retried.response.messageId,
          sequence: accepted.response.sequence,
          type: "ack",
        },
      ],
    });
    await database.query(
      "UPDATE jobs SET status = 'succeeded'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("restores a tombstoned successful claim ACK without repeating the claim", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `retry-ack-tombstone-${crypto.randomUUID()}`,
      "Retry a tombstoned claim ACK",
    );
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(testIdentity);
    if (offer === null) throw new Error("expected a job offer");
    const claim = envelope("job.claim", 1, {
      job_id: job.jobId,
      attempt: offer.payload.attempt as number,
      lease_id: offer.payload.lease_id as string,
    });
    const accepted = await store.acceptClientMessage(testIdentity, claim);
    if (accepted.response === null) throw new Error("expected a claim ACK");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );

    const maintained = await store.pendingServerMessages(
      testIdentity,
      accepted.response.sequence - 1,
      new Date(),
    );
    expect(maintained).toMatchObject([
      {
        sequence: accepted.response.sequence,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      },
    ]);

    const retryNow = new Date();
    const retried = await store.acceptClientMessage(
      testIdentity,
      claim,
      retryNow,
    );
    if (retried.response === null) throw new Error("expected a retried ACK");
    expect(retried).toMatchObject({ duplicate: true });
    expect(retried.response).toMatchObject({
      type: "ack",
      sequence: accepted.response.sequence,
      payload: accepted.response.payload,
    });
    expect(retried.response.messageId).not.toBe(accepted.response.messageId);
    expect(retried.response.messageId).not.toBe(maintained[0]?.messageId);
    expect(retried.response.expiresAt.getTime()).toBeGreaterThan(
      retryNow.getTime(),
    );

    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      revision: 2,
    });
    await expect(
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM job_events
          WHERE job_id = $1 AND event_type = 'job.claimed'`,
        [job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await database.query(
      "UPDATE jobs SET status = 'succeeded'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("refreshes an expired CLAIM_REJECTED response without repeating cancellation handling", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `retry-claim-rejected-${crypto.randomUUID()}`,
      "Retry a rejected claim response",
    );
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const store = new PostgresConnectorStore(database.client);
    const offer = await store.dispatchNext(testIdentity);
    if (offer === null) throw new Error("expected a job offer");
    const claim = envelope("job.claim", 1, {
      job_id: job.jobId,
      attempt: offer.payload.attempt as number,
      lease_id: offer.payload.lease_id as string,
    });
    const dispatched = await repository.get(job.jobId);
    if (dispatched === null) throw new Error("expected a dispatched job");
    await expect(
      repository.cancelAtomically({
        ownerId: OWNER_ID,
        jobId: job.jobId,
        expectedRevision: dispatched.revision,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const accepted = await store.acceptClientMessage(testIdentity, claim);
    if (accepted.response === null) {
      throw new Error("expected a CLAIM_REJECTED response");
    }
    expect(accepted.response).toMatchObject({
      type: "protocol.error",
      payload: {
        code: "CLAIM_REJECTED",
        message: "The offered job was cancelled before it was claimed.",
      },
    });
    const eventsAfterInitialClaim = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM job_events WHERE job_id = $1",
      [job.jobId],
    );
    const stateAfterInitialClaim = await repository.get(job.jobId);

    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [accepted.response.messageId],
    );
    const retryNow = new Date();
    const retried = await store.acceptClientMessage(
      testIdentity,
      claim,
      retryNow,
    );
    if (retried.response === null) {
      throw new Error("expected a retried CLAIM_REJECTED response");
    }
    expect(retried).toMatchObject({ duplicate: true });
    expect(retried.response).toMatchObject({
      type: "protocol.error",
      sequence: accepted.response.sequence,
      payload: accepted.response.payload,
    });
    expect(retried.response.messageId).not.toBe(accepted.response.messageId);
    expect(retried.response.expiresAt.getTime()).toBeGreaterThan(
      retryNow.getTime(),
    );
    expect(retried.response.expiresAt.getTime()).toBeLessThanOrEqual(
      retryNow.getTime() + 61_000,
    );

    await expect(repository.get(job.jobId)).resolves.toEqual(
      stateAfterInitialClaim,
    );
    const eventsAfterRetry = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM job_events WHERE job_id = $1",
      [job.jobId],
    );
    expect(eventsAfterRetry.rows[0]?.count).toBe(
      eventsAfterInitialClaim.rows[0]?.count,
    );
  });

  it("releases an expired offer lease without incrementing the product attempt", async () => {
    const testIdentity = await insertConnector();
    const repositoryId = `expired-offer-${crypto.randomUUID()}`;
    const repository = new JobRepository(database.client);
    const job = await createJob(repositoryId, "Redispatch the expired offer");
    const store = new PostgresConnectorStore(database.client);
    const first = await store.dispatchNext(testIdentity);
    expect(first?.payload.job_id).toBe(job.jobId);
    await database.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.jobId],
    );

    const second = await store.dispatchNext(testIdentity);
    expect(second).toMatchObject({
      type: "job.offer",
      payload: { job_id: job.jobId, attempt: 1 },
    });
    expect(second?.payload.lease_id).not.toBe(first?.payload.lease_id);
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "dispatched",
      attempt: 0,
    });

    if (first === null || second === null) {
      throw new Error("expected both durable offers");
    }
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE message_id = $1",
      [first.messageId],
    );
    const replay = await store.pendingServerMessages(
      testIdentity,
      first.sequence - 1,
    );
    expect(replay.slice(0, 2)).toMatchObject([
      {
        sequence: first.sequence,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      },
      {
        sequence: second.sequence,
        messageId: second.messageId,
        type: "job.offer",
      },
    ]);
    expect(replay[1]?.sequence).toBe(replay[0]?.sequence + 1);
    expect(replay[0]?.messageId).not.toBe(first.messageId);
    expect(JSON.stringify(replay[0])).not.toContain(
      "Redispatch the expired offer",
    );
    await expect(
      store.materializeServerMessage(
        replay[0] as NonNullable<(typeof replay)[0]>,
      ),
    ).resolves.toMatchObject({
      type: "protocol.error",
      payload: { code: "MESSAGE_EXPIRED" },
    });

    const reconnect = envelope("connector.hello", 1, {
      connector_id: testIdentity.connectorId,
      connector_version: "sk-abcdefghijklmnop",
      capabilities: ["/Users/ethan/private-repo"],
      last_server_sequence: first.sequence - 1,
      last_client_sequence: 0,
    });
    const reconnected = await store.acceptClientMessage(
      testIdentity,
      reconnect,
    );
    expect(
      reconnected.replay.slice(0, 2).map((message) => message.sequence),
    ).toEqual([first.sequence, second.sequence]);
    expect(reconnected.replay[0]?.messageId).toBe(replay[0]?.messageId);
    const connectorState = await database.query<{ capabilities: string[] }>(
      "SELECT capabilities FROM connectors WHERE id = $1",
      [testIdentity.connectorId],
    );
    expect(JSON.stringify(connectorState.rows[0]?.capabilities)).not.toContain(
      "/Users/ethan/private-repo",
    );
  });

  it.each([
    ["job.claim", "dispatched", 0, "CLAIM_REJECTED"],
    ["job.event", "running", 1, "EVENT_REJECTED"],
  ] as const)(
    "rejects %s exactly at jobs.expiresAt",
    async (type, status, attempt, code) => {
      const testIdentity = await insertConnector();
      const now = new Date(Date.now() - 5_000);
      const expiredAt = new Date(Date.now() - 1_000);
      const leaseId = type === "job.claim" ? crypto.randomUUID() : null;
      const job = await insertConnectedJob(
        testIdentity.connectorId,
        status,
        expiredAt,
        attempt,
        leaseId,
        leaseId === null ? null : new Date(Date.now() + 60_000),
      );
      const message =
        type === "job.claim"
          ? envelope(
              "job.claim",
              1,
              { job_id: job.jobId, attempt: 1, lease_id: leaseId as string },
              { sentAt: now },
            )
          : envelope(
              "job.event",
              1,
              {
                job_id: job.jobId,
                attempt: 1,
                event_type: "succeeded",
                payload: { status: "succeeded", summary: "must not persist" },
                source: "connector",
              },
              { sentAt: now },
            );
      const store = new PostgresConnectorStore(database.client);

      await expectStoreError(
        store.acceptClientMessage(testIdentity, message, now),
        code,
      );
      await expect(
        database.query<{
          status: string;
          attempt: number;
          event_count: string;
        }>(
          `SELECT j.status, j.attempt, count(je.id)::text AS event_count
           FROM jobs AS j
           LEFT JOIN job_events AS je ON je.job_id = j.id
          WHERE j.id = $1
          GROUP BY j.id`,
          [job.jobId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status, attempt, event_count: "0" }],
      });
      await expectClientCursor(testIdentity.connectorId, 0);
    },
  );

  it("rejects a connector claim that waits past the job and lease expiry", async () => {
    const testIdentity = await insertConnector();
    const now = new Date();
    const expiresAt = await expiryAfter(250);
    const leaseId = crypto.randomUUID();
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "dispatched",
      expiresAt,
      0,
      leaseId,
      expiresAt,
    );
    const message = envelope(
      "job.claim",
      1,
      { job_id: job.jobId, attempt: 1, lease_id: leaseId },
      { sentAt: now },
    );
    const store = new PostgresConnectorStore(database.client);
    const holder = holdConnectorRowUntil(testIdentity.connectorId, expiresAt);
    await holder.ready;
    const accepted = store.acceptClientMessage(testIdentity, message, now);
    const acceptedOutcome = Promise.allSettled([accepted]);
    try {
      await waitForRowLockWaiter("connectors");
    } finally {
      holder.releaseToExpiry();
      await holder.done;
    }

    const [outcome] = await acceptedOutcome;
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "CLAIM_REJECTED" },
    });
    await expect(
      database.query<{ status: string; attempt: number; revision: number }>(
        "SELECT status, attempt, revision FROM jobs WHERE id = $1",
        [job.jobId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "dispatched", attempt: 0, revision: 0 }],
    });
    await expectClientCursor(testIdentity.connectorId, 0);
    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("rejects a connector event that waits past the job expiry", async () => {
    const testIdentity = await insertConnector();
    const now = new Date();
    const expiresAt = await expiryAfter(250);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      expiresAt,
      1,
      null,
      null,
    );
    const message = envelope(
      "job.event",
      1,
      {
        job_id: job.jobId,
        attempt: 1,
        event_type: "progress",
        payload: { stage: "must not persist" },
        source: "connector",
      },
      { sentAt: now },
    );
    const store = new PostgresConnectorStore(database.client);
    const holder = holdConnectorRowUntil(testIdentity.connectorId, expiresAt);
    await holder.ready;
    const accepted = store.acceptClientMessage(testIdentity, message, now);
    const acceptedOutcome = Promise.allSettled([accepted]);
    try {
      await waitForRowLockWaiter("connectors");
    } finally {
      holder.releaseToExpiry();
      await holder.done;
    }

    const [outcome] = await acceptedOutcome;
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    await expect(
      database.query<{ status: string; attempt: number; revision: number }>(
        "SELECT status, attempt, revision FROM jobs WHERE id = $1",
        [job.jobId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "running", attempt: 1, revision: 0 }],
    });
    await expectClientCursor(testIdentity.connectorId, 0);
    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it.each(["queued", "dispatched"] as const)(
    "rejects a %s job.event before a successful claim",
    async (status) => {
      const testIdentity = await insertConnector();
      const now = new Date("2030-01-02T03:04:05.000Z");
      const job = await insertConnectedJob(
        testIdentity.connectorId,
        status,
        new Date("2030-01-02T03:05:05.000Z"),
        1,
        null,
        null,
      );
      const message = envelope(
        "job.event",
        1,
        {
          job_id: job.jobId,
          attempt: 1,
          event_type: "progress",
          payload: { stage: "must not persist" },
          source: "connector",
        },
        { sentAt: now },
      );
      const store = new PostgresConnectorStore(database.client);

      await expectStoreError(
        store.acceptClientMessage(testIdentity, message, now),
        "EVENT_REJECTED",
      );
      await expect(
        database.query<{
          status: string;
          revision: number;
          event_count: string;
        }>(
          `SELECT j.status, j.revision, count(je.id)::text AS event_count
             FROM jobs AS j
             LEFT JOIN job_events AS je ON je.job_id = j.id
            WHERE j.id = $1
            GROUP BY j.id`,
          [job.jobId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status, revision: 0, event_count: "0" }],
      });
      await expectClientCursor(testIdentity.connectorId, 0);
      await database.query(
        "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
        [job.jobId],
      );
    },
  );

  it.each(["running", "waiting_approval", "cancelling"] as const)(
    "accepts a %s job.event after a successful claim",
    async (status) => {
      const testIdentity = await insertConnector();
      const now = new Date("2030-01-02T03:04:05.000Z");
      const job = await insertConnectedJob(
        testIdentity.connectorId,
        status,
        new Date("2030-01-02T03:05:05.000Z"),
        1,
        null,
        null,
      );
      const message = envelope(
        "job.event",
        1,
        {
          job_id: job.jobId,
          attempt: 1,
          event_type: "progress",
          payload: { stage: "still active" },
          source: "connector",
        },
        { sentAt: now },
      );
      const store = new PostgresConnectorStore(database.client);

      await expect(
        store.acceptClientMessage(testIdentity, message, now),
      ).resolves.toMatchObject({ response: { type: "ack" } });
      await expect(
        database.query<{
          status: string;
          revision: number;
          event_count: string;
        }>(
          `SELECT j.status, j.revision, count(je.id)::text AS event_count
             FROM jobs AS j
             LEFT JOIN job_events AS je ON je.job_id = j.id
            WHERE j.id = $1
            GROUP BY j.id`,
          [job.jobId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status, revision: 1, event_count: "1" }],
      });
      await database.query(
        "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
        [job.jobId],
      );
    },
  );

  it("replaces every mixed expired server command in bounded contiguous replay batches", async () => {
    const replayIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1_000);
    const expiredCount = SERVER_REPLAY_BATCH_SIZE * 2 + 7;
    const expiredJobId = crypto.randomUUID();
    const expiredApprovalId = crypto.randomUUID();
    await database.query(
      `INSERT INTO connector_messages
         (connector_id, direction, sequence, type, payload, expires_at)
       SELECT $1,
              'server',
              message_sequence,
              CASE message_sequence % 3
                WHEN 0 THEN 'job.offer'
                WHEN 1 THEN 'job.cancel'
                ELSE 'approval.decision'
              END,
              CASE message_sequence % 3
                WHEN 0 THEN jsonb_build_object(
                  'job_id', $4::uuid,
                  'attempt', 1,
                  'lease_id', gen_random_uuid(),
                  'repository_id', $5::text
                )
                WHEN 1 THEN jsonb_build_object(
                  'job_id', $4::uuid,
                  'attempt', 1,
                  'job_revision', 1,
                  'reason', 'cancel me',
                  'nonce', gen_random_uuid()
                )
                ELSE jsonb_build_object(
                  'approval_id', $6::uuid,
                  'job_id', $4::uuid,
                  'attempt', 1,
                  'job_revision', 1,
                  'action_fingerprint', $7::text,
                  'decision', 'approve'
                )
              END,
              $2
         FROM generate_series(1, $3::integer) AS message_sequence`,
      [
        replayIdentity.connectorId,
        expiredAt,
        expiredCount,
        expiredJobId,
        REPOSITORY_ID,
        expiredApprovalId,
        `sha256:${"c".repeat(64)}`,
      ],
    );
    await database.query(
      `INSERT INTO connector_messages
         (connector_id, direction, sequence, type, payload, expires_at)
       VALUES ($1, 'server', $2, 'ack', $3::jsonb, $4)`,
      [
        replayIdentity.connectorId,
        expiredCount + 1,
        JSON.stringify({ sequence: expiredCount + 1 }),
        new Date(now.getTime() + 60_000),
      ],
    );
    await database.query(
      "UPDATE connectors SET last_server_sequence = $2 WHERE id = $1",
      [replayIdentity.connectorId, expiredCount + 1],
    );
    const original = await serverMessagesBySequence(
      replayIdentity.connectorId,
      expiredCount + 1,
    );
    const originalIds = new Map(
      original.map((message) => [message.sequence, message.messageId]),
    );

    const replayed: StoredServerMessage[] = [];
    let cursor = 0;
    while (true) {
      const batch = await store.pendingServerMessages(
        replayIdentity,
        cursor,
        now,
      );
      if (batch.length === 0) break;
      replayed.push(...batch);
      cursor = batch.at(-1)?.sequence ?? cursor;
      expect(batch.length).toBeLessThanOrEqual(SERVER_REPLAY_BATCH_SIZE);
    }
    expect(replayed.map((message) => message.sequence)).toEqual(
      Array.from({ length: expiredCount + 1 }, (_, index) => index + 1),
    );
    expect(
      replayed
        .slice(0, expiredCount)
        .every((message) => message.type === "protocol.error"),
    ).toBe(true);
    expect(replayed.at(-1)).toMatchObject({
      sequence: expiredCount + 1,
      type: "ack",
    });
    expect(
      replayed.slice(0, expiredCount).every(
        (message) =>
          message.messageId !== originalIds.get(message.sequence) &&
          message.expiresAt.getTime() > now.getTime() &&
          JSON.stringify(message.payload) ===
            JSON.stringify({
              code: "MESSAGE_EXPIRED",
              message: "A Connector message expired before delivery.",
            }),
      ),
    ).toBe(true);
    const durable = await database.query<{
      type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT sequence, type, payload
         FROM connector_messages
        WHERE connector_id = $1
        ORDER BY sequence`,
      [replayIdentity.connectorId],
    );
    expect(durable.rows).toHaveLength(expiredCount + 1);
    expect(
      durable.rows.slice(0, expiredCount).every(
        (row) =>
          row.type === "protocol.error" &&
          JSON.stringify(row.payload) ===
            JSON.stringify({
              code: "MESSAGE_EXPIRED",
              message: "A Connector message expired before delivery.",
            }),
      ),
    ).toBe(true);
  });

  it("updates at most one tombstone batch per request and makes progress on the next cursor", async () => {
    const batchIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const total = SERVER_REPLAY_BATCH_SIZE + 1;
    const expiredAt = new Date(Date.now() - 1_000);
    await database.query(
      `INSERT INTO connector_messages
         (connector_id, direction, sequence, type, payload, correlation_id, expires_at)
       SELECT $1, 'server', sequence, 'ack',
              jsonb_build_object('sequence', sequence),
              gen_random_uuid(), $2
         FROM generate_series(1, $3::integer) AS sequence`,
      [batchIdentity.connectorId, expiredAt, total],
    );
    await database.query(
      "UPDATE connectors SET last_server_sequence = $2 WHERE id = $1",
      [batchIdentity.connectorId, total],
    );

    const first = await store.pendingServerMessages(batchIdentity, 0);
    expect(first).toHaveLength(SERVER_REPLAY_BATCH_SIZE);
    const untouched = await database.query<{ type: string }>(
      "SELECT type FROM connector_messages WHERE connector_id = $1 AND sequence = $2",
      [batchIdentity.connectorId, SERVER_REPLAY_BATCH_SIZE + 1],
    );
    expect(untouched.rows[0]?.type).toBe("ack");

    await expect(
      store.pendingServerMessages(batchIdentity, SERVER_REPLAY_BATCH_SIZE),
    ).resolves.toMatchObject([
      {
        sequence: SERVER_REPLAY_BATCH_SIZE + 1,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      },
    ]);
  });

  it("rejects a previously fetched offer after expiry without decrypting it", async () => {
    const fetchIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const fetchedAt = new Date();
    const expiresAt = new Date(fetchedAt.getTime() + 60_000);
    const offer = await store.enqueueServer(
      fetchIdentity,
      "job.offer",
      {
        job_id: crypto.randomUUID(),
        attempt: 1,
        lease_id: crypto.randomUUID(),
        repository_id: REPOSITORY_ID,
      },
      expiresAt,
    );
    const fetched = await store.pendingServerMessages(
      fetchIdentity,
      0,
      fetchedAt,
    );
    expect(fetched[0]).toMatchObject({ type: "job.offer" });
    const fetchedOffer = fetched[0];
    if (fetchedOffer === undefined) throw new Error("expected a fetched offer");
    await database.query(
      "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE connector_id = $1 AND sequence = $2",
      [fetchIdentity.connectorId, offer.sequence],
    );
    let decryptCalls = 0;
    await expect(
      store.materializeServerMessage(
        fetchedOffer,
        {
          decrypt: async () => {
            decryptCalls += 1;
            return "must not be sent";
          },
        },
        new Date("2000-01-01T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_EXPIRED" });
    expect(decryptCalls).toBe(0);

    await expect(
      store.pendingServerMessages(fetchIdentity, 0),
    ).resolves.toMatchObject([
      { sequence: offer.sequence, type: "protocol.error" },
    ]);
  });

  it("rejects an offer that expires while its request is decrypting", async () => {
    const fetchIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const fetchedAt = new Date();
    const expiresAt = new Date(fetchedAt.getTime() + 60_000);
    const leaseId = crypto.randomUUID();
    const job = await insertConnectedJob(
      fetchIdentity.connectorId,
      "dispatched",
      expiresAt,
      0,
      leaseId,
      expiresAt,
    );
    const offer = await store.enqueueServer(
      fetchIdentity,
      "job.offer",
      {
        job_id: job.jobId,
        attempt: 1,
        lease_id: leaseId,
        repository_id: REPOSITORY_ID,
      },
      expiresAt,
    );
    const fetched = await store.pendingServerMessages(
      fetchIdentity,
      0,
      fetchedAt,
    );
    const fetchedOffer = fetched[0];
    if (fetchedOffer === undefined) throw new Error("expected a fetched offer");

    let signalDecryptStarted: () => void = () => undefined;
    const decryptStarted = new Promise<void>((resolve) => {
      signalDecryptStarted = resolve;
    });
    let releaseDecrypt: () => void = () => undefined;
    const decryptReleased = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    const materialized = store.materializeServerMessage(
      fetchedOffer,
      {
        decrypt: async () => {
          await database.query(
            "UPDATE jobs SET expires_at = now() - interval '1 second', lease_expires_at = now() - interval '1 second' WHERE id = $1",
            [job.jobId],
          );
          await database.query(
            "UPDATE connector_messages SET expires_at = now() - interval '1 second' WHERE connector_id = $1 AND sequence = $2",
            [fetchIdentity.connectorId, offer.sequence],
          );
          signalDecryptStarted();
          await decryptReleased;
          return "plaintext must not be returned";
        },
      },
      new Date("2100-01-01T00:00:00.000Z"),
    );

    await decryptStarted;
    releaseDecrypt();

    await expect(materialized).rejects.toMatchObject({
      code: "MESSAGE_EXPIRED",
    });
  });

  it("rejects a fetched offer after its durable row is replaced", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `offer-replaced-${crypto.randomUUID()}`,
      "Offer replaced while pending",
    );
    const store = new PostgresConnectorStore(database.client);
    const fetchedAt = new Date();
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const offer = await store.dispatchNext(testIdentity, fetchedAt);
    if (offer === null) throw new Error("expected an offer");
    expect(offer.payload.job_id).toBe(job.jobId);
    const fetched = await store.pendingServerMessages(
      testIdentity,
      0,
      fetchedAt,
    );
    const fetchedOffer = fetched.find(
      (message) => message.sequence === offer.sequence,
    );
    if (fetchedOffer === undefined)
      throw new Error("expected the fetched offer");

    await database.query(
      "UPDATE connector_messages SET expires_at = $1 WHERE connector_id = $2 AND sequence = $3",
      [
        new Date(fetchedAt.getTime() - 1),
        testIdentity.connectorId,
        offer.sequence,
      ],
    );
    const replayed = await store.pendingServerMessages(
      testIdentity,
      0,
      new Date(fetchedAt.getTime() + 1),
    );
    expect(replayed[0]).toMatchObject({
      sequence: offer.sequence,
      type: "protocol.error",
      payload: { code: "MESSAGE_EXPIRED" },
    });

    let decryptCalls = 0;
    await expect(
      store.materializeServerMessage(
        fetchedOffer,
        {
          decrypt: async () => {
            decryptCalls += 1;
            return "must not be sent";
          },
        },
        fetchedAt,
        () => fetchedAt,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_EXPIRED" });
    expect(decryptCalls).toBe(0);
    await expect(repository.get(job.jobId)).resolves.toMatchObject({
      status: "dispatched",
    });
    await database.query(
      "UPDATE jobs SET status = 'expired'::job_status WHERE id = $1",
      [job.jobId],
    );
  });

  it("rejects a fetched offer after the job is cancelled", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const job = await createJob(
      `offer-cancelled-${crypto.randomUUID()}`,
      "Offer cancelled while pending",
    );
    const store = new PostgresConnectorStore(database.client);
    const fetchedAt = new Date();
    await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
      new Date("2000-01-01T00:00:00.000Z"),
      job.jobId,
    ]);
    const offer = await store.dispatchNext(testIdentity, fetchedAt);
    if (offer === null) throw new Error("expected an offer");
    expect(offer.payload.job_id).toBe(job.jobId);
    const fetched = await store.pendingServerMessages(
      testIdentity,
      0,
      fetchedAt,
    );
    const fetchedOffer = fetched.find(
      (message) => message.sequence === offer.sequence,
    );
    if (fetchedOffer === undefined)
      throw new Error("expected the fetched offer");

    await repository.cancelAtomically({
      ownerId: OWNER_ID,
      jobId: job.jobId,
      expectedRevision: job.revision + 1,
    });

    let decryptCalls = 0;
    await expect(
      store.materializeServerMessage(
        fetchedOffer,
        {
          decrypt: async () => {
            decryptCalls += 1;
            return "must not be sent";
          },
        },
        fetchedAt,
        () => fetchedAt,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_EXPIRED" });
    expect(decryptCalls).toBe(0);
  });

  it.each(["expired", "failed", "succeeded"] as const)(
    "tombstones a fetched offer when the job becomes %s",
    async (status) => {
      const testIdentity = await insertConnector();
      const job = await createJob(
        `offer-${status}-${crypto.randomUUID()}`,
        `Offer becomes ${status} while pending`,
      );
      const store = new PostgresConnectorStore(database.client);
      const fetchedAt = new Date();
      await database.query("UPDATE jobs SET accepted_at = $1 WHERE id = $2", [
        new Date("2000-01-01T00:00:00.000Z"),
        job.jobId,
      ]);
      const offer = await store.dispatchNext(testIdentity, fetchedAt);
      if (offer === null) throw new Error("expected an offer");
      const fetched = await store.pendingServerMessages(
        testIdentity,
        0,
        fetchedAt,
      );
      const fetchedOffer = fetched.find(
        (message) => message.sequence === offer.sequence,
      );
      if (fetchedOffer === undefined)
        throw new Error("expected the fetched offer");

      await database.query(
        "UPDATE jobs SET status = $1::job_status WHERE id = $2",
        [status, job.jobId],
      );
      const replayed = await store.pendingServerMessages(
        testIdentity,
        0,
        new Date(fetchedAt.getTime() + 1),
      );
      expect(replayed[0]).toMatchObject({
        sequence: offer.sequence,
        type: "protocol.error",
        payload: { code: "MESSAGE_EXPIRED" },
      });
      expect(replayed[0]?.messageId).not.toBe(offer.messageId);

      let decryptCalls = 0;
      await expect(
        store.materializeServerMessage(
          fetchedOffer,
          {
            decrypt: async () => {
              decryptCalls += 1;
              return "must not be sent";
            },
          },
          new Date(fetchedAt.getTime() + 1),
          () => new Date(fetchedAt.getTime() + 1),
        ),
      ).rejects.toMatchObject({ code: "MESSAGE_EXPIRED" });
      expect(decryptCalls).toBe(0);
    },
  );

  it("handles cancel-before-claim and claim-before-cancel without stale offers", async () => {
    for (const ordering of [
      "cancel-before-claim",
      "claim-before-cancel",
    ] as const) {
      const testIdentity = await insertConnector();
      const repository = new JobRepository(database.client);
      const job = await createJob(
        `claim-cancel-${ordering}-${crypto.randomUUID()}`,
      );
      const store = new PostgresConnectorStore(database.client);
      const offer = await store.dispatchNext(testIdentity);
      if (offer === null) throw new Error("expected an offer");
      const claim = envelope("job.claim", 1, {
        job_id: job.jobId,
        attempt: offer.payload.attempt as number,
        lease_id: offer.payload.lease_id as string,
      });

      if (ordering === "cancel-before-claim") {
        await expect(
          repository.cancelAtomically({
            ownerId: OWNER_ID,
            jobId: job.jobId,
            expectedRevision: job.revision + 1,
          }),
        ).resolves.toMatchObject({ status: "cancelled" });
        await expect(
          store.pendingServerMessages(testIdentity, 0),
        ).resolves.toMatchObject([
          {
            sequence: offer.sequence,
            type: "protocol.error",
            payload: { code: "JOB_CANCELLED" },
          },
        ]);
        await expect(
          store.acceptClientMessage(testIdentity, claim),
        ).resolves.toMatchObject({
          response: {
            type: "protocol.error",
            payload: { code: "CLAIM_REJECTED" },
          },
        });
        await expectClientCursor(testIdentity.connectorId, 1);
        await expect(repository.get(job.jobId)).resolves.toMatchObject({
          status: "cancelled",
        });
      } else {
        await expect(
          store.acceptClientMessage(testIdentity, claim),
        ).resolves.toMatchObject({ response: { type: "ack" } });
        const claimed = await repository.get(job.jobId);
        if (claimed === null) throw new Error("expected claimed job");
        await expect(
          repository.cancelAtomically({
            ownerId: OWNER_ID,
            jobId: job.jobId,
            expectedRevision: claimed.revision,
          }),
        ).resolves.toMatchObject({ status: "cancelling" });
        await expect(
          database.query<{ type: string }>(
            "SELECT type FROM connector_messages WHERE connector_id = $1 AND direction = 'server' ORDER BY sequence DESC LIMIT 1",
            [testIdentity.connectorId],
          ),
        ).resolves.toMatchObject({ rows: [{ type: "job.cancel" }] });
      }
    }
  });

  it("serializes concurrent connector event and cancellation locks without a PostgreSQL deadlock", async () => {
    const raceIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const store = new PostgresConnectorStore(database.client);
    const now = new Date("2030-01-02T03:04:05.000Z");
    const job = await insertConnectedJob(
      raceIdentity.connectorId,
      "running",
      new Date("2030-01-02T03:05:05.000Z"),
      1,
      null,
      null,
    );
    const lockKeys = [
      700_000_000 + Math.floor(Math.random() * 100_000),
      700_100_000 + Math.floor(Math.random() * 100_000),
    ];
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const connectorFunction = `qhb_connector_gate_${suffix}`;
    const jobFunction = `qhb_job_gate_${suffix}`;
    const connectorTrigger = `qhb_connector_trigger_${suffix}`;
    const jobTrigger = `qhb_job_trigger_${suffix}`;
    await database.query(
      `CREATE FUNCTION ${connectorFunction}() RETURNS trigger
       LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.connector_id = '${raceIdentity.connectorId}'::uuid
            AND NEW.direction = 'client' THEN
           PERFORM pg_advisory_xact_lock(${lockKeys[0]}::bigint);
         END IF;
         RETURN NEW;
       END
       $function$;
       CREATE TRIGGER ${connectorTrigger}
       BEFORE INSERT ON connector_messages
       FOR EACH ROW EXECUTE FUNCTION ${connectorFunction}();
       CREATE FUNCTION ${jobFunction}() RETURNS trigger
       LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.id = '${job.jobId}'::uuid AND NEW.status = 'cancelling' THEN
           PERFORM pg_advisory_xact_lock(${lockKeys[1]}::bigint);
         END IF;
         RETURN NEW;
       END
       $function$;
       CREATE TRIGGER ${jobTrigger}
       BEFORE UPDATE ON jobs
       FOR EACH ROW EXECUTE FUNCTION ${jobFunction}();`,
    );

    let releaseHolder!: () => void;
    let holderReady!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const locksHeld = new Promise<void>((resolve) => {
      holderReady = resolve;
    });
    const holder = database.client.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(${lockKeys[0]}::bigint)`,
      );
      await tx.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(${lockKeys[1]}::bigint)`,
      );
      holderReady();
      await holderReleased;
    });
    const event = envelope(
      "job.event",
      1,
      {
        job_id: job.jobId,
        attempt: 1,
        event_type: "progress",
        payload: { stage: "testing" },
        source: "connector",
      },
      { sentAt: now },
    );
    let cancelled: Promise<unknown> | undefined;
    try {
      await locksHeld;
      // Establish both gates before the event can reach its trigger.
      const accepted = store.acceptClientMessage(raceIdentity, event, now);
      await waitForAdvisoryWaiters(lockKeys, 1);
      cancelled = repository.cancelAtomically({
        ownerId: OWNER_ID,
        jobId: job.jobId,
        expectedRevision: job.revision,
      });
      const deadline = Date.now() + 500;
      while (
        Date.now() < deadline &&
        (await advisoryWaiterCount(lockKeys)) < 2
      ) {
        await delay(10);
      }
      expect(await advisoryWaiterCount(lockKeys)).toBe(1);
      releaseHolder();
      const outcomes = await Promise.allSettled(
        cancelled === undefined ? [accepted] : [accepted, cancelled],
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      expect(
        rejected.every(
          (outcome) => outcome.reason?.code === "REVISION_CONFLICT",
        ),
      ).toBe(true);
      expect(rejected.some((outcome) => outcome.reason?.code === "40P01")).toBe(
        false,
      );
      expect(rejected.some((outcome) => outcome.reason?.code === "55P03")).toBe(
        false,
      );
    } finally {
      releaseHolder();
      await holder;
      await database.query(
        `DROP TRIGGER IF EXISTS ${connectorTrigger} ON connector_messages;
         DROP TRIGGER IF EXISTS ${jobTrigger} ON jobs;
         DROP FUNCTION IF EXISTS ${connectorFunction}();
         DROP FUNCTION IF EXISTS ${jobFunction}();`,
      );
    }
  });

  it("avoids approval/job lock inversion when a Connector reuses an approval id", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const repository = new JobRepository(database.client);
    const approvalJob = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const approvalId = crypto.randomUUID();
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const approvalExpiresAt = new Date(
      String(await expiryAfter(120_000)),
    ).toISOString();
    const first = envelope("approval.requested", 1, {
      approval_id: approvalId,
      job_id: approvalJob.jobId,
      attempt: 1,
      job_revision: 1,
      action_summary: "Original approval",
      impact_summary: "Original approval impact",
      risk_class: "approval_required",
      action_fingerprint: fingerprint,
      expires_at: approvalExpiresAt,
    });
    await expect(
      store.acceptClientMessage(testIdentity, first),
    ).resolves.toMatchObject({ response: { type: "ack" } });

    const duplicateJob = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );

    const duplicateId = envelope("approval.requested", 2, {
      approval_id: approvalId,
      job_id: duplicateJob.jobId,
      attempt: 1,
      job_revision: 1,
      action_summary: "Conflicting approval",
      impact_summary: "Must not replace the original binding",
      risk_class: "approval_required",
      action_fingerprint: `sha256:${"b".repeat(64)}`,
      expires_at: approvalExpiresAt,
    });
    const lockKey = 800_000_000 + Math.floor(Math.random() * 100_000);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const approvalFunction = `qhb_approval_gate_${suffix}`;
    const approvalTrigger = `qhb_approval_trigger_${suffix}`;
    await database.query(
      `CREATE FUNCTION ${approvalFunction}() RETURNS trigger
       LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.job_id = '${duplicateJob.jobId}'::uuid THEN
           PERFORM pg_advisory_xact_lock(${lockKey}::bigint);
         END IF;
         RETURN NEW;
       END
       $function$;
       CREATE TRIGGER ${approvalTrigger}
       BEFORE INSERT ON approvals
       FOR EACH ROW EXECUTE FUNCTION ${approvalFunction}();`,
    );
    let releaseApprovalGate!: () => void;
    let signalApprovalGateReady!: () => void;
    const approvalGateReady = new Promise<void>((resolve) => {
      signalApprovalGateReady = resolve;
    });
    const approvalGateReleased = new Promise<void>((resolve) => {
      releaseApprovalGate = resolve;
    });
    const approvalGateHolder = database.client.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`,
      );
      signalApprovalGateReady();
      await approvalGateReleased;
    });
    await approvalGateReady;

    const duplicateAcceptance = store.acceptClientMessage(
      testIdentity,
      duplicateId,
    );
    const duplicateAcceptanceOutcome = Promise.allSettled([
      duplicateAcceptance,
    ]);
    let outcomes: PromiseSettledResult<unknown>[] = [];
    let approvalProbe: PromiseSettledResult<unknown> | undefined;
    let decisionOutcome: Promise<PromiseSettledResult<unknown>[]> =
      Promise.resolve([]);
    try {
      await waitForAdvisoryWaiters([lockKey], 1);
      const decision = repository.recordApprovalDecision({
        ownerId: OWNER_ID,
        approvalId,
        decision: "approve",
        expectedJobRevision: 1,
        expectedAttempt: 1,
        actionFingerprint: fingerprint,
      });
      decisionOutcome = Promise.allSettled([decision]);
      await waitForRowLockWaiter("connectors");
      [approvalProbe] = await Promise.allSettled([
        database.client.transaction((tx) =>
          tx.execute(
            drizzleSql`SELECT id FROM approvals WHERE id = ${approvalId} FOR UPDATE NOWAIT`,
          ),
        ),
      ]);
      releaseApprovalGate();
      await approvalGateHolder;
      outcomes = [
        ...(await duplicateAcceptanceOutcome),
        ...(await decisionOutcome),
      ];
    } finally {
      releaseApprovalGate();
      await approvalGateHolder;
      if (outcomes.length === 0) {
        outcomes = [
          ...(await duplicateAcceptanceOutcome),
          ...(await decisionOutcome),
        ];
      }
      await database.query(
        `DROP TRIGGER IF EXISTS ${approvalTrigger} ON approvals;
         DROP FUNCTION IF EXISTS ${approvalFunction}();`,
      );
    }

    const errorCode = (error: unknown): string | undefined => {
      let candidate = error;
      for (let depth = 0; depth < 5; depth += 1) {
        if (candidate === null || typeof candidate !== "object") return;
        const code = (candidate as { code?: unknown }).code;
        if (typeof code === "string") return code;
        candidate = (candidate as { cause?: unknown }).cause;
      }
      return;
    };
    expect(approvalProbe).toMatchObject({ status: "fulfilled" });
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.status === "rejected" &&
          errorCode(outcome.reason) === "40P01",
      ),
    ).toBe(false);
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });

    const effects = await database.query<{
      approval_count: string;
      approval_requested_events: string;
      client_messages: string;
      duplicate_events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_client_sequence,
              (SELECT count(*)::text FROM approvals WHERE id = $1) AS approval_count,
              (SELECT count(*)::text FROM job_events
                WHERE job_id = $2 AND event_type = 'approval.requested')
                AS approval_requested_events,
              (SELECT count(*)::text FROM job_events WHERE message_id = $3)
                AS duplicate_events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $3) AS client_messages
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $4`,
      [
        approvalId,
        approvalJob.jobId,
        duplicateId.message_id,
        duplicateJob.jobId,
      ],
    );
    expect(effects.rows).toEqual([
      {
        approval_count: "1",
        approval_requested_events: "1",
        client_messages: "0",
        duplicate_events: "0",
        last_client_sequence: "1",
        revision: 0,
        status: "running",
      },
    ]);
  });

  it("rejects approval.requested when its envelope expires at the job mutation boundary", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const approvalId = crypto.randomUUID();
    const envelopeExpiresAt = await expiryAfter(500);
    const message = envelope(
      "approval.requested",
      1,
      {
        approval_id: approvalId,
        job_id: job.jobId,
        attempt: 1,
        job_revision: 1,
        action_summary: "Boundary-expiring approval",
        impact_summary: "Must not persist after envelope expiry",
        risk_class: "approval_required",
        action_fingerprint: `sha256:${"a".repeat(64)}`,
        expires_at: new Date(String(await expiryAfter(120_000))).toISOString(),
      },
      { expiresAt: envelopeExpiresAt },
    );
    const gate = await createWriteBoundaryGate("jobs", envelopeExpiresAt);
    const acceptance = store.acceptClientMessage(testIdentity, message);
    const acceptanceOutcome = Promise.allSettled([acceptance]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await acceptanceOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    const effects = await database.query<{
      acknowledgements: string;
      approvals: string;
      client_messages: string;
      events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_client_sequence,
              (SELECT count(*)::text FROM approvals WHERE id = $1) AS approvals,
              (SELECT count(*)::text FROM job_events WHERE message_id = $2) AS events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $2) AS client_messages,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = $3 AND direction = 'server' AND type = 'ack'
                  AND payload->>'sequence' = '1') AS acknowledgements
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $4`,
      [approvalId, message.message_id, testIdentity.connectorId, job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        acknowledgements: "0",
        approvals: "0",
        client_messages: "0",
        events: "0",
        last_client_sequence: "0",
        revision: 0,
        status: "running",
      },
    ]);
  });

  it("rejects job.cancelled when its envelope expires at the cancellation mutation boundary", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "cancelling",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const envelopeExpiresAt = await expiryAfter(500);
    const message = envelope(
      "job.cancelled",
      1,
      {
        job_id: job.jobId,
        attempt: 1,
        reason: "Boundary-expiring cancellation",
      },
      { expiresAt: envelopeExpiresAt },
    );
    const gate = await createWriteBoundaryGate("jobs", envelopeExpiresAt);
    const acceptance = store.acceptClientMessage(testIdentity, message);
    const acceptanceOutcome = Promise.allSettled([acceptance]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await acceptanceOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    const effects = await database.query<{
      acknowledgements: string;
      client_messages: string;
      events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_client_sequence,
              (SELECT count(*)::text FROM job_events WHERE message_id = $1) AS events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $1) AS client_messages,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = $2 AND direction = 'server' AND type = 'ack'
                  AND payload->>'sequence' = '1') AS acknowledgements
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $3`,
      [message.message_id, testIdentity.connectorId, job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        acknowledgements: "0",
        client_messages: "0",
        events: "0",
        last_client_sequence: "0",
        revision: 0,
        status: "cancelling",
      },
    ]);
  });

  it("rejects a terminal cancellation audit when its envelope expires at the event write boundary", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    await database.query(
      `UPDATE jobs
          SET status = 'succeeded'::job_status,
              current_stage = 'succeeded',
              revision = 1,
              terminal_at = clock_timestamp(),
              unread_terminal = true
        WHERE id = $1`,
      [job.jobId],
    );
    const envelopeExpiresAt = await expiryAfter(500);
    const message = envelope(
      "job.cancelled",
      1,
      {
        job_id: job.jobId,
        attempt: 1,
        reason: "Late boundary-expiring cancellation",
      },
      { expiresAt: envelopeExpiresAt },
    );
    const gate = await createWriteBoundaryGate("job_events", envelopeExpiresAt);
    const acceptance = store.acceptClientMessage(testIdentity, message);
    const acceptanceOutcome = Promise.allSettled([acceptance]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await acceptanceOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    const effects = await database.query<{
      acknowledgements: string;
      client_messages: string;
      events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_client_sequence,
              (SELECT count(*)::text FROM job_events WHERE message_id = $1) AS events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $1) AS client_messages,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = $2 AND direction = 'server' AND type = 'ack'
                  AND payload->>'sequence' = '1') AS acknowledgements
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $3`,
      [message.message_id, testIdentity.connectorId, job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        acknowledgements: "0",
        client_messages: "0",
        events: "0",
        last_client_sequence: "0",
        revision: 1,
        status: "succeeded",
      },
    ]);
  });

  it.each(["job", "approval payload"] as const)(
    "rolls back approval.requested when the %s deadline crosses at the final audit write",
    async (deadline) => {
      const testIdentity = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      const boundaryExpiresAt = await expiryAfter(500);
      const jobExpiresAt =
        deadline === "job" ? boundaryExpiresAt : await expiryAfter(120_000);
      const approvalExpiresAt =
        deadline === "approval payload"
          ? boundaryExpiresAt
          : await expiryAfter(120_000);
      const job = await insertConnectedJob(
        testIdentity.connectorId,
        "running",
        jobExpiresAt,
        1,
        crypto.randomUUID(),
        await expiryAfter(60_000),
      );
      const approvalId = crypto.randomUUID();
      const message = envelope("approval.requested", 1, {
        approval_id: approvalId,
        job_id: job.jobId,
        attempt: 1,
        job_revision: 1,
        action_summary: "Final audit boundary approval",
        impact_summary: "Must roll back after the authoritative deadline",
        risk_class: "approval_required",
        action_fingerprint: `sha256:${"c".repeat(64)}`,
        expires_at: new Date(String(approvalExpiresAt)).toISOString(),
      });
      const gate = await createWriteBoundaryGate(
        "job_events",
        boundaryExpiresAt,
      );
      const acceptance = store.acceptClientMessage(testIdentity, message);
      const acceptanceOutcome = Promise.allSettled([acceptance]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      try {
        await gate.waitUntilBlocked();
        await gate.releaseAtExpiry();
        [outcome] = await acceptanceOutcome;
      } finally {
        await gate.dispose();
      }

      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "EVENT_REJECTED" },
      });
      const effects = await database.query<{
        acknowledgements: string;
        approvals: string;
        client_messages: string;
        events: string;
        last_client_sequence: string;
        revision: number;
        status: string;
      }>(
        `SELECT j.status, j.revision, c.last_client_sequence,
                (SELECT count(*)::text FROM approvals WHERE id = $1) AS approvals,
                (SELECT count(*)::text FROM job_events WHERE message_id = $2) AS events,
                (SELECT count(*)::text FROM connector_messages
                  WHERE direction = 'client' AND message_id = $2) AS client_messages,
                (SELECT count(*)::text FROM connector_messages
                  WHERE connector_id = $3 AND direction = 'server' AND type = 'ack'
                    AND payload->>'sequence' = '1') AS acknowledgements
           FROM jobs j
           JOIN connectors c ON c.id = j.connector_id
          WHERE j.id = $4`,
        [approvalId, message.message_id, testIdentity.connectorId, job.jobId],
      );
      expect(effects.rows).toEqual([
        {
          acknowledgements: "0",
          approvals: "0",
          client_messages: "0",
          events: "0",
          last_client_sequence: "0",
          revision: 0,
          status: "running",
        },
      ]);
    },
  );

  it("rolls back active job.cancelled when the job deadline crosses at the final audit write", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const jobExpiresAt = await expiryAfter(500);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "cancelling",
      jobExpiresAt,
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const message = envelope("job.cancelled", 1, {
      job_id: job.jobId,
      attempt: 1,
      reason: "Final audit boundary cancellation",
    });
    const gate = await createWriteBoundaryGate("job_events", jobExpiresAt);
    const acceptance = store.acceptClientMessage(testIdentity, message);
    const acceptanceOutcome = Promise.allSettled([acceptance]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await acceptanceOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    const effects = await database.query<{
      acknowledgements: string;
      client_messages: string;
      events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_client_sequence,
              (SELECT count(*)::text FROM job_events WHERE message_id = $1) AS events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $1) AS client_messages,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = $2 AND direction = 'server' AND type = 'ack'
                  AND payload->>'sequence' = '1') AS acknowledgements
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $3`,
      [message.message_id, testIdentity.connectorId, job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        acknowledgements: "0",
        client_messages: "0",
        events: "0",
        last_client_sequence: "0",
        revision: 0,
        status: "cancelling",
      },
    ]);
  });

  it.each(["envelope", "job"] as const)(
    "rolls back an active job.event when its %s deadline crosses at the final audit write",
    async (deadline) => {
      const testIdentity = await insertConnector();
      const store = new PostgresConnectorStore(database.client);
      const boundaryExpiresAt = await expiryAfter(500);
      const jobExpiresAt =
        deadline === "job" ? boundaryExpiresAt : await expiryAfter(120_000);
      const envelopeExpiresAt =
        deadline === "envelope"
          ? boundaryExpiresAt
          : await expiryAfter(120_000);
      const job = await insertConnectedJob(
        testIdentity.connectorId,
        "running",
        jobExpiresAt,
        1,
        crypto.randomUUID(),
        await expiryAfter(60_000),
      );
      const message = envelope(
        "job.event",
        1,
        {
          job_id: job.jobId,
          attempt: 1,
          event_type: "progress",
          source: "connector",
          payload: { stage: "boundary-progress" },
        },
        { expiresAt: envelopeExpiresAt },
      );
      const gate = await createWriteBoundaryGate(
        "job_events",
        boundaryExpiresAt,
      );
      const acceptance = store.acceptClientMessage(testIdentity, message);
      const acceptanceOutcome = Promise.allSettled([acceptance]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      try {
        await gate.waitUntilBlocked();
        await gate.releaseAtExpiry();
        [outcome] = await acceptanceOutcome;
      } finally {
        await gate.dispose();
      }

      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "EVENT_REJECTED" },
      });
      const effects = await database.query<{
        acknowledgements: string;
        client_messages: string;
        current_stage: string;
        events: string;
        last_client_sequence: string;
        revision: number;
        status: string;
      }>(
        `SELECT j.status, j.revision, j.current_stage, c.last_client_sequence,
                (SELECT count(*)::text FROM job_events WHERE message_id = $1) AS events,
                (SELECT count(*)::text FROM connector_messages
                  WHERE direction = 'client' AND message_id = $1) AS client_messages,
                (SELECT count(*)::text FROM connector_messages
                  WHERE connector_id = $2 AND direction = 'server' AND type = 'ack'
                    AND payload->>'sequence' = '1') AS acknowledgements
           FROM jobs j
           JOIN connectors c ON c.id = j.connector_id
          WHERE j.id = $3`,
        [message.message_id, testIdentity.connectorId, job.jobId],
      );
      expect(effects.rows).toEqual([
        {
          acknowledgements: "0",
          client_messages: "0",
          current_stage: "running",
          events: "0",
          last_client_sequence: "0",
          revision: 0,
          status: "running",
        },
      ]);
    },
  );

  it("rolls back a late terminal job.event when its envelope expires at the final audit write", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    await database.query(
      `UPDATE jobs
          SET status = 'succeeded'::job_status,
              current_stage = 'succeeded',
              revision = 1,
              terminal_at = clock_timestamp(),
              summary = '{"summary":"winner"}'::jsonb,
              unread_terminal = true
        WHERE id = $1`,
      [job.jobId],
    );
    const envelopeExpiresAt = await expiryAfter(500);
    const message = envelope(
      "job.event",
      1,
      {
        job_id: job.jobId,
        attempt: 1,
        event_type: "job.failed",
        source: "connector",
        payload: { summary: "late terminal" },
      },
      { expiresAt: envelopeExpiresAt },
    );
    const gate = await createWriteBoundaryGate("job_events", envelopeExpiresAt);
    const acceptance = store.acceptClientMessage(testIdentity, message);
    const acceptanceOutcome = Promise.allSettled([acceptance]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await acceptanceOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "EVENT_REJECTED" },
    });
    const effects = await database.query<{
      acknowledgements: string;
      client_messages: string;
      events: string;
      last_client_sequence: string;
      revision: number;
      status: string;
      summary: Record<string, unknown>;
    }>(
      `SELECT j.status, j.revision, j.summary, c.last_client_sequence,
              (SELECT count(*)::text FROM job_events WHERE message_id = $1) AS events,
              (SELECT count(*)::text FROM connector_messages
                WHERE direction = 'client' AND message_id = $1) AS client_messages,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = $2 AND direction = 'server' AND type = 'ack'
                  AND payload->>'sequence' = '1') AS acknowledgements
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $3`,
      [message.message_id, testIdentity.connectorId, job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        acknowledgements: "0",
        client_messages: "0",
        events: "0",
        last_client_sequence: "0",
        revision: 1,
        status: "succeeded",
        summary: { summary: "winner" },
      },
    ]);
  });

  it("rolls back an approval decision when its command expires at the final outbox write", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const repository = new JobRepository(database.client);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      await expiryAfter(120_000),
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const approvalId = crypto.randomUUID();
    const fingerprint = `sha256:${"d".repeat(64)}`;
    const requested = envelope("approval.requested", 1, {
      approval_id: approvalId,
      job_id: job.jobId,
      attempt: 1,
      job_revision: 1,
      action_summary: "Expiring outbox decision",
      impact_summary: "No undeliverable command may commit",
      risk_class: "approval_required",
      action_fingerprint: fingerprint,
      expires_at: new Date(String(await expiryAfter(120_000))).toISOString(),
    });
    await expect(
      store.acceptClientMessage(testIdentity, requested),
    ).resolves.toMatchObject({ response: { type: "ack" } });

    const commandExpiresAt = await expiryAfter(750);
    await database.query("UPDATE jobs SET expires_at = $1 WHERE id = $2", [
      commandExpiresAt,
      job.jobId,
    ]);
    const gate = await createWriteBoundaryGate(
      "connector_messages",
      commandExpiresAt,
    );
    const decision = repository.recordApprovalDecision({
      ownerId: OWNER_ID,
      approvalId,
      decision: "approve",
      expectedJobRevision: 1,
      expectedAttempt: 1,
      actionFingerprint: fingerprint,
    });
    const decisionOutcome = Promise.allSettled([decision]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await decisionOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "APPROVAL_EXPIRED" },
    });
    const effects = await database.query<{
      approval_decided_events: string;
      commands: string;
      decision: string | null;
      last_server_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT a.decision, j.status, j.revision, c.last_server_sequence,
              (SELECT count(*)::text FROM job_events
                WHERE job_id = j.id AND event_type = 'approval.decided')
                AS approval_decided_events,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = c.id AND direction = 'server'
                  AND type = 'approval.decision'
                  AND payload->>'approval_id' = a.id::text) AS commands
         FROM approvals a
         JOIN jobs j ON j.id = a.job_id
         JOIN connectors c ON c.id = j.connector_id
        WHERE a.id = $1`,
      [approvalId],
    );
    expect(effects.rows).toEqual([
      {
        approval_decided_events: "0",
        commands: "0",
        decision: null,
        last_server_sequence: "1",
        revision: 1,
        status: "waiting_approval",
      },
    ]);
  });

  it("rolls back cancellation when its command expires at the final outbox write", async () => {
    const testIdentity = await insertConnector();
    const repository = new JobRepository(database.client);
    const commandExpiresAt = await expiryAfter(750);
    const job = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      commandExpiresAt,
      1,
      crypto.randomUUID(),
      await expiryAfter(60_000),
    );
    const gate = await createWriteBoundaryGate(
      "connector_messages",
      commandExpiresAt,
    );
    const cancellation = repository.cancelAtomically({
      ownerId: OWNER_ID,
      jobId: job.jobId,
      expectedRevision: 0,
      reason: "Final outbox boundary cancellation",
    });
    const cancellationOutcome = Promise.allSettled([cancellation]);
    let outcome: PromiseSettledResult<unknown> | undefined;
    try {
      await gate.waitUntilBlocked();
      await gate.releaseAtExpiry();
      [outcome] = await cancellationOutcome;
    } finally {
      await gate.dispose();
    }

    expect(outcome).toMatchObject({ status: "rejected" });
    const effects = await database.query<{
      cancellation_events: string;
      commands: string;
      last_server_sequence: string;
      revision: number;
      status: string;
    }>(
      `SELECT j.status, j.revision, c.last_server_sequence,
              (SELECT count(*)::text FROM job_events
                WHERE job_id = j.id AND event_type = 'job.cancelling')
                AS cancellation_events,
              (SELECT count(*)::text FROM connector_messages
                WHERE connector_id = c.id AND direction = 'server'
                  AND type = 'job.cancel' AND payload->>'job_id' = j.id::text)
                AS commands
         FROM jobs j
         JOIN connectors c ON c.id = j.connector_id
        WHERE j.id = $1`,
      [job.jobId],
    );
    expect(effects.rows).toEqual([
      {
        cancellation_events: "0",
        commands: "0",
        last_server_sequence: "0",
        revision: 0,
        status: "running",
      },
    ]);
  });

  it("sanitizes all untrusted client text before durable persistence", async () => {
    const testIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    const approvalExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const approvalJob = await insertConnectedJob(
      testIdentity.connectorId,
      "running",
      new Date(Date.now() + 120_000),
      1,
      crypto.randomUUID(),
      new Date(Date.now() + 60_000),
    );
    const cancellationJob = await insertConnectedJob(
      testIdentity.connectorId,
      "cancelling",
      new Date(Date.now() + 120_000),
      1,
      crypto.randomUUID(),
      new Date(Date.now() + 60_000),
    );
    const approval = envelope("approval.requested", 1, {
      approval_id: crypto.randomUUID(),
      job_id: approvalJob.jobId,
      attempt: 1,
      job_revision: 1,
      action_summary: "Run with sk-abcdefghijklmnop",
      impact_summary: "Read /Users/ethan/private-repo",
      risk_class: "approval_required",
      action_fingerprint: `sha256:${"a".repeat(64)}`,
      expires_at: approvalExpiresAt,
    });
    const cancelled = envelope("job.cancelled", 2, {
      job_id: cancellationJob.jobId,
      attempt: 1,
      reason: "Authorization: Bearer abcdefghijklmnop",
    });

    await store.acceptClientMessage(testIdentity, approval);
    await store.acceptClientMessage(testIdentity, cancelled);

    const persisted = await database.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text
         FROM connector_messages
        WHERE connector_id = $1 AND message_id = ANY($2::uuid[])
        ORDER BY sequence`,
      [testIdentity.connectorId, [approval.message_id, cancelled.message_id]],
    );
    const serialized = persisted.rows.map((row) => row.payload_text).join("\n");
    expect(persisted.rows).toHaveLength(2);
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).not.toContain("/Users/ethan/private-repo");
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("caps each replay query and continues from the returned cursor", async () => {
    const batchIdentity = await insertConnector();
    const store = new PostgresConnectorStore(database.client);
    for (let index = 0; index <= SERVER_REPLAY_BATCH_SIZE; index += 1) {
      await store.enqueueServer(
        batchIdentity,
        "ack",
        { sequence: index + 1 },
        new Date(Date.now() + 60_000),
      );
    }

    const firstBatch = await store.pendingServerMessages(batchIdentity, 0);
    expect(firstBatch).toHaveLength(SERVER_REPLAY_BATCH_SIZE);
    const cursor = firstBatch.at(-1)?.sequence;
    if (cursor === undefined) throw new Error("expected a full replay batch");
    const secondBatch = await store.pendingServerMessages(
      batchIdentity,
      cursor,
    );
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]?.sequence).toBe(cursor + 1);
  });

  it("does not dispatch beyond a repository's configured concurrency", async () => {
    const repositoryId = `bounded-dispatch-${crypto.randomUUID()}`;
    const secondIdentity = await insertConnector();
    await database.query(
      `INSERT INTO repository_policies
         (id, owner_id, display_name, canonical_path,
          allowed_action_classes, max_concurrency)
       VALUES ($1, $2, 'Bounded repository', '/private/redacted',
               '[]'::jsonb, 1)`,
      [repositoryId, OWNER_ID],
    );
    const repository = new JobRepository(database.client);
    const firstJob = await repository.createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: cipher.encrypt("First bounded request"),
      requestDigest: `sha256:${"7".repeat(64)}`,
    });
    const secondJob = await repository.createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: cipher.encrypt("Second bounded request"),
      requestDigest: `sha256:${"8".repeat(64)}`,
    });
    const store = new PostgresConnectorStore(database.client);
    const secondStore = new PostgresConnectorStore(database.client);

    const offers = await Promise.all([
      store.dispatchNext(identity),
      secondStore.dispatchNext(secondIdentity),
    ]);
    expect(offers.filter((offer) => offer !== null)).toHaveLength(1);
    const offeredJobId = offers.find((offer) => offer !== null)?.payload.job_id;
    expect([firstJob.jobId, secondJob.jobId]).toContain(offeredJobId);
    const queuedJobId =
      offeredJobId === firstJob.jobId ? secondJob.jobId : firstJob.jobId;
    await expect(repository.get(queuedJobId)).resolves.toMatchObject({
      status: "queued",
      attempt: 0,
    });
  });
});
