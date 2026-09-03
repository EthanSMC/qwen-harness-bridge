import { createHash } from "node:crypto";
import * as https from "node:https";
import { type AddressInfo, Socket } from "node:net";
import { type Duplex, PassThrough } from "node:stream";
import { connect as connectTls } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { PostgresConnectorStore } from "../../apps/control-plane/src/connector/outbox.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { Aes256GcmEncryptor } from "../../apps/control-plane/src/domain/job-coordinator.js";
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
  requestDecryptor?: Aes256GcmEncryptor;
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
    mask?: Buffer;
    rsv?: number;
    lengthCode?: 126 | 127;
  } = {},
): void => {
  socket.write(encodeRawFrame(opcode, payload, options));
};

const encodeRawFrame = (
  opcode: number,
  payload: Buffer,
  options: {
    fin?: boolean;
    masked?: boolean;
    mask?: Buffer;
    rsv?: number;
    lengthCode?: 126 | 127;
  } = {},
): Buffer => {
  const fin = options.fin ?? true;
  const masked = options.masked ?? true;
  const rsv = options.rsv ?? 0;
  const mask = masked
    ? (options.mask ??
      Buffer.from(crypto.randomUUID().replaceAll("-", "")).subarray(0, 4))
    : undefined;
  if (mask !== undefined && mask.length !== 4) {
    throw new Error("Raw WebSocket test mask must be four bytes");
  }
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
  return frame;
};

const waitForServerMessage = async (
  socket: Duplex,
  predicate: (message: Record<string, unknown>) => boolean,
  options: { upgradeResponse?: boolean } = {},
): Promise<Record<string, unknown>> => {
  let buffer = Buffer.alloc(0);
  let upgradeResponseSeen = !options.upgradeResponse;
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
    };
    const finish = (message: Record<string, unknown>): void => {
      cleanup();
      resolve(message);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgradeResponseSeen) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const responseHead = buffer
          .subarray(0, headerEnd + 4)
          .toString("ascii");
        if (!responseHead.startsWith("HTTP/1.1 101 Switching Protocols\r\n")) {
          fail(new Error(`Connector upgrade returned: ${responseHead}`));
          return;
        }
        upgradeResponseSeen = true;
        buffer = buffer.subarray(headerEnd + 4);
      }
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
            fail(new Error("Server frame is too large for test parser"));
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
          fail(new Error("Server text frame was not JSON"));
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
    timeout = setTimeout(() => {
      fail(new Error("Timed out waiting for server message"));
    }, 2_000);
    socket.on("data", onData);
  });
};

const rawConnectorSocketWithCoalescedHead = async (
  app: Awaited<ReturnType<typeof startApp>>,
  credentials: ConnectorCredentials,
  head: Buffer,
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
  const socket = connectTls({
    host: "127.0.0.1",
    port: (address as AddressInfo).port,
    ca: LOCALHOST_TLS.cert,
    rejectUnauthorized: true,
    servername: "localhost",
  });
  await new Promise<void>((resolve, reject) => {
    const onSecureConnect = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("secureConnect", onSecureConnect);
      reject(error);
    };
    socket.once("secureConnect", onSecureConnect);
    socket.once("error", onError);
  });
  socket.write(
    Buffer.concat([
      Buffer.from(
        "GET /connector/v1 HTTP/1.1\r\n" +
          "Host: localhost\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Authorization: Bearer ${session.token}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n\r\n`,
        "ascii",
      ),
      head,
    ]),
  );
  return socket;
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

