import * as https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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

const sendRawFrame = (
  socket: Duplex,
  opcode: number,
  payload: Buffer,
): void => {
  const mask = Buffer.from(crypto.randomUUID().replaceAll("-", "")).subarray(
    0,
    4,
  );
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, headerLength);
  for (let index = 0; index < length; index += 1) {
    frame[headerLength + 4 + index] =
      (payload[index] ?? 0) ^ (mask[index % mask.length] ?? 0);
  }
  socket.write(frame);
};

const readClosePayload = (chunks: readonly Buffer[]): Buffer | undefined => {
  const frame = Buffer.concat(chunks);
  if (frame.length < 2 || ((frame[0] ?? 0) & 0x0f) !== 0x8) {
    return undefined;
  }
  const length = (frame[1] ?? 0) & 0x7f;
  if (frame.length < 2 + length) return undefined;
  return frame.subarray(2, 2 + length);
};

const readCloseCode = (chunks: readonly Buffer[]): number | undefined => {
  const payload = readClosePayload(chunks);
  if (payload === undefined || payload.length < 2) return undefined;
  return payload.readUInt16BE(0);
};

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

const startApp = async (dispatchIntervalMs?: number) => {
  const app = await createGatewayApp({
    coordinator: noOpCoordinator as never,
    ownerId: OWNER_ID,
    mcpBearerToken: MCP_BEARER,
    https: LOCALHOST_TLS,
    connectorGateway: {
      database: db.client,
      sessionSigningKey: SESSION_SIGNING_KEY,
      ...(dispatchIntervalMs === undefined ? {} : { dispatchIntervalMs }),
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
};

const rawConnectorSocket = async (
  app: Awaited<ReturnType<typeof startApp>>,
  credentials: ConnectorCredentials,
): Promise<Duplex> => {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Gateway app is not listening on a TCP address");
  }
  const session = await FakeConnector.exchangeSession(app, credentials);
  const key = Buffer.from(
    crypto.randomUUID().replaceAll("-", ""),
    "hex",
  ).toString("base64");
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port: (address as AddressInfo).port,
      path: "/connector/v1",
      method: "GET",
      ca: LOCALHOST_TLS.cert,
      rejectUnauthorized: true,
      headers: {
        authorization: `Bearer ${session.token}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
      },
    });
    request.once("upgrade", (response, socket) => {
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`Connector upgrade returned ${response.statusCode}`));
        return;
      }
      resolve(socket);
    });
    request.once("response", (response) => {
      response.resume();
      reject(new Error(`Connector upgrade returned ${response.statusCode}`));
    });
    request.once("error", reject);
    request.end();
  });
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
      await expect(
        FakeConnector.connectWithSessionToken(app, credentials, MCP_BEARER),
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

  it("retransmits an already-sent ACK for an exact duplicate client message", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      const heartbeat = await connector.send("connector.heartbeat", {});
      const originalAck = await connector.next("ack");

      await connector.send(
        "connector.heartbeat",
        {},
        {
          message_id: heartbeat.message_id,
          sequence: heartbeat.sequence,
          correlation_id: heartbeat.correlation_id,
          sent_at: heartbeat.sent_at,
          expires_at: heartbeat.expires_at,
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(
        connector.wireReceived.filter(
          (message) => message.message_id === originalAck.message_id,
        ),
      ).toEqual([originalAck, originalAck]);
    } finally {
      await connector.close();
      await app.close();
    }
  });

  it("does not process frames queued after a protocol failure begins", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    const lastAcceptedClientSequence = connector.lastClientSequence;
    try {
      const gap = await connector.send(
        "connector.heartbeat",
        {},
        { sequence: lastAcceptedClientSequence + 2 },
      );
      await connector.send(
        "connector.heartbeat",
        {},
        { sequence: gap.sequence + 1 },
      );

      await expect(connector.next("protocol.error")).resolves.toMatchObject({
        payload: { code: "CLIENT_SEQUENCE_GAP" },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const state = await db.query<{ last_client_sequence: number }>(
        "SELECT last_client_sequence FROM connectors WHERE id = $1",
        [credentials.connector_id],
      );
      expect(Number(state.rows[0]?.last_client_sequence)).toBe(
        lastAcceptedClientSequence,
      );
      expect(
        connector.wireReceived.filter(
          (message) => message.type === "protocol.error",
        ),
      ).toHaveLength(1);
    } finally {
      await connector.close();
      await app.close();
    }
  });

  it("does not flush queued application frames after protocol failure begins", async () => {
    const app = await startApp(5_000);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const firstSequence = connector.lastServerSequence + 1;
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      for (let index = 0; index < 32; index += 1) {
        await db.query(
          `
            INSERT INTO connector_messages
              (connector_id, direction, sequence, message_id, type, payload, correlation_id, expires_at)
            VALUES ($1, 'server', $2, $3, 'ack', $4::jsonb, $5, $6)
          `,
          [
            credentials.connector_id,
            firstSequence + index,
            crypto.randomUUID(),
            JSON.stringify({ sequence: 10_000 + index }),
            crypto.randomUUID(),
            expiresAt,
          ],
        );
      }
      await db.query(
        "UPDATE connectors SET last_server_sequence = $2 WHERE id = $1",
        [credentials.connector_id, firstSequence + 31],
      );

      await connector.sendFrameForTest(0x1, "{");
      await connector.waitForClose();

      expect(
        connector.wireReceived.filter((message) => message.type === "ack"),
      ).toHaveLength(0);
      expect(
        connector.wireReceived.filter(
          (message) => message.type === "protocol.error",
        ),
      ).toHaveLength(0);
    } finally {
      await connector.close();
      await app.close();
    }
  });

  it.each([
    ["reserved close status code", Buffer.from([0x03, 0xed])],
    ["invalid UTF-8 close reason", Buffer.from([0x03, 0xe8, 0xff])],
  ])("rejects a %s with close status 1002", async (_name, payload) => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const socket = await rawConnectorSocket(app, credentials);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    try {
      sendRawFrame(socket, 0x8, payload);
      await expect(closed).resolves.toBeUndefined();
      expect(readCloseCode(chunks)).toBe(1002);
    } finally {
      socket.destroy();
      await app.close();
    }
  });

  it.each([1012, 1013, 1014])(
    "accepts registered close status code %s",
    async (statusCode) => {
      const app = await startApp();
      const credentials = await seedConnector(db);
      const socket = await rawConnectorSocket(app, credentials);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      try {
        sendRawFrame(
          socket,
          0x8,
          Buffer.from([(statusCode >> 8) & 0xff, statusCode & 0xff]),
        );
        await expect(closed).resolves.toBeUndefined();
        expect(readClosePayload(chunks)).toEqual(Buffer.alloc(0));
      } finally {
        socket.destroy();
        await app.close();
      }
    },
  );

  it("closes on RSV and oversized or invalid control frames", async () => {
    const invalidFrames = [
      { name: "RSV1", rsv: 0x40, opcode: 0x1, payload: "{}" },
      { name: "oversized ping", rsv: 0, opcode: 0x9, payload: "x".repeat(126) },
      { name: "one-byte close", rsv: 0, opcode: 0x8, payload: "x" },
    ] as const;

    for (const frame of invalidFrames) {
      const app = await startApp();
      const credentials = await seedConnector(db);
      const connector = await FakeConnector.connect(app, credentials);
      try {
        await connector.sendFrameForTest(
          frame.opcode,
          frame.payload,
          frame.rsv,
        );
        await expect(connector.waitForClose()).resolves.toBeUndefined();
        expect(
          connector.wireReceived.some(
            (message) => message.type === "protocol.error",
          ),
        ).toBe(false);
      } finally {
        await connector.close();
        await app.close();
      }
    }
  });
});
