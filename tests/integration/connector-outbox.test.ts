import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
} from "@qhb/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConnectorStoreError,
  PostgresConnectorStore,
  storedServerMessageContainsPlaintextRequest,
} from "../../apps/control-plane/src/connector/outbox.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { Aes256GcmEncryptor } from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createTestDatabase } from "./support/postgres.js";

const database = createTestDatabase();
const OWNER_ID = "connector-outbox-owner";
const REPOSITORY_ID = "connector-outbox-repository";
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000051";
const CREDENTIAL_ID = "connector-outbox-credential";
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
  overrides: { messageId?: string; correlationId?: string } = {},
): Extract<ConnectorClientMessage, { type: T }> => {
  const sentAt = new Date();
  return ConnectorClientMessageSchema.parse({
    protocol_version: "1.0",
    message_id: overrides.messageId ?? crypto.randomUUID(),
    sequence,
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + 60_000).toISOString(),
    correlation_id: overrides.correlationId ?? crypto.randomUUID(),
    type,
    payload,
  }) as Extract<ConnectorClientMessage, { type: T }>;
};

const expectStoreError = async (
  operation: Promise<unknown>,
  code: ConnectorStoreError["code"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
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

  it("claims only the stored live lease and appends a duplicate event once", async () => {
    const store = new PostgresConnectorStore(database.client);
    const pending = await store.pendingServerMessages(identity, 0);
    const storedOffer = pending.find((message) => message.type === "job.offer");
    expect(storedOffer).toBeDefined();
    const payload = storedOffer?.payload as {
      job_id: string;
      attempt: number;
      lease_id: string;
    };

    const wrongClaim = envelope("job.claim", 2, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      lease_id: crypto.randomUUID(),
    });
    await expectStoreError(
      store.acceptClientMessage(identity, wrongClaim),
      "CLAIM_REJECTED",
    );

    const claim = envelope("job.claim", 2, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      lease_id: payload.lease_id,
    });
    await expect(
      store.acceptClientMessage(identity, claim),
    ).resolves.toMatchObject({
      duplicate: false,
      response: { type: "ack" },
    });

    const progress = envelope("job.event", 3, {
      job_id: payload.job_id,
      attempt: payload.attempt,
      event_type: "progress",
      payload: { stage: "testing", summary: "Focused tests are running" },
      source: "fake-connector",
    });
    await store.acceptClientMessage(identity, progress);
    await store.acceptClientMessage(identity, progress);

    const events = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM job_events
        WHERE job_id = $1 AND message_id = $2`,
      [payload.job_id, progress.message_id],
    );
    expect(events.rows[0]?.count).toBe("1");
  });
});
