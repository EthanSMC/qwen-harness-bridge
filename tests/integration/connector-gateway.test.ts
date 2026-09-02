import * as https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import {
  type ConnectorCredentials,
  FakeConnector,
  LOCALHOST_TLS,
} from "./support/fake-connector.js";
import { createTestDatabase, type TestDatabase } from "./support/postgres.js";

const db = createTestDatabase();
const OWNER_ID = "integration-gateway-owner";
const MCP_BEARER = "qhb-mcp-bearer-fixture-only";
const SESSION_SIGNING_KEY = "qhb-connector-session-signing-key-fixture-only";

type ConnectorGatewayOptions = {
  database: unknown;
  sessionSigningKey: string;
};

type GatewayAppOptions = Parameters<typeof createApp>[0] & {
  connectorGateway: ConnectorGatewayOptions;
};

const createGatewayApp = createApp as unknown as (
  options: GatewayAppOptions,
) => ReturnType<typeof createApp>;

const noOpCoordinator = {
  submit: async () => ({ status: "queued" }),
  list: async () => [],
  get: async () => ({}),
  cancel: async () => ({}),
  listApprovals: async () => [],
  decideApproval: async () => ({}),
  getResult: async () => ({}),
};

const seedConnector = async (
  database: TestDatabase,
): Promise<ConnectorCredentials> => {
  const connectorId = crypto.randomUUID();
  const credentialId = `credential-${crypto.randomUUID()}`;
  const credentialSecret = `connector-secret-${crypto.randomUUID()}`;
  await database.query(
    `
      INSERT INTO owners (id, display_name)
      VALUES ($1, 'gateway integration owner')
      ON CONFLICT (id) DO NOTHING
    `,
    [OWNER_ID],
  );
  await database.query(
    `
      INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
      VALUES ($1, $2, $3, $4)
    `,
    [
      connectorId,
      OWNER_ID,
      credentialId,
      await hashConnectorCredential(credentialSecret),
    ],
  );
  return {
    connector_id: connectorId,
    credential_id: credentialId,
    credential_secret: credentialSecret,
  };
};

const startApp = async () => {
  const app = await createGatewayApp({
    coordinator: noOpCoordinator as never,
    ownerId: OWNER_ID,
    mcpBearerToken: MCP_BEARER,
    https: LOCALHOST_TLS,
    connectorGateway: {
      database: db.client,
      sessionSigningKey: SESSION_SIGNING_KEY,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
};

beforeAll(async () => {
  await db.start();
});

afterAll(async () => {
  await db.stop();
});

describe("Connector gateway authentication and handshake", () => {
  it("exchanges a device credential, rejects the Qwen MCP bearer, and completes TLS hello/welcome", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    try {
      expect(app.server).toBeInstanceOf(https.Server);

      const session = await FakeConnector.exchangeSession(app, credentials);
      expect(session.token).toEqual(expect.any(String));
      expect(session.expires_at).toEqual(expect.any(String));
      expect(Date.parse(session.expires_at ?? "")).toBeGreaterThan(Date.now());

      await expect(
        FakeConnector.exchangeSession(app, {
          ...credentials,
          credential_secret: MCP_BEARER,
        }),
      ).rejects.toMatchObject({ statusCode: 401 });

      const connector = await FakeConnector.connect(app, credentials);
      try {
        const welcome = connector.received.find(
          (message) => message.type === "connector.welcome",
        );
        expect(welcome).toMatchObject({
          type: "connector.welcome",
          payload: { connector_id: credentials.connector_id },
        });
        expect(welcome?.sequence).toBeGreaterThan(0);

        const lastClientSequence = connector.lastClientSequence;
        const lastServerSequence = connector.lastServerSequence;
        await connector.disconnectWithoutAck();
        const resumed = await FakeConnector.connect(app, {
          ...credentials,
          last_client_sequence: lastClientSequence,
          last_server_sequence: lastServerSequence,
        });
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          expect(
            resumed.wireReceived.every(
              (message) => message.sequence > lastServerSequence,
            ),
          ).toBe(true);
        } finally {
          await resumed.close();
        }
      } finally {
        await connector.close();
      }
    } finally {
      await app.close();
    }
  });

  it("persists and returns protocol.error before closing a sequence gap", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      await connector.send(
        "connector.heartbeat",
        {},
        { sequence: connector.lastClientSequence + 2 },
      );
      await expect(connector.next("protocol.error")).resolves.toMatchObject({
        payload: { code: "CLIENT_SEQUENCE_GAP" },
      });
    } finally {
      await connector.close();
      await app.close();
    }
  });
});
