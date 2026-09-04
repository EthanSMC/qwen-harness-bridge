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
    const expiresAt = await expiryAfter(250);
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
    const accepted = store.acceptClientMessage(raceIdentity, event, now);
    let cancelled: Promise<unknown> | undefined;
    try {
      await locksHeld;
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
