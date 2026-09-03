import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import {
  Aes256GcmEncryptor,
  JobCoordinator,
} from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import { FakeConnector } from "./support/fake-connector.js";
import { createTestDatabase } from "./support/postgres.js";
import { LOCALHOST_TLS } from "./support/tls.js";

const database = createTestDatabase();

beforeAll(async () => {
  await database.start();
});

afterAll(async () => {
  await database.stop();
});

const waitForStatus = async (jobId: string, status: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await database.query<{ status: string }>(
      "SELECT status FROM jobs WHERE id = $1",
      [jobId],
    );
    if (result.rows[0]?.status === status) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for job status ${status}`);
};

const nextAckFor = async (connector: FakeConnector, clientSequence: number) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ack = await connector.next("ack");
    if (ack.payload.sequence === clientSequence) return ack;
  }
  throw new Error(
    `Timed out waiting for ACK of client sequence ${clientSequence}`,
  );
};

const waitForWireOccurrences = async (
  connector: FakeConnector,
  messageId: string,
  expected: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      connector.wireReceived.filter(
        (message) => message.message_id === messageId,
      ).length >= expected
    ) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${expected} wire deliveries`);
};

describe("Foundation fake Connector end to end", () => {
  it("deduplicates replayed delivery after reconnecting with a differently cased UUID", async () => {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const repositoryId = `repo-${crypto.randomUUID()}`;
    const connectorId = `a${crypto.randomUUID().slice(1)}`;
    const credentialId = `credential-${crypto.randomUUID()}`;
    const credentialSecret = `connector-secret-${crypto.randomUUID()}`;
    await database.query(
      "INSERT INTO owners (id, display_name) VALUES ($1, 'Foundation owner')",
      [ownerId],
    );
    await database.query(
      `INSERT INTO repository_policies
         (id, owner_id, display_name, canonical_path, allowed_action_classes)
       VALUES ($1, $2, 'Foundation repository', '/private/redacted', '[]'::jsonb)`,
      [repositoryId, ownerId],
    );
    await database.query(
      `INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        connectorId,
        ownerId,
        credentialId,
        await hashConnectorCredential(credentialSecret),
      ],
    );

    const repository = new JobRepository(database.client);
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(91));
    const coordinator = new JobCoordinator({
      repository,
      encryptor: cipher,
      now: () => new Date(),
    });
    const app = await createApp({
      coordinator,
      ownerId,
      mcpBearerToken: "foundation-mcp-bearer-fixture-only",
      https: LOCALHOST_TLS,
      connectorGateway: {
        database: database.client,
        sessionSigningKey:
          "foundation-connector-session-signing-key-with-32-bytes",
        requestDecryptor: cipher,
        dispatchIntervalMs: 10,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const credentials = {
      connector_id: connectorId,
      credential_id: credentialId,
      credential_secret: credentialSecret,
    };
    const connector = await FakeConnector.connect(app, credentials);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer({ coordinator, ownerId });
    const mcp = new Client({ name: "foundation-e2e", version: "1.0.0" });

    try {
      await mcpServer.connect(serverTransport);
      await mcp.connect(clientTransport);
      const receipt = await mcp.callTool({
        name: "submit_task",
        arguments: {
          client_request_id: crypto.randomUUID(),
          repository_id: repositoryId,
          request: "Run the complete fake Connector foundation flow",
          mode: "normal",
        },
      });
      expect(receipt.isError).not.toBe(true);
      const jobId = (receipt.structuredContent as { job_id: string }).job_id;
      const offer = await connector.next("job.offer");
      expect(offer.payload.job_id).toBe(jobId);
      expect(offer.payload.request).toBe(
        "Run the complete fake Connector foundation flow",
      );

      await connector.send("job.claim", {
        job_id: jobId,
        attempt: offer.payload.attempt,
        lease_id: offer.payload.lease_id,
      });
      await waitForStatus(jobId, "running");
      await connector.disconnectWithoutAck();

      const resumed = await FakeConnector.connect(app, {
        ...credentials,
        connector_id: credentials.connector_id.toUpperCase(),
        last_client_sequence: connector.lastClientSequence,
        last_server_sequence: 0,
      });
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(
          resumed.received.filter((message) => message.type === "job.offer"),
        ).toHaveLength(0);
        expect(
          resumed.wireReceived.filter(
            (message) => message.type === "job.offer",
          ),
        ).toHaveLength(1);
        for (let index = 1; index < resumed.wireReceived.length; index += 1) {
          expect(resumed.wireReceived[index]?.sequence).toBeGreaterThan(
            resumed.wireReceived[index - 1]?.sequence ?? 0,
          );
        }

        const event = await resumed.send("job.event", {
          job_id: jobId,
          attempt: offer.payload.attempt,
          event_type: "progress",
          payload: { stage: "testing", summary: "Focused tests are green" },
          source: "fake-connector",
        });
        const eventAck = await nextAckFor(resumed, event.sequence);
        expect(eventAck.payload.sequence).toBe(event.sequence);
        await resumed.send("job.event", event.payload, {
          message_id: event.message_id,
          sequence: event.sequence,
          correlation_id: event.correlation_id,
          sent_at: event.sent_at,
          expires_at: event.expires_at,
        });
        await waitForWireOccurrences(resumed, eventAck.message_id, 2);

        const eventCount = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM job_events
            WHERE job_id = $1 AND message_id = $2`,
          [jobId, event.message_id],
        );
        expect(eventCount.rows[0]?.count).toBe("1");
      } finally {
        await resumed.close();
      }
    } finally {
      await Promise.allSettled([mcp.close(), mcpServer.close()]);
      await app.close();
    }
  });

  it("rejects a case-variant reconnect when a tombstone reuses a recorded server sequence", async () => {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const connectorId = `a${crypto.randomUUID().slice(1)}`;
    const credentialId = `credential-${crypto.randomUUID()}`;
    const credentialSecret = `connector-secret-${crypto.randomUUID()}`;
    await database.query(
      "INSERT INTO owners (id, display_name) VALUES ($1, 'Sequence owner')",
      [ownerId],
    );
    await database.query(
      `INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        connectorId,
        ownerId,
        credentialId,
        await hashConnectorCredential(credentialSecret),
      ],
    );

    const repository = new JobRepository(database.client);
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(91));
    const coordinator = new JobCoordinator({
      repository,
      encryptor: cipher,
      now: () => new Date(),
    });
    const app = await createApp({
      coordinator,
      ownerId,
      mcpBearerToken: "sequence-mismatch-mcp-bearer-fixture-only",
      https: LOCALHOST_TLS,
      connectorGateway: {
        database: database.client,
        sessionSigningKey:
          "sequence-mismatch-connector-session-signing-key-with-32-bytes",
        requestDecryptor: cipher,
        dispatchIntervalMs: 10,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const credentials = {
      connector_id: connectorId,
      credential_id: credentialId,
      credential_secret: credentialSecret,
    };
    let connector: FakeConnector | undefined;
    try {
      connector = await FakeConnector.connect(app, credentials);
      const welcome = connector.received.find(
        (message) => message.type === "connector.welcome",
      );
      if (welcome === undefined) {
        throw new Error("FakeConnector did not receive its welcome message");
      }

      const expired = await database.query<{ message_id: string }>(
        `UPDATE connector_messages
            SET expires_at = now() - interval '1 second'
          WHERE connector_id = $1
            AND direction = 'server'
            AND sequence = $2
            AND message_id = $3
          RETURNING message_id`,
        [connectorId, welcome.sequence, welcome.message_id],
      );
      expect(expired.rows).toHaveLength(1);

      await connector.disconnectWithoutAck();
      await expect(
        FakeConnector.connect(app, {
          ...credentials,
          connector_id: credentials.connector_id.toUpperCase(),
          last_client_sequence: connector.lastClientSequence,
          last_server_sequence: 0,
        }),
      ).rejects.toThrow(
        "FakeConnector received a different message for a sequence",
      );
    } finally {
      if (connector !== undefined) await connector.close();
      await app.close();
    }
  });
});
