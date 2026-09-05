import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import * as https from "node:https";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, PassThrough } from "node:stream";
import { connect as connectTls } from "node:tls";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { createConnectorGateway } from "../../apps/control-plane/src/connector/gateway.js";
import { PostgresConnectorStore } from "../../apps/control-plane/src/connector/outbox.js";
import { createConnectorSessionService } from "../../apps/control-plane/src/connector/session.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { Aes256GcmEncryptor } from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import WebSocket from "../../packages/harness-plugin/node_modules/ws/index.js";
import { JobStateClient } from "../../packages/harness-plugin/src/runtime/job-state-client.js";
import { SqlitePluginStore } from "../../packages/harness-plugin/src/store/plugin-store.js";
import {
  buildConnectorHello,
  type ConnectorClientOptions,
  createConnectorClient,
} from "../../packages/harness-plugin/src/transport/connector-client.js";
import {
  type ConnectorCredentials,
  FakeConnector,
  LOCALHOST_TLS,
} from "./support/fake-connector.js";
import { createTestDatabase, type TestDatabase } from "./support/postgres.js";

const db = createTestDatabase();
const FIXTURE_NAMESPACE = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const OWNER_ID = `integration-gateway-owner-${FIXTURE_NAMESPACE}`;
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
  terminateStoreOperations?: () => Promise<void>,
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
      ...(terminateStoreOperations === undefined
        ? {}
        : { terminateStoreOperations }),
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

