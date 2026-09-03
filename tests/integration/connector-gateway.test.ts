import { createHash } from "node:crypto";
import * as https from "node:https";
import { type AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import {
  ConnectorStoreError,
  PostgresConnectorStore,
} from "../../apps/control-plane/src/connector/outbox.js";
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
  options: {
    fin?: boolean;
    masked?: boolean;
    rsv?: number;
    lengthCode?: 126 | 127;
  } = {},
): void => {
  const fin = options.fin ?? true;
  const masked = options.masked ?? true;
  const rsv = options.rsv ?? 0;
  const mask = masked
    ? Buffer.from(crypto.randomUUID().replaceAll("-", "")).subarray(0, 4)
    : undefined;
  const length = payload.length;
  const lengthCode =
    options.lengthCode ?? (length < 126 ? 0 : length <= 0xffff ? 126 : 127);
  const headerLength = lengthCode === 0 ? 2 : lengthCode === 126 ? 4 : 10;
  const frame = Buffer.alloc(headerLength + (masked ? 4 : 0) + length);
  frame[0] = (fin ? 0x80 : 0) | (rsv & 0x70) | opcode;
  if (lengthCode === 0) {
    frame[1] = (masked ? 0x80 : 0) | length;
  } else if (lengthCode === 126) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskOffset = headerLength;
  mask?.copy(frame, maskOffset);
  for (let index = 0; index < length; index += 1) {
    frame[maskOffset + (masked ? 4 : 0) + index] = masked
      ? (payload[index] ?? 0) ^ (mask?.[index % 4] ?? 0)
      : (payload[index] ?? 0);
  }
  socket.write(frame);
};

const waitForServerMessage = async (
  socket: Duplex,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> => {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("Timed out waiting for server message"));
    }, 2_000);
    const finish = (message: Record<string, unknown>): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
      resolve(message);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0] ?? 0;
        const second = buffer[1] ?? 0;
        const lengthCode = second & 0x7f;
        let offset = 2;
        let length = lengthCode;
        if (lengthCode === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (lengthCode === 127) {
          if (buffer.length < 10) return;
          const extended = buffer.readBigUInt64BE(2);
          if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
            reject(new Error("Server frame is too large for test parser"));
            return;
          }
          length = Number(extended);
          offset = 10;
        }
        const frameLength = offset + length;
        if (buffer.length < frameLength) return;
        const payload = buffer.subarray(offset, frameLength);
        buffer = buffer.subarray(frameLength);
        if ((first & 0x0f) !== 0x1) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString("utf8"));
        } catch {
          reject(new Error("Server text frame was not JSON"));
          return;
        }
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          predicate(parsed as Record<string, unknown>)
        ) {
          finish(parsed as Record<string, unknown>);
          return;
        }
      }
    };
    socket.on("data", onData);
  });
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