const startApp = async (
  dispatchIntervalMs?: number,
  requestDecryptor?: Aes256GcmEncryptor,
) => {
  const app = await createGatewayApp({
    coordinator: noOpCoordinator as never,
    ownerId: OWNER_ID,
    mcpBearerToken: MCP_BEARER,
    https: LOCALHOST_TLS,
    connectorGateway: {
      database: db.client,
      sessionSigningKey: SESSION_SIGNING_KEY,
      ...(dispatchIntervalMs === undefined ? {} : { dispatchIntervalMs }),
      ...(requestDecryptor === undefined ? {} : { requestDecryptor }),
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
  it("rejects a non-101 Upgrade response and removes its data listener", async () => {
    const socket = new PassThrough();
    const result = waitForServerMessage(socket, () => true, {
      upgradeResponse: true,
    });
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");

    await expect(result).rejects.toThrow("Connector upgrade returned");
    expect(socket.listenerCount("data")).toBe(0);
  });

  it("processes a masked hello coalesced into the HTTP Upgrade head", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
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
        connector_version: "coalesced-head-test/1.0",
        capabilities: ["harness", "integration-test"],
        last_server_sequence: 0,
        last_client_sequence: 0,
      },
    });
    const socket = await rawConnectorSocketWithCoalescedHead(
      app,
      credentials,
      encodeRawFrame(0x1, Buffer.from(hello), {
        mask: Buffer.from([0x01, 0x23, 0x45, 0x67]),
      }),
    );
    try {
      await expect(
        waitForServerMessage(
          socket,
          (message) => message.type === "connector.welcome",
          { upgradeResponse: true },
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

  it("accepts an uppercase connector UUID during session exchange", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    try {
      const session = await FakeConnector.exchangeSession(app, {
        ...credentials,
        connector_id: credentials.connector_id.toUpperCase(),
      });

      expect(session.token).toEqual(expect.any(String));
      expect(session.expires_at).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("keeps the replacement generation usable while stopping old pump and receive work", async () => {
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(83));
    const originalAcceptClientMessage =
      PostgresConnectorStore.prototype.acceptClientMessage;
    const originalMaterializeServerMessage =
      PostgresConnectorStore.prototype.materializeServerMessage;
    let releaseFirstHeartbeat: (() => void) | undefined;
    let firstHeartbeatStartedResolve!: () => void;
    let firstHeartbeatFinishedResolve!: () => void;
    const firstHeartbeatStarted = new Promise<void>((resolve) => {
      firstHeartbeatStartedResolve = resolve;
    });
    const firstHeartbeatFinished = new Promise<void>((resolve) => {
      firstHeartbeatFinishedResolve = resolve;
    });
    const firstHeartbeatGate = new Promise<void>((resolve) => {
      releaseFirstHeartbeat = resolve;
    });
    let secondHeartbeatStarted = false;
    let releaseSecondHeartbeat: (() => void) | undefined;
    const secondHeartbeatGate = new Promise<void>((resolve) => {
      releaseSecondHeartbeat = resolve;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "acceptClientMessage",
    ).mockImplementation(async function (identity, message, now) {
      if (message.type === "connector.heartbeat" && message.sequence === 2) {
        firstHeartbeatStartedResolve();
        await firstHeartbeatGate;
      }
      if (message.type === "connector.heartbeat" && message.sequence === 3) {
        secondHeartbeatStarted = true;
        await secondHeartbeatGate;
      }
      const accepted = await originalAcceptClientMessage.call(
        this,
        identity,
        message,
        now,
      );
      if (message.type === "connector.heartbeat" && message.sequence === 2) {
        firstHeartbeatFinishedResolve();
      }
      return accepted;
    });

    let releaseOfferMaterialization: (() => void) | undefined;
    let offerMaterializationStartedResolve!: () => void;
    let offerMaterializationFinishedResolve!: () => void;
    const offerMaterializationStarted = new Promise<void>((resolve) => {
      offerMaterializationStartedResolve = resolve;
    });
    const offerMaterializationFinished = new Promise<void>((resolve) => {
      offerMaterializationFinishedResolve = resolve;
    });
    const offerMaterializationGate = new Promise<void>((resolve) => {
      releaseOfferMaterialization = resolve;
    });
    let blockOfferMaterialization = false;
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "materializeServerMessage",
    ).mockImplementation(async function (stored, decryptor) {
      if (stored.type === "job.offer" && blockOfferMaterialization) {
        blockOfferMaterialization = false;
        offerMaterializationStartedResolve();
        await offerMaterializationGate;
        offerMaterializationFinishedResolve();
      }
      return originalMaterializeServerMessage.call(this, stored, decryptor);
    });

    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    let oldConnector: FakeConnector | undefined;
    let replacementSocket: Duplex | undefined;
    try {
      app = await startApp(10, cipher);
      const credentials = await seedConnector(db);
      oldConnector = await FakeConnector.connect(app, credentials);

      await oldConnector.send("connector.heartbeat", {});
      await firstHeartbeatStarted;
      releaseFirstHeartbeat?.();
      await firstHeartbeatFinished;
      await expect(oldConnector.next("ack")).resolves.toMatchObject({
        payload: { sequence: 2 },
      });

      const repositoryId = crypto.randomUUID();
      await db.query(
        `INSERT INTO repository_policies
           (id, owner_id, display_name, canonical_path, allowed_action_classes)
         VALUES ($1, $2, 'Gateway reconnect repository', '/private/redacted', '[]'::jsonb)`,
        [repositoryId, OWNER_ID],
      );
      await new JobRepository(db.client).createIdempotent({
        ownerId: OWNER_ID,
        clientRequestId: crypto.randomUUID(),
        repositoryId,
        requestCiphertext: cipher.encrypt(
          "gateway reconnect request must be delivered once",
        ),
        requestDigest: `sha256:${"8".repeat(64)}`,
      });
      blockOfferMaterialization = true;
      await offerMaterializationStarted;

      await oldConnector.send("connector.heartbeat", {});
      replacementSocket = await rawConnectorSocket(app, credentials);

      releaseOfferMaterialization?.();
      await offerMaterializationFinished;

      sendRawFrame(
        replacementSocket,
        0x1,
        Buffer.from(
          JSON.stringify({
            protocol_version: "1.0",
            message_id: crypto.randomUUID(),
            sequence: 3,
            sent_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            correlation_id: crypto.randomUUID(),
            type: "connector.hello",
            payload: {
              connector_id: credentials.connector_id,
              connector_version: "replacement-generation-test/1.0",
              capabilities: ["harness", "integration-test"],
              last_server_sequence: 2,
              last_client_sequence: 2,
            },
          }),
        ),
      );
      await expect(
        waitForServerMessage(
          replacementSocket,
          (message) => message.type === "connector.welcome",
        ),
      ).resolves.toMatchObject({
        type: "connector.welcome",
        payload: { connector_id: credentials.connector_id },
      });

      sendRawFrame(
        replacementSocket,
        0x1,
        Buffer.from(
          JSON.stringify({
            protocol_version: "1.0",
            message_id: crypto.randomUUID(),
            sequence: 4,
            sent_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            correlation_id: crypto.randomUUID(),
            type: "connector.heartbeat",
            payload: {},
          }),
        ),
      );
      await expect(
        waitForServerMessage(
          replacementSocket,
          (message) =>
            message.type === "ack" &&
            (message.payload as { sequence?: unknown }).sequence === 4,
        ),
      ).resolves.toMatchObject({
        type: "ack",
        payload: { sequence: 4 },
      });

      expect(secondHeartbeatStarted).toBe(false);
      expect(
        oldConnector.wireReceived.filter(
          (message) => message.type === "job.offer",
        ),
      ).toHaveLength(0);
      const state = await db.query<{ last_client_sequence: number }>(
        "SELECT last_client_sequence FROM connectors WHERE id = $1",
        [credentials.connector_id],
      );
      expect(Number(state.rows[0]?.last_client_sequence)).toBe(4);
    } finally {
      releaseFirstHeartbeat?.();
      releaseOfferMaterialization?.();
      releaseSecondHeartbeat?.();
      replacementSocket?.destroy();
      if (oldConnector !== undefined) await oldConnector.disconnectWithoutAck();
      if (app !== undefined) await app.close();
      vi.restoreAllMocks();
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

  it("queues duplicate ACK retransmission behind active pump store work", async () => {
    const originalAcceptClientMessage =
      PostgresConnectorStore.prototype.acceptClientMessage;
    const originalDispatchNext = PostgresConnectorStore.prototype.dispatchNext;
    const originalPendingServerMessages =
      PostgresConnectorStore.prototype.pendingServerMessages;
    const originalMaterializeServerMessage =
      PostgresConnectorStore.prototype.materializeServerMessage;
    let activeStoreCalls = 0;
    let maximumActiveStoreCalls = 0;
    const trackStoreCall = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      activeStoreCalls += 1;
      maximumActiveStoreCalls = Math.max(
        maximumActiveStoreCalls,
        activeStoreCalls,
      );
      try {
        return await operation();
      } finally {
        activeStoreCalls -= 1;
      }
    };
    let blockNextPump = false;
    let pumpBlocked = false;
    let releasePump: (() => void) | undefined;
    let pumpStartedResolve!: () => void;
    const pumpStarted = new Promise<void>((resolve) => {
      pumpStartedResolve = resolve;
    });
    const pumpGate = new Promise<void>((resolve) => {
      releasePump = resolve;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "acceptClientMessage",
    ).mockImplementation(async function (identity, message, now) {
      return trackStoreCall(() =>
        originalAcceptClientMessage.call(this, identity, message, now),
      );
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "dispatchNext",
    ).mockImplementation(async function (identity, now) {
      return trackStoreCall(async () => {
        if (blockNextPump && !pumpBlocked) {
          pumpBlocked = true;
          pumpStartedResolve();
          await pumpGate;
        }
        return originalDispatchNext.call(this, identity, now);
      });
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "pendingServerMessages",
    ).mockImplementation(async function (identity, afterSequence, now) {
      return trackStoreCall(() =>
        originalPendingServerMessages.call(this, identity, afterSequence, now),
      );
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "materializeServerMessage",
    ).mockImplementation(async function (stored, decryptor) {
      return trackStoreCall(() =>
        originalMaterializeServerMessage.call(this, stored, decryptor),
      );
    });

    const app = await startApp(10);
    const credentials = await seedConnector(db);
    const connector = await FakeConnector.connect(app, credentials);
    try {
      const heartbeat = await connector.send("connector.heartbeat", {});
      const originalAck = await connector.next("ack");
      blockNextPump = true;
      await pumpStarted;

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
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(
        connector.wireReceived.filter(
          (message) => message.message_id === originalAck.message_id,
        ),
      ).toHaveLength(1);

      releasePump?.();
      await vi.waitFor(
        () => {
          expect(
            connector.wireReceived.filter(
              (message) => message.message_id === originalAck.message_id,
            ),
          ).toEqual([originalAck, originalAck]);
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(maximumActiveStoreCalls).toBe(1);
    } finally {
      releasePump?.();
      await connector.close();
      await app.close();
      vi.restoreAllMocks();
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
    const plaintextRequest =
      "gateway expiry integration request must never be emitted";
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(57));
    const repositoryId = `gateway-expiry-${crypto.randomUUID()}`;
    await db.query(
      `INSERT INTO repository_policies
         (id, owner_id, display_name, canonical_path, allowed_action_classes)
       VALUES ($1, $2, 'Gateway expiry repository', '/private/redacted', '[]'::jsonb)`,
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: cipher.encrypt(plaintextRequest),
      requestDigest: `sha256:${"7".repeat(64)}`,
    });
    const leaseId = crypto.randomUUID();
    const jobExpiresAt = new Date(Date.now() + 60_000);
    await db.query(
      `UPDATE jobs
          SET connector_id = $1,
              status = 'running'::job_status,
              attempt = 1,
              lease_id = $2,
              lease_expires_at = $3,
              expires_at = $4,
              current_stage = 'running'
        WHERE id = $5`,
      [
        credentials.connector_id,
        leaseId,
        jobExpiresAt,
        jobExpiresAt,
        job.jobId,
      ],
    );
    const app = await startApp(50, cipher);
    let connector: FakeConnector | undefined;
    try {
      connector = await FakeConnector.connect(app, credentials);
      const store = new PostgresConnectorStore(db.client);
      const originalMaterializeServerMessage =
        PostgresConnectorStore.prototype.materializeServerMessage;
      let expiryMutationCount = 0;
      vi.spyOn(
        PostgresConnectorStore.prototype,
        "materializeServerMessage",
      ).mockImplementation(async function (stored, decryptor) {
        if (stored.type === "job.offer" && expiryMutationCount === 0) {
          const expired = await db.query(
            `UPDATE connector_messages
                SET expires_at = now() - interval '1 second'
              WHERE connector_id = $1
                AND direction = 'server'
                AND sequence = $2
                AND message_id = $3
              RETURNING message_id`,
            [stored.connectorId, stored.sequence, stored.messageId],
          );
          expiryMutationCount += expired.rows.length;
        }
        return originalMaterializeServerMessage.call(this, stored, decryptor);
      });

      const offer = await store.enqueueServer(
        {
          ownerId: OWNER_ID,
          connectorId: credentials.connector_id,
          protocolVersion: "1.0",
        },
        "job.offer",
        {
          job_id: job.jobId,
          attempt: 1,
          lease_id: leaseId,
          repository_id: repositoryId,
        },
        jobExpiresAt,
      );

      const tombstone = await connector.next("protocol.error");
      expect(tombstone).toMatchObject({
        sequence: offer.sequence,
        type: "protocol.error",
        payload: {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
      });
      expect(tombstone.message_id).not.toBe(offer.messageId);
      expect(expiryMutationCount).toBe(1);
      expect(
        connector.wireReceived.some((message) => message.type === "job.offer"),
      ).toBe(false);
      expect(JSON.stringify(connector.wireReceived)).not.toContain(
        plaintextRequest,
      );

      const persisted = await db.query<{
        sequence: number;
        message_id: string;
        type: string;
        payload: { code: string; message: string };
        acknowledged_at: Date | null;
      }>(
        `SELECT sequence::integer AS sequence, message_id, type, payload, acknowledged_at
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server' AND sequence = $2`,
        [credentials.connector_id, offer.sequence],
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({
        sequence: offer.sequence,
        message_id: tombstone.message_id,
        type: "protocol.error",
        payload: {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
        acknowledged_at: null,
      });

      await connector.ack(tombstone);
      const heartbeat = await connector.send("connector.heartbeat", {});
      await expect(connector.next("ack")).resolves.toMatchObject({
        payload: { sequence: heartbeat.sequence },
      });
      const acknowledged = await db.query<{ acknowledged_at: Date | null }>(
        `SELECT acknowledged_at
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server' AND sequence = $2`,
        [credentials.connector_id, offer.sequence],
      );
      expect(acknowledged.rows[0]?.acknowledged_at).not.toBeNull();
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
    const pongPayloads: Buffer[] = [];
    const pingPayloads = Array.from({ length: 63 }, (_, index) =>
      Buffer.from(`ping-${index}`),
    );
    const latestPingPayload = Buffer.from("latest-ping-application-payload");
    pingPayloads.push(latestPingPayload);
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
          if (((chunk[0] ?? 0) & 0x0f) === 0xa) {
            const lengthCode = (chunk[1] ?? 0) & 0x7f;
            const payloadOffset =
              lengthCode === 126 ? 4 : lengthCode === 127 ? 10 : 2;
            const payloadLength =
              lengthCode === 126
                ? chunk.readUInt16BE(2)
                : lengthCode === 127
                  ? Number(chunk.readBigUInt64BE(2))
                  : lengthCode;
            pongPayloads.push(
              Buffer.from(
                chunk.subarray(payloadOffset, payloadOffset + payloadLength),
              ),
            );
          }
          writesInFlight += 1;
          maximumWritesInFlight = Math.max(
            maximumWritesInFlight,
            writesInFlight,
          );
          heldWrites += 1;
          const timer = setTimeout(() => {
            writesInFlight -= 1;
            callbackFn?.();
            this.emit("drain");
          }, 25);
          timer.unref();
          return false;
        }
        return originalWrite.apply(this, args);
      });
    try {
      for (const payload of pingPayloads) {
        sendRawFrame(socket, 0x9, payload);
      }
      await vi.waitFor(
        () => {
          expect(pongPayloads.at(-1)).toEqual(latestPingPayload);
        },
        { timeout: 2_000, interval: 10 },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 75));

      expect(heldWrites).toBeGreaterThan(0);
      expect(maximumWritesInFlight).toBe(1);
      expect(pongPayloads.at(-1)).toEqual(latestPingPayload);
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