const startStalledWebSocketServer = async (): Promise<{
  server: https.Server;
  socket: Duplex | undefined;
  socketClosed: Promise<void>;
}> => {
  let upgradedSocket: Duplex | undefined;
  let resolveSocketClosed!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = https.createServer(LOCALHOST_TLS);
  server.on("upgrade", (request, socket) => {
    upgradedSocket = socket;
    socket.on("error", () => undefined);
    socket.once("close", resolveSocketClosed);
    socket.once("end", () => socket.destroy());
    socket.resume();
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
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  return {
    server,
    socketClosed,
    get socket() {
      return upgradedSocket;
    },
  };
};

beforeAll(async () => {
  await db.start();
});

const harnessClient = (
  app: Awaited<ReturnType<typeof startApp>>,
  credentials: ConnectorCredentials,
  store: SqlitePluginStore,
  options: Partial<Omit<ConnectorClientOptions, "store">> = {},
) => {
  const address = app.server.address() as AddressInfo;
  return createConnectorClient({
    connectorId: credentials.connector_id,
    controlPlaneUrl: `wss://127.0.0.1:${address.port}/connector/v1`,
    store,
    bootstrapCredentialProvider: async () => credentials.credential_secret,
    sessionTokenClient: {
      exchange: async () => {
        const session = await FakeConnector.exchangeSession(app, credentials);
        return {
          token: session.token,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        };
      },
    },
    webSocketFactory: (url, config) =>
      new WebSocket(url, { ...config, ca: LOCALHOST_TLS.cert }),
    reconnectDelay: () => 10_000,
    ...options,
  });
};

const rejectClaimOverTls = async (
  app: Awaited<ReturnType<typeof startApp>>,
  credentials: ConnectorCredentials,
  hello: ConnectorClientMessage,
  claim: ConnectorClientMessage,
): Promise<void> => {
  const session = await FakeConnector.exchangeSession(app, credentials);
  const address = app.server.address() as AddressInfo;
  const socket = new WebSocket(`wss://127.0.0.1:${address.port}/connector/v1`, {
    headers: { authorization: `Bearer ${session.token}` },
    ca: LOCALHOST_TLS.cert,
  });
  const received: ReturnType<typeof ConnectorServerMessageSchema.parse>[] = [];
  let welcomed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("fixture rejection timed out")),
        2_000,
      );
      socket.once("open", () => socket.send(JSON.stringify(hello)));
      socket.on("message", (data) => {
        try {
          const message = ConnectorServerMessageSchema.parse(
            JSON.parse(String(data)),
          );
          received.push(message);
          if (
            !welcomed &&
            message.type === "connector.welcome" &&
            message.correlation_id === hello.correlation_id
          ) {
            expect(message.payload.capabilities).toContain(
              "durable-receipts-v1",
            );
            welcomed = true;
            socket.send(JSON.stringify(claim));
          }
        } catch (error) {
          reject(error);
        }
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    expect(welcomed).toBe(true);
    expect(received.at(-1)).toMatchObject({
      type: "protocol.error",
      payload: { code: "CLAIM_REJECTED" },
    });
    expect(
      received.some(
        (message) =>
          message.type === "ack" &&
          message.correlation_id === claim.correlation_id,
      ),
    ).toBe(false);
  } finally {
    clearTimeout(timeout);
    socket.terminate();
  }
};

afterAll(async () => {
  await db.stop();
});

describe("Connector gateway authentication and handshake", () => {
  it("does not turn a retained welcome echo into working sync after server rollback", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const local = new SqlitePluginStore(
      join(mkdtempSync(join(tmpdir(), "qhb-rollback-")), "state.sqlite"),
    );
    const repositoryId = `rollback-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'Rollback fixture', '/redacted', false)",
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      repositoryId,
      clientRequestId: crypto.randomUUID(),
      requestCiphertext: "fixture",
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1 WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    const original = PostgresConnectorStore.prototype.acceptClientMessage;
    // Model an old executable returning retained welcome evidence while its
    // actual current admission supports only durable receipts.
    const hook = vi
      .spyOn(PostgresConnectorStore.prototype, "acceptClientMessage")
      .mockImplementation(async function (identity, message, now) {
        const result = await original.call(this, identity, message, now);
        if (
          identity.connectorId === credentials.connector_id &&
          message.type === "connector.hello"
        ) {
          await db.query(
            "UPDATE connectors SET capabilities = '[\"durable-receipts-v1\"]'::jsonb WHERE id = $1",
            [credentials.connector_id],
          );
        }
        return result;
      });
    const controller = new AbortController();
    const client = harnessClient(app, credentials, local, {
      requireJobCoordination: true,
    });
    let calls = 0;
    client.onState(() => {
      calls++;
    });
    const running = client.start(controller.signal);
    try {
      await vi.waitFor(() => expect(client.currentEpoch()).toBeDefined());
      const epoch = client.currentEpoch();
      let sequence = 0;
      client.publishSync(
        { job_id: job.jobId, attempt: 1, nonce: crypto.randomUUID() },
        crypto.randomUUID(),
        (request) => {
          sequence = request.sequence;
        },
      );
      await vi.waitFor(() => expect(epoch?.signal.aborted).toBe(true));
      expect(calls).toBe(0);
      expect(local.outboundEvent(sequence)?.acknowledgedAt).toBeNull();
      expect(client.currentEpoch()).toBeUndefined();
      expect(
        (
          await db.query(
            "SELECT id FROM connector_messages WHERE connector_id = $1 AND type = 'job.state'",
            [credentials.connector_id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      controller.abort();
      await running;
      hook.mockRestore();
      local.close();
      await app.close();
      await db.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it("bounds live state exchanges before real SQLite allocation over TLS", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const store = new SqlitePluginStore(
      join(mkdtempSync(join(tmpdir(), "qhb-state-capacity-")), "state.sqlite"),
    );
    const controller = new AbortController();
    const connector = harnessClient(app, credentials, store, {
      requireJobCoordination: true,
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, {
          ...options,
          ca: LOCALHOST_TLS.cert,
        });
        const send = socket.send.bind(socket);
        socket.send = ((
          data: Parameters<typeof socket.send>[0],
          ...args: unknown[]
        ) => {
          if (JSON.parse(String(data)).type === "job.sync") return;
          return Reflect.apply(send, socket, [data, ...args]);
        }) as typeof socket.send;
        return socket;
      },
    });
    const states = new JobStateClient({ connector });
    const running = connector.start(controller.signal);
    try {
      await vi.waitFor(() => expect(connector.currentEpoch()).toBeDefined());
      const firstJob = crypto.randomUUID();
      const inputs = Array.from({ length: 32 }, (_, index) => ({
        jobId: index === 0 ? firstJob : crypto.randomUUID(),
        repositoryId: "example",
        attempt: 1,
      }));
      const before = store.maxOutboundSequence();
      const pending = inputs.map((input) =>
        states.observe(input).catch((error: unknown) => error),
      );
      const persisted = Array.from({ length: 32 }, (_, index) =>
        store.outboundEvent(before + index + 1),
      );
      expect(
        persisted.every(
          (row) => row?.expectedReceiptProfile === "job-coordination-v1",
        ),
      ).toBe(true);
      expect(
        persisted.map((row) => JSON.parse(row?.payload ?? "null").type),
      ).toEqual(Array(32).fill("job.sync"));
      const sameJob = expect(
        states.observe({
          ...inputs[0],
          jobId: firstJob.toUpperCase(),
          attempt: 2,
        }),
      ).rejects.toMatchObject({ code: "JOB_STATE_CAPACITY" });
      const overflow = expect(
        states.observe({ ...inputs[0], jobId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "JOB_STATE_CAPACITY" });
      expect(store.maxOutboundSequence()).toBe(before + 32);
      expect(
        Array.from({ length: 32 }, (_, index) =>
          store.outboundEvent(before + index + 1),
        ),
      ).toEqual(persisted);
      await sameJob;
      await overflow;
      states.dispose();
      expect(await Promise.all(pending)).toEqual(
        Array.from({ length: 32 }, () =>
          expect.objectContaining({ code: "JOB_STATE_DISPOSED" }),
        ),
      );
      expect(store.maxOutboundSequence()).toBe(before + 32);
    } finally {
      states.dispose();
      controller.abort();
      await running;
      store.close();
      await app.close();
    }
  });

  it("returns fresh and terminal mismatch observations over PostgreSQL TLS without business writes", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const store = new SqlitePluginStore(
      join(mkdtempSync(join(tmpdir(), "qhb-state-facts-")), "state.sqlite"),
    );
    const repositoryId = `state-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'State fixture', '/redacted', false)",
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      repositoryId,
      clientRequestId: crypto.randomUUID(),
      requestCiphertext: "fixture",
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1, revision = 7, mode = 'read_only' WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    const controller = new AbortController();
    const connector = harnessClient(app, credentials, store, {
      requireJobCoordination: true,
    });
    const states = new JobStateClient({ connector });
    const running = connector.start(controller.signal);
    try {
      await vi.waitFor(() => expect(connector.currentEpoch()).toBeDefined());
      const input = { jobId: job.jobId, repositoryId, attempt: 1 };
      const fresh = await states.observe(input);
      expect(fresh.state.payload).toMatchObject({
        mode: "read_only",
        status: "running",
        current_attempt: 1,
        job_revision: 7,
      });
      expect(fresh.epoch).toBe(connector.currentEpoch());
      expect(
        store.outboundEvent(fresh.request.sequence)?.expectedReceiptProfile,
      ).toBe("job-coordination-v1");
      await db.query(
        "UPDATE jobs SET status = 'succeeded', attempt = 2, revision = 8, expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [job.jobId],
      );
      const terminal = await states.observe(input);
      expect(terminal.state.payload).toMatchObject({
        status: "succeeded",
        requested_attempt: 1,
        current_attempt: 2,
        job_revision: 8,
      });
      expect(terminal.request.nonce).not.toBe(fresh.request.nonce);
      const rows = Array.from(
        { length: store.maxOutboundSequence() },
        (_, index) => store.outboundEvent(index + 1),
      ).filter((row) => row !== undefined);
      expect(
        rows
          .map((row) => JSON.parse(row.payload).type)
          .filter(
            (type) =>
              ![
                "connector.hello",
                "ack",
                "connector.heartbeat",
                "job.sync",
              ].includes(type),
          ),
      ).toEqual([]);
      expect(
        (
          await db.query(
            "SELECT status, attempt, revision FROM jobs WHERE id = $1",
            [job.jobId],
          )
        ).rows,
      ).toEqual([{ status: "succeeded", attempt: 2, revision: 8 }]);
    } finally {
      states.dispose();
      controller.abort();
      await running;
      store.close();
      await app.close();
      await db.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it("withdraws a live exchange after outbound commit and ignores its replay on SQLite restart", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const path = join(
      mkdtempSync(join(tmpdir(), "qhb-state-restart-")),
      "state.sqlite",
    );
    let store = new SqlitePluginStore(path);
    const repositoryId = `state-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'State fixture', '/redacted', false)",
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      repositoryId,
      clientRequestId: crypto.randomUUID(),
      requestCiphertext: "fixture",
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1, revision = 7 WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    const controller = new AbortController();
    const connector = harnessClient(app, credentials, store, {
      requireJobCoordination: true,
    });
    const states = new JobStateClient({ connector });
    const running = connector.start(controller.signal);
    let resumedStates: JobStateClient | undefined;
    let resumedRun: Promise<void> | undefined;
    const resumedController = new AbortController();
    const enqueue = store.enqueueEvent.bind(store);
    const hook = vi
      .spyOn(store, "enqueueEvent")
      .mockImplementation((event, pin) => {
        enqueue(event, pin);
        if (JSON.parse(event.payload).type === "job.sync") controller.abort();
      });
    try {
      await vi.waitFor(() => expect(connector.currentEpoch()).toBeDefined());
      const input = { jobId: job.jobId, repositoryId, attempt: 1 };
      const oldEpoch = connector.currentEpoch();
      await expect(states.observe(input)).rejects.toMatchObject({
        code: "JOB_STATE_UNAVAILABLE",
      });
      await running;
      hook.mockRestore();
      const old = store.outboundEvent(store.maxOutboundSequence());
      expect(old?.acknowledgedAt).toBeNull();
      const oldMessage = ConnectorClientMessageSchema.parse(
        JSON.parse(old?.payload ?? "null"),
      );
      expect(oldMessage.type).toBe("job.sync");
      expect(oldEpoch?.signal.aborted).toBe(true);
      states.dispose();
      store.close();
      store = new SqlitePluginStore(path);
      const resumed = harnessClient(app, credentials, store, {
        requireJobCoordination: true,
      });
      resumedStates = new JobStateClient({ connector: resumed });
      const deliveries: string[] = [];
      resumed.onState((message) => {
        deliveries.push(message.payload.request_message_id);
      });
      resumedRun = resumed.start(resumedController.signal);
      await vi.waitFor(() => expect(resumed.currentEpoch()).toBeDefined());
      const fresh = await resumedStates.observe(input);
      expect(fresh.request.messageId).not.toBe(oldMessage.message_id);
      expect(fresh.request.correlationId).not.toBe(oldMessage.correlation_id);
      expect(fresh.epoch).not.toBe(oldEpoch);
      expect(deliveries).toContain(oldMessage.message_id);
      expect(fresh.state.payload.request_message_id).toBe(
        fresh.request.messageId,
      );
      expect(store.outboundEvent(oldMessage.sequence)?.messageId).toBe(
        oldMessage.message_id,
      );
    } finally {
      hook.mockRestore();
      states.dispose();
      controller.abort();
      await running;
      resumedStates?.dispose();
      resumedController.abort();
      await resumedRun;
      store.close();
      await app.close();
      await db.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it.each(["before receipt", "after receipt"] as const)(
    "recovers negotiated sync lost %s over PostgreSQL TLS and reopened SQLite without fresh permission",
    async (loss) => {
      const credentials = await seedConnector(db);
      const app = await startApp(5_000);
      const directory = mkdtempSync(
        join(tmpdir(), "qhb-coordination-restart-"),
      );
      const path = join(directory, "state.sqlite");
      let store = new SqlitePluginStore(path);
      const repositoryId = `sync-${crypto.randomUUID()}`;
      await db.query(
        "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'Coordination fixture', '/redacted', false)",
        [repositoryId, OWNER_ID],
      );
      const job = await new JobRepository(db.client).createIdempotent({
        ownerId: OWNER_ID,
        repositoryId,
        clientRequestId: crypto.randomUUID(),
        requestCiphertext: "fixture",
        requestDigest: "fixture",
      });
      await db.query(
        "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1, revision = 7, mode = 'read_only' WHERE id = $2",
        [credentials.connector_id, job.jobId],
      );
      const controller = new AbortController();
      let originalState:
        | Extract<
            ReturnType<typeof ConnectorServerMessageSchema.parse>,
            { type: "job.state" }
          >
        | undefined;
      let request:
        | import("../../packages/harness-plugin/src/transport/connector-client.js").PublishedSync
        | undefined;
      let registered = false;
      let callbacks = 0;
      const receivedTypes: string[] = [];
      const first = harnessClient(app, credentials, store, {
        requireJobCoordination: true,
        webSocketFactory: (url, options) => {
          const socket = new WebSocket(url, {
            ...options,
            ca: LOCALHOST_TLS.cert,
          });
          const emit = socket.emit.bind(socket);
          socket.emit = ((event: string | symbol, ...args: unknown[]) => {
            if (event === "message") {
              const message = ConnectorServerMessageSchema.parse(
                JSON.parse(String(args[0])),
              );
              receivedTypes.push(
                message.type === "protocol.error"
                  ? message.payload.code
                  : message.type,
              );
              if (message.type === "job.state") {
                expect(registered).toBe(true);
                originalState = message;
                if (loss === "before receipt") {
                  controller.abort();
                  return true;
                }
              }
            }
            return emit(event, ...args);
          }) as typeof socket.emit;
          return socket;
        },
      });
      first.onState(() => {
        callbacks++;
      });
      const record = store.recordInbound.bind(store);
      const hook = vi
        .spyOn(store, "recordInbound")
        .mockImplementation((...args) => {
          const result = record(...args);
          if (loss === "after receipt" && args[0] === originalState?.message_id)
            controller.abort();
          return result;
        });
      const running = first.start(controller.signal);
      let resumedController: AbortController | undefined;
      let resumedRun: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(first.currentEpoch()).toBeDefined());
        first.publishSync(
          { job_id: job.jobId, attempt: 1, nonce: crypto.randomUUID() },
          crypto.randomUUID(),
          (persisted) => {
            request = persisted;
            expect(
              store.outboundEvent(persisted.sequence)?.expectedReceiptProfile,
            ).toBe("job-coordination-v1");
            registered = true;
          },
        );
        await vi.waitFor(() =>
          expect(receivedTypes.join(",")).toContain("job.state"),
        );
        await running;
        hook.mockRestore();
        if (request === undefined || originalState === undefined)
          throw new Error("fixture response missing");
        expect(request.epoch.signal.aborted).toBe(true);
        expect(callbacks).toBe(0);
        expect(
          store.outboundEvent(request.sequence)?.acknowledgedAt,
        ).toBeNull();
        expect(originalState.payload).toMatchObject({
          mode: "read_only",
          job_revision: 7,
        });
        // Change authoritative state after consumption. Replaying the request
        // must restore the first observation, including its original validity.
        await db.query(
          "UPDATE jobs SET revision = 8, mode = 'normal' WHERE id = $1",
          [job.jobId],
        );
        if (loss === "before receipt") {
          await db.query(
            "UPDATE connector_messages SET expires_at = clock_timestamp() - interval '1 second' WHERE connector_id = $1 AND direction = 'server' AND sequence >= $2",
            [credentials.connector_id, originalState.sequence],
          );
        }
        store.close();
        store = new SqlitePluginStore(path);
        const deliveries: Array<{ epoch: unknown; recovered: boolean }> = [];
        const wire: string[] = [];
        resumedController = new AbortController();
        const resumed = harnessClient(app, credentials, store, {
          requireJobCoordination: true,
          webSocketFactory: (url, options) => {
            const socket = new WebSocket(url, {
              ...options,
              ca: LOCALHOST_TLS.cert,
            });
            socket.on("message", (data) => {
              const message = ConnectorServerMessageSchema.parse(
                JSON.parse(String(data)),
              );
              if (message.sequence === originalState?.sequence)
                wire.push(message.type);
            });
            return socket;
          },
        });
        resumed.onState((message, delivery) => {
          if (!delivery.recovered)
            expect(
              store.outboundEvent(message.payload.request_sequence)
                ?.acknowledgedAt,
            ).toBeNull();
          deliveries.push(delivery);
        });
        resumedRun = resumed.start(resumedController.signal);
        await vi.waitFor(
          () =>
            expect(
              store.outboundEvent(request?.sequence ?? 0)?.acknowledgedAt,
            ).not.toBeNull(),
          { timeout: 5_000 },
        );
        expect(
          store.coordinationReceipt(originalState.sequence)
            ?.responsePayloadJson,
        ).toBe(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(originalState.payload).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          ),
        );
        if (loss === "after receipt")
          expect(deliveries).toEqual([{ epoch: null, recovered: true }]);
        else {
          expect(wire).toContain("protocol.error");
          expect(wire).toContain("job.state");
          expect(deliveries).toEqual([]);
        }
        const freshEpoch = resumed.currentEpoch();
        expect(freshEpoch).toBeDefined();
        expect(freshEpoch).not.toBe(request.epoch);
        const prior = deliveries.length;
        let freshMessage: typeof originalState;
        resumed.onState((message) => {
          freshMessage = message;
        });
        resumed.publishSync(
          { job_id: job.jobId, attempt: 1, nonce: crypto.randomUUID() },
          crypto.randomUUID(),
          (fresh) => {
            expect(fresh.messageId).not.toBe(request?.messageId);
            expect(fresh.epoch).toBe(freshEpoch);
          },
        );
        await vi.waitFor(() => expect(deliveries).toHaveLength(prior + 1));
        expect(deliveries.at(-1)).toEqual({
          epoch: freshEpoch,
          recovered: false,
        });
        expect(freshMessage?.payload).toMatchObject({
          mode: "normal",
          job_revision: 8,
        });
      } finally {
        controller.abort();
        await running;
        hook.mockRestore();
        resumedController?.abort();
        await resumedRun;
        store.close();
        await app.close();
        await db.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
      }
    },
    15_000,
  );

  it("orders negotiated stale-business then immutable state and ordinary ACK over actual TLS and reconnect", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const repositoryId = `coordination-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, allowed_action_classes) VALUES ($1, $2, 'Coordination', '/private/redacted', '[]')",
      [repositoryId, OWNER_ID],
    );
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(67));
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      repositoryId,
      clientRequestId: crypto.randomUUID(),
      requestCiphertext: cipher.encrypt("Coordination fixture"),
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1, revision = 7, mode = 'read_only' WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    const sockets: WebSocket[] = [];
    const openPeer = async () => {
      const session = await FakeConnector.exchangeSession(app, credentials);
      const address = app.server.address() as AddressInfo;
      const socket = new WebSocket(
        `wss://127.0.0.1:${address.port}/connector/v1`,
        {
          headers: { authorization: `Bearer ${session.token}` },
          ca: LOCALHOST_TLS.cert,
        },
      );
      sockets.push(socket);
      const received: ReturnType<typeof ConnectorServerMessageSchema.parse>[] =
        [];
      socket.on("message", (data) =>
        received.push(
          ConnectorServerMessageSchema.parse(JSON.parse(String(data))),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return {
        socket,
        received,
        async count(n: number) {
          await vi.waitFor(
            () => expect(received.length).toBeGreaterThanOrEqual(n),
            { timeout: 2000, interval: 10 },
          );
        },
      };
    };
    try {
      const peer = await openPeer();
      const hello = buildConnectorHello({
        connectorId: credentials.connector_id,
        sequence: 1,
        lastServerSequence: 0,
        correlationId: crypto.randomUUID(),
        now: new Date(),
        capabilities: ["durable-receipts-v1", "job-coordination-v1"],
      });
      peer.socket.send(JSON.stringify(hello));
      await peer.count(1);
      expect(peer.received[0]).toMatchObject({
        type: "connector.welcome",
        payload: {
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        },
      });
      const stale = ConnectorClientMessageSchema.parse({
        ...hello,
        message_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        sequence: 2,
        type: "approval.requested",
        payload: {
          job_id: job.jobId,
          attempt: 1,
          job_revision: 1,
          approval_id: crypto.randomUUID(),
          action_summary: "Run checks",
          impact_summary: "Checks only",
          risk_class: "low",
          action_fingerprint: `sha256:${"a".repeat(64)}`,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      });
      peer.socket.send(JSON.stringify(stale));
      await peer.count(3);
      expect(peer.received[1]).toMatchObject({
        type: "protocol.error",
        payload: {
          code: "EVENT_REJECTED",
          message: "The job authority has changed.",
        },
      });
      expect(peer.received[2]).toMatchObject({
        type: "ack",
        payload: { sequence: 2 },
      });
      const sync = ConnectorClientMessageSchema.parse({
        ...hello,
        message_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        sequence: 3,
        type: "job.sync",
        payload: { job_id: job.jobId, attempt: 1, nonce: crypto.randomUUID() },
      });
      peer.socket.send(JSON.stringify(sync));
      await peer.count(5);
      expect(peer.received.map((message) => message.sequence)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(peer.received[3]).toMatchObject({
        type: "job.state",
        payload: {
          mode: "read_only",
          job_revision: 7,
          request_message_id: sync.message_id,
        },
      });
      expect(peer.received[4]).toMatchObject({
        type: "ack",
        payload: { sequence: 3 },
      });
      peer.socket.terminate();
      await db.query(
        "UPDATE jobs SET revision = 8, mode = 'normal', connector_id = NULL WHERE id = $1",
        [job.jobId],
      );
      const reconnect = await openPeer();
      reconnect.socket.send(
        JSON.stringify(
          buildConnectorHello({
            connectorId: credentials.connector_id,
            sequence: 4,
            lastClientSequence: 3,
            lastServerSequence: 5,
            correlationId: crypto.randomUUID(),
            now: new Date(),
            capabilities: ["durable-receipts-v1"],
          }),
        ),
      );
      await reconnect.count(1);
      expect(reconnect.received[0]).toMatchObject({
        sequence: 6,
        type: "connector.welcome",
        payload: { capabilities: ["durable-receipts-v1"] },
      });
      reconnect.socket.send(JSON.stringify(sync));
      await reconnect.count(3);
      expect(reconnect.received.slice(1)).toEqual(peer.received.slice(3));
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
      await db.query("DELETE FROM jobs WHERE id = $1", [job.jobId]);
    }
  });

  it("refuses legacy sync over actual TLS without an ordinary receipt or sequence consumption", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp();
    const peer = await FakeConnector.connect(app, credentials);
    try {
      await peer.send("job.sync", {
        job_id: crypto.randomUUID(),
        attempt: 1,
        nonce: crypto.randomUUID(),
      });
      expect(await peer.next("protocol.error")).toMatchObject({
        payload: { code: "AUTHORIZATION_FAILED" },
      });
      expect(
        peer.wireReceived.some(
          (message) => message.type === "job.state" || message.type === "ack",
        ),
      ).toBe(false);
      const cursor = await db.query(
        "SELECT last_client_sequence FROM connectors WHERE id = $1",
        [credentials.connector_id],
      );
      expect(Number(cursor.rows[0]?.last_client_sequence)).toBe(1);
    } finally {
      await peer.disconnectWithoutAck();
      await app.close();
    }
  });

  it("receipts unseen original claims after normal gateway redispatch to the same or another connector", async () => {
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(67));
    const app = await startApp(5_000, cipher);
    try {
      const outcomes = await Promise.allSettled(
        [false, true].map(async (reassign) => {
          const ownerId = `redispatch-owner-${crypto.randomUUID()}`;
          const original = await seedConnector(db);
          const replacement = reassign ? await seedConnector(db) : original;
          const stranger = await seedConnector(db);
          await db.query(
            "INSERT INTO owners (id, display_name) VALUES ($1, 'Redispatch fixture')",
            [ownerId],
          );
          await db.query(
            "UPDATE connectors SET owner_id = $1 WHERE id = ANY($2::uuid[])",
            [
              ownerId,
              [
                original.connector_id,
                replacement.connector_id,
                stranger.connector_id,
              ],
            ],
          );
          const repositoryId = `redispatch-${crypto.randomUUID()}`;
          await db.query(
            "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path) VALUES ($1, $2, 'Redispatch fixture', '/redacted')",
            [repositoryId, ownerId],
          );
          const job = await new JobRepository(db.client).createIdempotent({
            ownerId,
            repositoryId,
            clientRequestId: crypto.randomUUID(),
            requestCiphertext: cipher.encrypt("Redispatch regression"),
            requestDigest: "fixture",
          });
          const identity = {
            ownerId,
            connectorId: original.connector_id,
            protocolVersion: "1.0",
          } as const;
          const server = new PostgresConnectorStore(db.client);
          const hello = buildConnectorHello({
            connectorId: original.connector_id,
            sequence: 1,
            lastServerSequence: 0,
            correlationId: crypto.randomUUID(),
            now: new Date(),
            capabilities: ["durable-receipts-v1"],
          });
          await server.acceptClientMessage(identity, hello);
          const offer = await server.dispatchNext(identity);
          if (offer === null) throw new Error("fixture offer missing");
          expect(offer.payload.job_id).toBe(job.jobId);
          const claim = ConnectorClientMessageSchema.parse({
            ...hello,
            type: "job.claim",
            sequence: 2,
            message_id: crypto.randomUUID(),
            correlation_id: crypto.randomUUID(),
            payload: {
              job_id: job.jobId,
              attempt: 1,
              lease_id: offer.payload.lease_id,
            },
          });
          const heartbeat = ConnectorClientMessageSchema.parse({
            ...hello,
            type: "connector.heartbeat",
            sequence: 3,
            message_id: crypto.randomUUID(),
            correlation_id: crypto.randomUUID(),
            payload: {},
          });
          const path = join(
            mkdtempSync(join(tmpdir(), "qhb-redispatch-")),
            "state.sqlite",
          );
          const local = new SqlitePluginStore(path);
          for (const message of [hello, claim, heartbeat])
            local.enqueueEvent(
              {
                messageId: message.message_id,
                sequence: message.sequence,
                payload: JSON.stringify(message),
              },
              message.type === "connector.hello",
            );
          const runs: Array<{
            controller: AbortController;
            running: Promise<void>;
          }> = [];
          const otherStores: SqlitePluginStore[] = [];
          try {
            // Real elapsed lease time: neither job deadlines nor authoritative
            // evidence are rewritten to simulate a redispatch.
            await db.query(
              "SELECT pg_sleep_until($1::timestamptz + interval '25 milliseconds')",
              [offer.expiresAt],
            );
            const tombstone = (
              await server.pendingServerMessages(identity, 0)
            ).find((row) => row.sequence === offer.sequence);
            expect(tombstone).toMatchObject({
              type: "protocol.error",
              payload: { code: "MESSAGE_EXPIRED" },
            });
            expect(tombstone?.payload).not.toHaveProperty("lease_id");

            if (reassign) {
              const other = new SqlitePluginStore(
                join(
                  mkdtempSync(join(tmpdir(), "qhb-redispatch-other-")),
                  "state.sqlite",
                ),
              );
              otherStores.push(other);
              const controller = new AbortController();
              runs.push({
                controller,
                running: harnessClient(app, replacement, other).start(
                  controller.signal,
                ),
              });
              await vi.waitFor(async () =>
                expect(
                  (
                    await db.query(
                      "SELECT connector_id FROM jobs WHERE id = $1",
                      [job.jobId],
                    )
                  ).rows[0]?.connector_id,
                ).toBe(replacement.connector_id),
              );
            }
            const received: Record<string, unknown>[] = [];
            const wires: Record<string, unknown>[] = [];
            const controller = new AbortController();
            const client = harnessClient(app, original, local, {
              webSocketFactory: (url, options) => {
                const socket = new WebSocket(url, {
                  ...options,
                  ca: LOCALHOST_TLS.cert,
                });
                socket.on("message", (data) =>
                  received.push(JSON.parse(String(data))),
                );
                const send = socket.send.bind(socket);
                socket.send = ((data: string) => {
                  wires.push(JSON.parse(data));
                  send(data);
                }) as typeof socket.send;
                return socket;
              },
            });
            runs.push({ controller, running: client.start(controller.signal) });
            await vi.waitFor(async () => {
              const row = (
                await db.query("SELECT lease_id FROM jobs WHERE id = $1", [
                  job.jobId,
                ])
              ).rows[0];
              expect(row?.lease_id).not.toBe(offer.payload.lease_id);
            });
            await vi.waitFor(
              () =>
                expect(local.provenClientSequence()).toBeGreaterThanOrEqual(3),
              { timeout: 3_000 },
            );
            const current = (
              await db.query(
                "SELECT connector_id, lease_id, status, attempt, revision FROM jobs WHERE id = $1",
                [job.jobId],
              )
            ).rows;
            expect(current).toEqual([
              {
                connector_id: replacement.connector_id,
                lease_id: expect.any(String),
                status: "dispatched",
                attempt: 0,
                revision: 2,
              },
            ]);
            expect(
              (
                await db.query(
                  "SELECT e.created_at <= m.created_at AS redispatched_first FROM job_events e JOIN connector_messages m ON m.connector_id = $2 AND m.direction = 'client' AND m.message_id = $3 WHERE e.job_id = $1 AND e.event_type = 'job.redispatched' AND e.source = 'control-plane'",
                  [job.jobId, identity.connectorId, claim.message_id],
                )
              ).rows,
            ).toEqual([{ redispatched_first: true }]);
            expect(
              received.filter(
                (message) => message.correlation_id === claim.correlation_id,
              ),
            ).toMatchObject([
              { type: "protocol.error", payload: { code: "CLAIM_REJECTED" } },
              { type: "ack", payload: { sequence: 2 } },
            ]);
            const { expires_at: _expiry, ...immutable } = claim;
            expect(
              wires.find((message) => message.message_id === claim.message_id),
            ).toMatchObject(immutable);
            expect(
              (
                await db.query(
                  "SELECT id FROM job_events WHERE job_id = $1 AND source = 'connector'",
                  [job.jobId],
                )
              ).rows,
            ).toEqual([]);
            // The audit must retain the complete original tuple after the wire
            // offer became a tombstone and the current connector/lease changed.
            const audit = (
              await db.query(
                "SELECT payload FROM job_events WHERE job_id = $1 AND event_type = 'job.dispatched' AND source = 'control-plane'",
                [job.jobId],
              )
            ).rows[0]?.payload;
            expect(audit).toMatchObject({
              owner_id: ownerId,
              connector_id: original.connector_id,
              repository_id: repositoryId,
              attempt: 1,
              lease_id: offer.payload.lease_id,
              lease_expires_at: offer.expiresAt.toISOString(),
            });

            for (const run of runs) run.controller.abort();
            await Promise.all(runs.map((run) => run.running));
            const strangerHello = buildConnectorHello({
              connectorId: stranger.connector_id,
              sequence: 1,
              lastServerSequence: 0,
              correlationId: crypto.randomUUID(),
              now: new Date(),
              capabilities: ["durable-receipts-v1"],
            });
            await rejectClaimOverTls(app, stranger, strangerHello, {
              ...claim,
              message_id: crypto.randomUUID(),
              correlation_id: crypto.randomUUID(),
            });
            const outsider = await seedConnector(db);
            await rejectClaimOverTls(
              app,
              outsider,
              buildConnectorHello({
                connectorId: outsider.connector_id,
                sequence: 1,
                lastServerSequence: 0,
                correlationId: crypto.randomUUID(),
                now: new Date(),
                capabilities: ["durable-receipts-v1"],
              }),
              {
                ...claim,
                message_id: crypto.randomUUID(),
                correlation_id: crypto.randomUUID(),
              },
            );
            expect(
              (
                await db.query(
                  "SELECT last_client_sequence FROM connectors WHERE id = $1",
                  [outsider.connector_id],
                )
              ).rows[0]?.last_client_sequence,
            ).toBe("1");
            await expect(
              server.acceptClientMessage(
                { ...identity, ownerId: OWNER_ID },
                claim,
              ),
            ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
            const cursor = Number(
              (
                await db.query(
                  "SELECT last_client_sequence FROM connectors WHERE id = $1",
                  [identity.connectorId],
                )
              ).rows[0]?.last_client_sequence,
            );
            if (claim.type !== "job.claim")
              throw new Error("fixture claim missing");
            for (const payload of [
              { ...claim.payload, lease_id: crypto.randomUUID() },
              { ...claim.payload, attempt: 2 },
              { ...claim.payload, job_id: crypto.randomUUID() },
            ]) {
              await rejectClaimOverTls(app, original, hello, {
                ...claim,
                sequence: cursor + 1,
                message_id: crypto.randomUUID(),
                correlation_id: crypto.randomUUID(),
                payload,
              });
            }
            expect(
              (
                await db.query(
                  "SELECT last_client_sequence FROM connectors WHERE id = $1",
                  [identity.connectorId],
                )
              ).rows[0]?.last_client_sequence,
            ).toBe(String(cursor));
            expect(
              (
                await db.query(
                  "SELECT last_client_sequence FROM connectors WHERE id = $1",
                  [stranger.connector_id],
                )
              ).rows[0]?.last_client_sequence,
            ).toBe("1");
            expect(
              (
                await db.query(
                  "SELECT connector_id, lease_id, status, attempt, revision FROM jobs WHERE id = $1",
                  [job.jobId],
                )
              ).rows,
            ).toEqual(current);
          } finally {
            for (const run of runs) run.controller.abort();
            await Promise.all(runs.map((run) => run.running));
            local.close();
            for (const other of otherStores) other.close();
          }
        }),
      );
      // Await both cleanup paths even when one regression fails.
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
    } finally {
      await app.close();
    }
  }, 45_000);

  it("retains a client ACK aborted after socket send before PostgreSQL receipt and recovers after restart", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const directory = mkdtempSync(join(tmpdir(), "qhb-receipt-abort-"));
    const path = join(directory, "state.sqlite");
    let store = new SqlitePluginStore(path);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const original = PostgresConnectorStore.prototype.acceptClientMessage;
    const spy = vi
      .spyOn(PostgresConnectorStore.prototype, "acceptClientMessage")
      .mockImplementation(async function (identity, message, now) {
        if (
          identity.connectorId === credentials.connector_id &&
          message.type === "ack" &&
          !waiting
        ) {
          waiting = true;
          await gate;
        }
        return original.call(this, identity, message, now);
      });
    const controller = new AbortController();
    const running = harnessClient(app, credentials, store).start(
      controller.signal,
    );
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      controller.abort();
      await running;
      expect(store.pendingEvents(0).map((row) => row.sequence)).toEqual([2]);
      expect(store.provenClientSequence()).toBe(1);
      expect(
        (
          await db.query(
            "SELECT last_client_sequence FROM connectors WHERE id = $1",
            [credentials.connector_id],
          )
        ).rows[0]?.last_client_sequence,
      ).toBe("1");
      release();
      await vi.waitFor(async () =>
        expect(
          (
            await db.query(
              "SELECT last_client_sequence FROM connectors WHERE id = $1",
              [credentials.connector_id],
            )
          ).rows[0]?.last_client_sequence,
        ).toBe("2"),
      );
      spy.mockRestore();
      store.close();
      store = new SqlitePluginStore(path);
      const resumed = new AbortController();
      const resumedRun = harnessClient(app, credentials, store).start(
        resumed.signal,
      );
      try {
        await vi.waitFor(() =>
          expect(store.provenClientSequence()).toBeGreaterThanOrEqual(2),
        );
      } finally {
        resumed.abort();
        await resumedRun;
      }
      expect(store.activeHello()?.sequence).toBe(1);
    } finally {
      release();
      controller.abort();
      await running;
      spy.mockRestore();
      store.close();
      await app.close();
    }
  });

  it("restores a lost product ACK from a real replay tombstone after durable restart", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const directory = mkdtempSync(join(tmpdir(), "qhb-ack-restore-"));
    const path = join(directory, "state.sqlite");
    let store = new SqlitePluginStore(path);
    const repositoryId = `restore-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'Restore fixture', '/redacted', false)",
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: "fixture",
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1 WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    let lostSequence = 0;
    const correlation = crypto.randomUUID();
    const first = harnessClient(app, credentials, store, {
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, {
          ...options,
          ca: LOCALHOST_TLS.cert,
        });
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string | symbol, ...args: unknown[]) => {
          if (event === "message") {
            const message = JSON.parse(String(args[0]));
            if (
              message.type === "ack" &&
              message.correlation_id === correlation
            ) {
              lostSequence = message.sequence;
              socket.close();
              return true;
            }
          }
          return emit(event, ...args);
        }) as typeof socket.emit;
        return socket;
      },
    });
    const controller = new AbortController();
    const running = first.start(controller.signal);
    try {
      await vi.waitFor(() =>
        expect(store.provenClientSequence()).toBeGreaterThanOrEqual(2),
      );
      await first.publish(
        "job.event",
        {
          job_id: job.jobId,
          attempt: 1,
          event_type: "progress",
          payload: { stage: "testing" },
          source: "harness",
        },
        correlation,
      );
      await vi.waitFor(() => expect(lostSequence).toBeGreaterThan(0));
      controller.abort();
      await running;
      const pending = store
        .pendingEvents(0)
        .find((row) => JSON.parse(row.payload).correlation_id === correlation);
      if (pending === undefined)
        throw new Error("fixture pending product missing");
      await db.query(
        "UPDATE connector_messages SET expires_at = clock_timestamp() - interval '1 second' WHERE connector_id = $1 AND direction = 'server' AND sequence = $2",
        [credentials.connector_id, lostSequence],
      );
      store.close();
      store = new SqlitePluginStore(path);
      const observed: string[] = [];
      const resumed = new AbortController();
      const resumedRun = harnessClient(app, credentials, store, {
        webSocketFactory: (url, options) => {
          const socket = new WebSocket(url, {
            ...options,
            ca: LOCALHOST_TLS.cert,
          });
          socket.on("message", (data) => {
            const message = JSON.parse(String(data));
            if (message.sequence === lostSequence) observed.push(message.type);
          });
          return socket;
        },
      }).start(resumed.signal);
      try {
        await vi.waitFor(
          () =>
            expect(store.provenClientSequence()).toBeGreaterThanOrEqual(
              pending.sequence,
            ),
          { timeout: 5_000 },
        );
      } finally {
        resumed.abort();
        await resumedRun;
      }
      expect(observed).toEqual(["protocol.error", "ack"]);
      expect(store.inboundMessageBySequence(lostSequence)?.delivered).toBe(
        true,
      );
      expect(
        JSON.parse(store.inboundMessageBySequence(lostSequence)?.body ?? "{}")
          .type,
      ).toBe("ack");
      expect(
        (
          await db.query(
            "SELECT id FROM job_events WHERE job_id = $1 AND source = 'harness'",
            [job.jobId],
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      controller.abort();
      await running;
      store.close();
      await app.close();
    }
  }, 15_000);
  it("drains 130 expired unreceived ACKs through both durable endpoints without overflowing admission", async () => {
    const credentials = await seedConnector(db);
    const app = await startApp(5_000);
    const directory = mkdtempSync(join(tmpdir(), "qhb-durable-endpoints-"));
    const local = new SqlitePluginStore(join(directory, "state.sqlite"));
    const old = new Date(Date.now() - 120_000);
    const hello = buildConnectorHello({
      connectorId: credentials.connector_id,
      sequence: 1,
      lastServerSequence: 0,
      correlationId: crypto.randomUUID(),
      now: old,
      capabilities: ["durable-receipts-v1"],
    });
    local.enqueueEvent(
      {
        messageId: hello.message_id,
        sequence: 1,
        payload: JSON.stringify(hello),
      },
      true,
    );
    for (let sequence = 2; sequence <= 131; sequence++) {
      const ack = ConnectorClientMessageSchema.parse({
        ...hello,
        type: "ack",
        sequence,
        message_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        payload: { sequence: 1 },
      });
      local.enqueueEvent({
        messageId: ack.message_id,
        sequence,
        payload: JSON.stringify(ack),
      });
    }
    const repositoryId = `expired-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO repository_policies (id, owner_id, display_name, canonical_path, enabled) VALUES ($1, $2, 'Expired fixture', '/redacted', false)",
      [repositoryId, OWNER_ID],
    );
    const job = await new JobRepository(db.client).createIdempotent({
      ownerId: OWNER_ID,
      clientRequestId: crypto.randomUUID(),
      repositoryId,
      requestCiphertext: "fixture",
      requestDigest: "fixture",
    });
    await db.query(
      "UPDATE jobs SET connector_id = $1, status = 'running', attempt = 1, expires_at = clock_timestamp() - interval '1 minute' WHERE id = $2",
      [credentials.connector_id, job.jobId],
    );
    const product = ConnectorClientMessageSchema.parse({
      ...hello,
      sequence: 132,
      message_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      type: "job.event",
      payload: {
        job_id: job.jobId,
        attempt: 1,
        event_type: "progress",
        payload: { stage: "testing" },
        source: "harness",
      },
    });
    const heartbeat = ConnectorClientMessageSchema.parse({
      ...hello,
      sequence: 133,
      message_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      type: "connector.heartbeat",
      payload: {},
    });
    for (const message of [product, heartbeat])
      local.enqueueEvent({
        messageId: message.message_id,
        sequence: message.sequence,
        payload: JSON.stringify(message),
      });
    const address = app.server.address() as AddressInfo;
    const closes: number[] = [];
    const wires: Record<string, unknown>[] = [];
    const client = createConnectorClient({
      connectorId: credentials.connector_id,
      controlPlaneUrl: `wss://127.0.0.1:${address.port}/connector/v1`,
      store: local,
      bootstrapCredentialProvider: async () => credentials.credential_secret,
      sessionTokenClient: {
        exchange: async () => {
          const session = await FakeConnector.exchangeSession(app, credentials);
          return {
            token: session.token,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          };
        },
      },
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, {
          ...options,
          ca: LOCALHOST_TLS.cert,
        });
        const send = socket.send.bind(socket);
        socket.send = ((data: string) => {
          wires.push(JSON.parse(data));
          send(data);
        }) as typeof socket.send;
        socket.on("close", (code: number) => closes.push(code));
        return socket;
      },
      reconnectDelay: () => 10,
    });
    const controller = new AbortController();
    const running = client.start(controller.signal);
    try {
      await vi.waitFor(
        () => expect(local.provenClientSequence()).toBeGreaterThanOrEqual(133),
        { timeout: 10_000 },
      );
      expect(closes).not.toContain(1013);
      expect(wires.filter((m) => m.type === "connector.hello")).toHaveLength(1);
      expect(wires[0]).toMatchObject({
        message_id: hello.message_id,
        sequence: 1,
        sent_at: hello.sent_at,
      });
      expect(Date.parse(String(wires[0]?.expires_at))).toBeGreaterThan(
        Date.parse(hello.expires_at),
      );
      const receipts = await db.query<{ count: string }>(
        "SELECT count(*) FROM connector_messages WHERE connector_id = $1 AND direction = 'client'",
        [credentials.connector_id],
      );
      expect(Number(receipts.rows[0]?.count)).toBeGreaterThanOrEqual(131);
      const outcomes = await db.query(
        "SELECT type, payload FROM connector_messages WHERE connector_id = $1 AND direction = 'server' AND correlation_id = $2 ORDER BY sequence",
        [credentials.connector_id, product.correlation_id],
      );
      expect(outcomes.rows).toMatchObject([
        { type: "protocol.error", payload: { code: "EVENT_REJECTED" } },
        { type: "ack", payload: { sequence: 132 } },
      ]);
      expect(
        (
          await db.query(
            "SELECT id FROM job_events WHERE job_id = $1 AND source = 'harness'",
            [job.jobId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query("SELECT status, revision FROM jobs WHERE id = $1", [
            job.jobId,
          ])
        ).rows[0],
      ).toMatchObject({ status: "running", revision: 0 });
    } finally {
      controller.abort();
      await running;
      local.close();
      await app.close();
    }
    const reopened = new SqlitePluginStore(join(directory, "state.sqlite"));
    expect(reopened.provenClientSequence()).toBeGreaterThanOrEqual(131);
    expect(reopened.activeHello()?.messageId).toBe(hello.message_id);
    reopened.close();
  }, 15_000);
  it("contains synchronous Upgrade construction failures without an unhandled rejection", async () => {
    const server = https.createServer(LOCALHOST_TLS);
    const signingKey = "gateway-upgrade-failure-signing-key-fixture";
    const gateway = createConnectorGateway(server, {
      database: db.client,
      sessionSigningKey: signingKey,
    });
    const session = createConnectorSessionService({
      signingKey,
      now: () => new Date(),
    });
    const connectorId = crypto.randomUUID();
    const token = session.issue({
      ownerId: "gateway-upgrade-failure-owner",
      connectorId,
      protocolVersion: "1.0",
    });
    const key = Buffer.alloc(16).toString("base64");
    const socket = new PassThrough();
    let destroyCalls = 0;
    const originalDestroy = socket.destroy.bind(socket);
    socket.destroy = ((...args: Parameters<typeof socket.destroy>) => {
      destroyCalls += 1;
      return originalDestroy(...args);
    }) as typeof socket.destroy;
    socket.write = (() => {
      throw new Error("injected Upgrade write failure");
    }) as typeof socket.write;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      server.emit(
        "upgrade",
        {
          url: "/connector/v1",
          rawHeaders: ["Authorization", `Bearer ${token}`],
          headers: {
            authorization: `Bearer ${token}`,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": key,
          },
        } as IncomingMessage,
        socket,
        Buffer.alloc(0),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(destroyCalls).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await gateway.close(server);
    }
  });

  it("times out a stalled hello and closes the raw socket", async () => {
    const stalled = await startStalledWebSocketServer();
    const credentials: ConnectorCredentials = {
      connector_id: crypto.randomUUID(),
      credential_id: `stalled-${crypto.randomUUID()}`,
      credential_secret: `stalled-secret-${crypto.randomUUID()}`,
    };

    try {
      await expect(
        FakeConnector.connectWithSessionToken(
          { server: stalled.server },
          credentials,
          "stalled-session-fixture",
        ),
      ).rejects.toThrow(
        "Timed out waiting for Connector message connector.welcome",
      );
      await stalled.socketClosed;
      expect(stalled.socket?.destroyed).toBe(true);
    } finally {
      stalled.socket?.destroy();
      await new Promise<void>((resolve, reject) =>
        stalled.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
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

  it("accepts uppercase UUIDs through session exchange and a raw WebSocket hello", async () => {
    const app = await startApp();
    const credentials = await seedConnector(db);
    const uppercaseCredentials = {
      ...credentials,
      connector_id: credentials.connector_id.toUpperCase(),
    };
    const hello = JSON.stringify({
      protocol_version: "1.0",
      message_id: "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase(),
      sequence: 1,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      correlation_id: "fedcbafe-dcba-4fed-8cba-fedcbafedcba".toUpperCase(),
      type: "connector.hello",
      payload: {
        connector_id: uppercaseCredentials.connector_id,
        connector_version: "uppercase-uuid-test/1.0",
        capabilities: ["harness", "integration-test"],
        last_server_sequence: 0,
        last_client_sequence: 0,
      },
    });

    try {
      const session = await FakeConnector.exchangeSession(
        app,
        uppercaseCredentials,
      );
      expect(session.token).toEqual(expect.any(String));

      const socket = await rawConnectorSocketWithCoalescedHead(
        app,
        uppercaseCredentials,
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
      }
    } finally {
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

      const closing = app.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(appClosed).toBe(false);
      releaseAccept?.();
      await closing;
      appClosed = true;

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

  it("terminates stalled store work and waits for release before app.close resolves", async () => {
    const originalAcceptClientMessage =
      PostgresConnectorStore.prototype.acceptClientMessage;
    let releaseHeartbeat: (() => void) | undefined;
    let heartbeatStarted!: () => void;
    let heartbeatStoreSettled!: () => void;
    let heartbeatStoreIsSettled = false;
    let closeResolved = false;
    let closeResolvedBeforeHeartbeatStore = false;
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    let socket: Duplex | undefined;
    let gatewaySocket: Socket | undefined;
    let closing: Promise<void> | undefined;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    const heartbeatWorkStarted = new Promise<void>((resolve) => {
      heartbeatStarted = resolve;
    });
    const heartbeatWorkSettled = new Promise<void>((resolve) => {
      heartbeatStoreSettled = resolve;
    });
    const terminateStoreOperations = vi.fn(async () => {
      releaseHeartbeat?.();
      await heartbeatWorkSettled;
    });
    vi.spyOn(
      PostgresConnectorStore.prototype,
      "acceptClientMessage",
    ).mockImplementation(async function (identity, message, now) {
      if (message.type === "connector.heartbeat") {
        heartbeatStarted();
        await heartbeatGate;
      }
      const result = await originalAcceptClientMessage.call(
        this,
        identity,
        message,
        now,
      );
      if (message.type === "connector.heartbeat") {
        heartbeatStoreIsSettled = true;
        heartbeatStoreSettled();
      }
      return result;
    });

    try {
      const runningApp = await startApp(
        5_000,
        undefined,
        terminateStoreOperations,
      );
      app = runningApp;
      runningApp.server.once("secureConnection", (acceptedSocket: Socket) => {
        gatewaySocket = acceptedSocket;
      });
      const credentials = await seedConnector(db);
      const connectorSocket = await rawConnectorSocket(runningApp, credentials);
      socket = connectorSocket;
      (connectorSocket as Duplex & { allowHalfOpen?: boolean }).allowHalfOpen =
        true;
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
          connector_version: "shutdown-evidence-test/1.0",
          capabilities: ["harness", "integration-test"],
          last_server_sequence: 0,
          last_client_sequence: 0,
        },
      });
      sendRawFrame(connectorSocket, 0x1, Buffer.from(hello));
      await expect(
        waitForServerMessage(
          connectorSocket,
          (message) => message.type === "connector.welcome",
        ),
      ).resolves.toMatchObject({
        type: "connector.welcome",
        payload: { connector_id: credentials.connector_id },
      });

      sendRawFrame(
        connectorSocket,
        0x1,
        Buffer.from(
          JSON.stringify({
            protocol_version: "1.0",
            message_id: crypto.randomUUID(),
            sequence: 2,
            sent_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            correlation_id: crypto.randomUUID(),
            type: "connector.heartbeat",
            payload: {},
          }),
        ),
      );
      await heartbeatWorkStarted;

      // Do not answer Gateway's close frame. The raw socket close event is the
      // observable boundary for the Gateway's close-I/O deadline.
      connectorSocket.on("data", () => undefined);
      const socketClosed = new Promise<void>((resolve, reject) => {
        if (gatewaySocket === undefined) {
          reject(new Error("Gateway secure socket was not observed"));
          return;
        }
        gatewaySocket.once("close", () => resolve());
      });
      closing = runningApp.close();
      void closing.then(() => {
        closeResolved = true;
        if (!heartbeatStoreIsSettled) closeResolvedBeforeHeartbeatStore = true;
      });

      await socketClosed;
      expect(gatewaySocket?.destroyed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(closing).resolves.toBeUndefined();
      expect(closeResolved).toBe(true);
      expect(terminateStoreOperations).toHaveBeenCalledTimes(1);
      expect(closeResolvedBeforeHeartbeatStore).toBe(false);
      expect(heartbeatStoreIsSettled).toBe(true);

      await heartbeatWorkSettled;
      await expect(
        db.query<{ last_client_sequence: number }>(
          "SELECT last_client_sequence::integer AS last_client_sequence FROM connectors WHERE id = $1",
          [credentials.connector_id],
        ),
      ).resolves.toMatchObject({ rows: [{ last_client_sequence: 2 }] });
    } finally {
      releaseHeartbeat?.();
      socket?.destroy();
      vi.restoreAllMocks();
      if (closing !== undefined) {
        await closing;
      } else if (app?.server.listening) {
        await app.close();
      }
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