const startNonMinimalFrameServer = async (
  lengthCode: 126 | 127,
): Promise<{ server: https.Server; socket: Duplex | undefined }> => {
  let upgradedSocket: Duplex | undefined;
  const server = https.createServer(LOCALHOST_TLS);
  server.on("upgrade", (request, socket) => {
    upgradedSocket = socket;
    socket.on("error", () => undefined);
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once("data", () => {
      sendRawFrame(socket, 0x1, Buffer.from("{}"), {
        masked: false,
        lengthCode,
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  return {
    server,
    get socket() {
      return upgradedSocket;
    },
  };
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

  it("does not overlap dispatch database work after its deadline", async () => {
    const originalDispatchNext = PostgresConnectorStore.prototype.dispatchNext;
    let activeDispatches = 0;
    let maximumActiveDispatches = 0;
    let releaseDispatch: (() => void) | undefined;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const firstDispatchStarted = new Promise<void>((resolve) => {
      vi.spyOn(
        PostgresConnectorStore.prototype,
        "dispatchNext",
      ).mockImplementation(async function (identity, now) {
        activeDispatches += 1;
        maximumActiveDispatches = Math.max(
          maximumActiveDispatches,
          activeDispatches,
        );
        resolve();
        try {
          await dispatchBlocked;
          return await originalDispatchNext.call(this, identity, now);
        } finally {
          activeDispatches -= 1;
        }
      });
    });
    const app = await startApp(10);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      await firstDispatchStarted;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_150));
      expect(maximumActiveDispatches).toBe(1);
    } finally {
      releaseDispatch?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await connector.close();
      await app.close();
      vi.restoreAllMocks();
    }
  });

  it("does not start new store work while a timed-out pending scan is running", async () => {
    const originalDispatchNext = PostgresConnectorStore.prototype.dispatchNext;
    const originalPendingServerMessages =
      PostgresConnectorStore.prototype.pendingServerMessages;
    let dispatchStarts = 0;
    let storeStartsWhilePending = 0;
    let pendingBlocked = false;
    let blockedPending = false;
    let releasePending: (() => void) | undefined;
    let pendingStartedResolve!: () => void;
    const pendingStarted = new Promise<void>((resolve) => {
      pendingStartedResolve = resolve;
    });
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "dispatchNext",
    ).mockImplementation(async function (identity, now) {
      dispatchStarts += 1;
      if (pendingBlocked) storeStartsWhilePending += 1;
      return originalDispatchNext.call(this, identity, now);
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "pendingServerMessages",
    ).mockImplementation(async function (identity, afterSequence, now) {
      if (pendingBlocked) storeStartsWhilePending += 1;
      if (!blockedPending && dispatchStarts > 0) {
        blockedPending = true;
        pendingBlocked = true;
        pendingStartedResolve();
        try {
          await pendingGate;
        } finally {
          pendingBlocked = false;
        }
      }
      return originalPendingServerMessages.call(
        this,
        identity,
        afterSequence,
        now,
      );
    });

    const app = await startApp(10);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      await pendingStarted;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_150));

      expect(storeStartsWhilePending).toBe(0);
      expect(dispatchStarts).toBe(1);

      releasePending?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(dispatchStarts).toBeGreaterThan(1);
    } finally {
      releasePending?.();
      await connector.close();
      await app.close();
      vi.restoreAllMocks();
    }
  });

  it("refetches an offer that expires during materialization as a same-sequence tombstone", async () => {
    const credentials = await seedConnector(db);
    const store = new PostgresConnectorStore(db.client);
    const offer = await store.enqueueServer(
      {
        ownerId: OWNER_ID,
        connectorId: credentials.connector_id,
        protocolVersion: "1.0",
      },
      "job.offer",
      {
        job_id: crypto.randomUUID(),
        attempt: 1,
        lease_id: crypto.randomUUID(),
        repository_id: crypto.randomUUID(),
      },
      new Date(Date.now() + 60_000),
    );
    const tombstone = {
      ...offer,
      messageId: crypto.randomUUID(),
      type: "protocol.error" as const,
      payload: {
        code: "MESSAGE_EXPIRED",
        message: "A Connector message expired before delivery.",
      },
      expiresAt: new Date(Date.now() + 60_000),
    };
    const originalMaterializeServerMessage =
      PostgresConnectorStore.prototype.materializeServerMessage;
    const originalPendingServerMessages =
      PostgresConnectorStore.prototype.pendingServerMessages;
    let threwExpired = false;
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "materializeServerMessage",
    ).mockImplementation(async function (stored, decryptor) {
      if (!threwExpired && stored.sequence === offer.sequence) {
        threwExpired = true;
        throw new ConnectorStoreError("MESSAGE_EXPIRED" as never);
      }
      return originalMaterializeServerMessage.call(this, stored, decryptor);
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "pendingServerMessages",
    ).mockImplementation(async function (identity, afterSequence, now) {
      const pending = await originalPendingServerMessages.call(
        this,
        identity,
        afterSequence,
        now,
      );
      if (!threwExpired || afterSequence >= offer.sequence) return pending;
      return pending.map((message) =>
        message.sequence === offer.sequence ? tombstone : message,
      );
    });

    const app = await startApp(50);
    let connector: FakeConnector | undefined;
    try {
      connector = await FakeConnector.connect(app, credentials);
      expect(
        connector.wireReceived.filter(
          (message) => message.type === "protocol.error",
        ),
      ).toEqual([
        expect.objectContaining({
          message_id: tombstone.messageId,
          sequence: offer.sequence,
          type: "protocol.error",
          payload: expect.objectContaining({ code: "MESSAGE_EXPIRED" }),
        }),
      ]);

      const heartbeat = await connector.send("connector.heartbeat", {});
      await expect(connector.next("ack")).resolves.toMatchObject({
        payload: { sequence: heartbeat.sequence },
      });
    } finally {
      if (connector !== undefined) await connector.close();
      await app.close();
      vi.restoreAllMocks();
    }
  });

  it("does not initialize a connector after its hello is accepted too late", async () => {
    const originalAcceptClientMessage =
      PostgresConnectorStore.prototype.acceptClientMessage;
    let releaseAccept: (() => void) | undefined;
    let acceptStartedResolve!: () => void;
    const acceptStarted = new Promise<void>((resolve) => {
      acceptStartedResolve = resolve;
    });
    const acceptBlocked = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "acceptClientMessage",
    ).mockImplementation(async function (identity, message, now) {
      acceptStartedResolve();
      await acceptBlocked;
      return originalAcceptClientMessage.call(this, identity, message, now);
    });

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    let socket: Duplex | undefined;
    let appClosed = false;
    try {
      app = await startApp(10);
      const credentials = await seedConnector(db);
      socket = await rawConnectorSocket(app, credentials);
      const intervalsBeforeHelloReturn = setIntervalSpy.mock.calls.length;
      sendRawFrame(
        socket,
        0x1,
        Buffer.from(
          JSON.stringify({
            protocol_version: "1.0",
            message_id: crypto.randomUUID(),
            sequence: 1,
            sent_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            correlation_id: crypto.randomUUID(),
            type: "connector.hello",
            payload: {
              connector_id: credentials.connector_id,
              connector_version: "raw-close-race-test/1.0",
              capabilities: ["harness", "integration-test"],
              last_server_sequence: 0,
              last_client_sequence: 0,
            },
          }),
        ),
      );
      await acceptStarted;

      await app.close();
      appClosed = true;
      releaseAccept?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(setIntervalSpy.mock.calls.length).toBe(intervalsBeforeHelloReturn);
    } finally {
      releaseAccept?.();
      socket?.destroy();
      if (app !== undefined && !appClosed) await app.close();
      vi.restoreAllMocks();
    }
  });

  it("rejects a second connector hello after initialization", async () => {
    const app = await startApp(5_000);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      const welcomeCount = connector.wireReceived.filter(
        (message) => message.type === "connector.welcome",
      ).length;
      const lastClientSequence = connector.lastClientSequence;
      const lastServerSequence = connector.lastServerSequence;
      await connector.send("connector.hello", {
        connector_id: credentials.connector_id,
        connector_version: "fake-connector/1.0",
        capabilities: ["harness", "integration-test"],
        last_server_sequence: lastServerSequence,
        last_client_sequence: lastClientSequence,
      });

      await expect(connector.next("protocol.error")).resolves.toMatchObject({
        payload: { code: "HELLO_ALREADY_INITIALIZED" },
      });
      expect(
        connector.wireReceived.filter(
          (message) => message.type === "connector.welcome",
        ),
      ).toHaveLength(welcomeCount);
    } finally {
      await connector.close();
      await app.close();
    }
  });

  it("caps authenticated messages queued behind a blocked consumer", async () => {
    const originalAcceptClientMessage =
      PostgresConnectorStore.prototype.acceptClientMessage;
    let activeAccepts = 0;
    let maximumActiveAccepts = 0;
    let releaseAccept: (() => void) | undefined;
    let firstHeartbeatStarted!: () => void;
    const heartbeatStarted = new Promise<void>((resolve) => {
      firstHeartbeatStarted = resolve;
    });
    const acceptBlocked = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "acceptClientMessage",
    ).mockImplementation(async function (identity, message, now) {
      if (message.type === "connector.heartbeat") {
        activeAccepts += 1;
        maximumActiveAccepts = Math.max(maximumActiveAccepts, activeAccepts);
        firstHeartbeatStarted();
        try {
          await acceptBlocked;
        } finally {
          activeAccepts -= 1;
        }
      }
      return originalAcceptClientMessage.call(this, identity, message, now);
    });

    const app = await startApp(5_000);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for bounded queue shutdown"));
      }, 2_000);
      timer.unref();
    });
    try {
      await connector.send("connector.heartbeat", {});
      await heartbeatStarted;
      for (let index = 0; index < 512; index += 1) {
        await connector.send("connector.heartbeat", {});
      }

      await expect(
        Promise.race([connector.waitForClose(), timeout]),
      ).resolves.toBeUndefined();
      expect(maximumActiveAccepts).toBe(1);
    } finally {
      releaseAccept?.();
      await connector.close();
      await app.close();
      vi.restoreAllMocks();
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

  it("accepts fragmented text with an interleaved ping control frame", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const socket = await rawConnectorSocket(app, credentials);
    const hello = JSON.stringify({
      protocol_version: "1.0",
      message_id: crypto.randomUUID(),
      sequence: 1,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      correlation_id: crypto.randomUUID(),
      type: "connector.hello",
      payload: {
        connector_id: credentials.connector_id,
        connector_version: "raw-fragmented-test/1.0",
        capabilities: ["harness", "integration-test"],
        last_server_sequence: 0,
        last_client_sequence: 0,
      },
    });
    const splitAt = Math.floor(hello.length / 2);
    try {
      sendRawFrame(socket, 0x1, Buffer.from(hello.slice(0, splitAt)), {
        fin: false,
      });
      sendRawFrame(socket, 0x9, Buffer.from("keep-alive"));
      sendRawFrame(socket, 0x0, Buffer.from(hello.slice(splitAt)), {
        fin: true,
      });

      await expect(
        waitForServerMessage(
          socket,
          (message) => message.type === "connector.welcome",
        ),
      ).resolves.toMatchObject({
        type: "connector.welcome",
        payload: { connector_id: credentials.connector_id },
      });
    } finally {
      socket.destroy();
      await app.close();
    }
  });

  it("closes a zero-byte continuation flood with the application limit", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const socket = await rawConnectorSocket(app, credentials);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for fragmented message limit"));
      }, 2_000);
      timer.unref();
    });
    try {
      sendRawFrame(socket, 0x1, Buffer.alloc(0), { fin: false });
      for (let index = 0; index < 2_048; index += 1) {
        sendRawFrame(socket, 0x0, Buffer.alloc(0), { fin: false });
      }

      await expect(Promise.race([closed, timeout])).resolves.toBeUndefined();
      expect(readCloseCode(chunks)).toBe(1009);
    } finally {
      socket.destroy();
      await app.close();
    }
  });

  it.each([126, 127] as const)(
    "closes a non-minimal %s-byte length encoding with protocol status 1002",
    async (lengthCode) => {
      const app = await startApp();
      const credentials = await seedConnector(db);
      const socket = await rawConnectorSocket(app, credentials);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      try {
        sendRawFrame(socket, 0x1, Buffer.from("{}"), {
          lengthCode,
        });

        const closedOrTimedOut = Promise.race([
          closed.then(() => true as const),
          new Promise<false>((resolve) => {
            const timer = setTimeout(() => resolve(false), 2_000);
            timer.unref();
          }),
        ]);
        await expect(closedOrTimedOut).resolves.toBe(true);
        expect(readCloseCode(chunks)).toBe(1002);
        expect(Buffer.concat(chunks).toString("utf8")).not.toContain(
          '"type":"protocol.error"',
        );
      } finally {
        socket.destroy();
        await app.close();
      }
    },
  );

  it.each([126, 127] as const)(
    "FakeConnector rejects a non-minimal %s-byte server length encoding",
    async (lengthCode) => {
      const peer = await startNonMinimalFrameServer(lengthCode);
      const credentials = {
        connector_id: crypto.randomUUID(),
        credential_id: `credential-${crypto.randomUUID()}`,
        credential_secret: `connector-secret-${crypto.randomUUID()}`,
      };
      try {
        await expect(
          FakeConnector.connectWithSessionToken(
            peer,
            credentials,
            "standalone-test-token",
          ),
        ).rejects.toThrow("non-minimal");
      } finally {
        peer.socket?.destroy();
        await new Promise<void>((resolve) =>
          peer.server.close(() => resolve()),
        );
      }
    },
  );

  it("serializes pong output under backpressure", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const socket = await rawConnectorSocket(app, credentials);
    const originalWrite = Socket.prototype.write;
    let writesInFlight = 0;
    let maximumWritesInFlight = 0;
    let heldWrites = 0;
    const writeSpy = vi
      .spyOn(Socket.prototype, "write")
      .mockImplementation(function (this: Socket, ...args) {
        const [chunk, encoding, callback] = args;
        const callbackFn = typeof encoding === "function" ? encoding : callback;
        if (
          this !== socket &&
          Buffer.isBuffer(chunk) &&
          ((chunk[0] ?? 0) & 0x80) !== 0
        ) {
          writesInFlight += 1;
          maximumWritesInFlight = Math.max(
            maximumWritesInFlight,
            writesInFlight,
          );
          heldWrites += 1;
          const timer = setTimeout(() => {
            writesInFlight -= 1;
            callbackFn?.();
          }, 25);
          timer.unref();
          return false;
        }
        return originalWrite.apply(this, args);
      });
    try {
      for (let index = 0; index < 64; index += 1) {
        sendRawFrame(socket, 0x9, Buffer.from([index]));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(heldWrites).toBeGreaterThan(0);
      expect(maximumWritesInFlight).toBe(1);
    } finally {
      writeSpy.mockRestore();
      socket.destroy();
      await app.close();
    }
  });

  it.each([
    {
      name: "RSV1",
      opcode: 0x1,
      payload: Buffer.from("{}"),
      options: { rsv: 0x40 },
      expectedCode: 1002,
    },
    {
      name: "unmasked client frame",
      opcode: 0x1,
      payload: Buffer.from("{}"),
      options: { masked: false },
      expectedCode: 1002,
    },
    {
      name: "reserved opcode",
      opcode: 0x3,
      payload: Buffer.alloc(0),
      options: {},
      expectedCode: 1002,
    },
    {
      name: "fragmented control frame",
      opcode: 0x9,
      payload: Buffer.from("x"),
      options: { fin: false },
      expectedCode: 1002,
    },
    {
      name: "oversized text message",
      opcode: 0x1,
      payload: Buffer.alloc(64 * 1024 + 1, 0x61),
      options: {},
      expectedCode: 1009,
    },
  ])(
    "closes a %s with the RFC6455 status code",
    async ({ opcode, payload, options, expectedCode }) => {
      const app = await startApp();
      const credentials = await seedConnector(db);
      const socket = await rawConnectorSocket(app, credentials);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      try {
        sendRawFrame(socket, opcode, payload, options);
        await expect(closed).resolves.toBeUndefined();
        expect(readCloseCode(chunks)).toBe(expectedCode);
      } finally {
        socket.destroy();
        await app.close();
      }
    },
  );

  it("completes the FakeConnector close handshake during app shutdown", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      await expect(app.close()).resolves.toBeUndefined();
      await expect(connector.waitForClose()).resolves.toBeUndefined();
      expect(connector.closeResponseSent).toBe(true);
      expect(connector.closeResponseMasked).toBe(true);
    } finally {
      await connector.close();
    }
  });

  it("waits for every upgraded connector socket before app.close resolves", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const socket = await rawConnectorSocket(app, credentials);
    let socketClosed = false;
    socket.once("close", () => {
      socketClosed = true;
    });
    socket.once("data", (chunk: Buffer) => {
      if (((chunk[0] ?? 0) & 0x0f) === 0x8) socket.destroy();
    });
    try {
      await app.close();
      expect(socketClosed).toBe(true);
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it("replays a large retained backlog in strict contiguous sequence order", async () => {
    const app = await startApp(5_000);
    const credentials = await seedConnector(db);
    const backlogSize = 192;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    try {
      for (let sequence = 1; sequence <= backlogSize; sequence += 1) {
        await db.query(
          `
            INSERT INTO connector_messages
              (connector_id, direction, sequence, message_id, type, payload, correlation_id, expires_at)
            VALUES ($1, 'server', $2, $3, 'ack', $4::jsonb, $5, $6)
          `,
          [
            credentials.connector_id,
            sequence,
            crypto.randomUUID(),
            JSON.stringify({ sequence }),
            crypto.randomUUID(),
            expiresAt,
          ],
        );
      }
      await db.query(
        "UPDATE connectors SET last_server_sequence = $2 WHERE id = $1",
        [credentials.connector_id, backlogSize],
      );

      const connector = await FakeConnector.connect(app, credentials);
      try {
        expect(
          connector.wireReceived.map((message) => message.sequence),
        ).toEqual(
          Array.from({ length: backlogSize + 1 }, (_, index) => index + 1),
        );
      } finally {
        await connector.close();
      }
    } finally {
      await app.close();
    }
  });
});
