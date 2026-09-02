import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  type ConnectorServerMessage,
} from "@qhb/protocol";
import type { Database } from "../db/client.js";
import type { RequestDecryptor } from "../domain/job-coordinator.js";
import {
  CONNECTOR_OFFLINE_AFTER_MS,
  type ConnectorIdentity,
  ConnectorStoreError,
  HEARTBEAT_INTERVAL_MS,
  PostgresConnectorStore,
  type StoredServerMessage,
} from "./outbox.js";
import {
  type ConnectorSessionClaims,
  createConnectorSessionService,
} from "./session.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_DISPATCH_INTERVAL_MS = 250;

export type ConnectorGatewayOptions = Readonly<{
  database: Database;
  sessionSigningKey: string | Uint8Array;
  requestDecryptor?: RequestDecryptor;
  dispatchIntervalMs?: number;
  now?: () => Date;
}>;

type FrameHandlers = Readonly<{
  message(value: string): void;
  close(): void;
}>;

class ServerWebSocket {
  readonly #socket: Duplex;
  readonly #handlers: FrameHandlers;
  #buffer: Buffer;
  #closed = false;

  constructor(socket: Duplex, head: Buffer, handlers: FrameHandlers) {
    this.#socket = socket;
    this.#buffer = head;
    this.#handlers = handlers;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.once("close", () => this.#finish());
    socket.once("error", () => this.#finish());
    if (head.length > 0) this.#read(Buffer.alloc(0));
  }

  sendJson(message: ConnectorServerMessage): void {
    this.#sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  close(): void {
    if (this.#closed) return;
    this.#sendFrame(0x8, Buffer.alloc(0));
    this.#finish();
  }

  #sendFrame(opcode: number, payload: Buffer): void {
    if (this.#closed) return;
    const length = payload.length;
    const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
    const frame = Buffer.alloc(headerLength + length);
    frame[0] = 0x80 | opcode;
    if (length < 126) {
      frame[1] = length;
    } else if (length <= 0xffff) {
      frame[1] = 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }
    payload.copy(frame, headerLength);
    this.#socket.write(frame);
  }

  #read(chunk: Buffer): void {
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.length >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      if ((first & 0x80) === 0 || (second & 0x80) === 0) {
        this.close();
        return;
      }
      const opcode = first & 0x0f;
      const lengthCode = second & 0x7f;
      let offset = 2;
      let length: number;
      if (lengthCode < 126) {
        length = lengthCode;
      } else if (lengthCode === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else {
        if (this.#buffer.length < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if (extended > BigInt(MAX_FRAME_BYTES)) {
          this.close();
          return;
        }
        length = Number(extended);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close();
        return;
      }
      const frameLength = offset + 4 + length;
      if (this.#buffer.length < frameLength) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(
        this.#buffer.subarray(offset + 4, frameLength),
      );
      this.#buffer = this.#buffer.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4] ?? 0;
      }
      if (opcode === 0x1) {
        this.#handlers.message(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.#sendFrame(0xa, payload);
      } else if (opcode !== 0xa) {
        this.close();
        return;
      }
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#handlers.close();
  }
}

const authorizationHeaderCount = (request: IncomingMessage): number => {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization")
      count += 1;
  }
  return count;
};

const rejectUpgrade = (socket: Duplex, status = 401): void => {
  const reason = status === 404 ? "Not Found" : "Unauthorized";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
};

const identityFromClaims = (
  claims: ConnectorSessionClaims,
): ConnectorIdentity => ({
  ownerId: claims.owner_id,
  connectorId: claims.connector_id,
  protocolVersion: claims.protocol_version,
});

export class ConnectorGateway {
  readonly #store: PostgresConnectorStore;
  readonly #sessionService: ReturnType<typeof createConnectorSessionService>;
  readonly #requestDecryptor: RequestDecryptor | undefined;
  readonly #dispatchIntervalMs: number;
  readonly #now: () => Date;
  readonly #connections = new Set<ServerWebSocket>();
  readonly #upgradeListener: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  readonly #healthTimer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(server: HttpsServer, options: ConnectorGatewayOptions) {
    this.#store = new PostgresConnectorStore(options.database);
    this.#sessionService = createConnectorSessionService({
      signingKey: options.sessionSigningKey,
      now: options.now ?? (() => new Date()),
    });
    this.#requestDecryptor = options.requestDecryptor;
    this.#now = options.now ?? (() => new Date());
    this.#dispatchIntervalMs =
      options.dispatchIntervalMs === undefined
        ? DEFAULT_DISPATCH_INTERVAL_MS
        : options.dispatchIntervalMs;
    if (
      !Number.isSafeInteger(this.#dispatchIntervalMs) ||
      this.#dispatchIntervalMs < 10 ||
      this.#dispatchIntervalMs > 5_000
    ) {
      throw new Error("Connector dispatch interval must be 10..5000 ms");
    }
    this.#upgradeListener = (request, socket, head) => {
      void this.#upgrade(request, socket, head);
    };
    server.on("upgrade", this.#upgradeListener);
    this.#healthTimer = setInterval(() => {
      void this.#store.refreshHealth(this.#now()).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.#healthTimer.unref();
  }

  get store(): PostgresConnectorStore {
    return this.#store;
  }

  get sessionService(): ReturnType<typeof createConnectorSessionService> {
    return this.#sessionService;
  }

  close(server: HttpsServer): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#healthTimer);
    server.off("upgrade", this.#upgradeListener);
    for (const connection of this.#connections) connection.close();
    this.#connections.clear();
  }

  async #upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "https://localhost").pathname;
    } catch {
      return rejectUpgrade(socket, 404);
    }
    if (pathname !== "/connector/v1") return rejectUpgrade(socket, 404);
    let claims: ConnectorSessionClaims;
    try {
      if (authorizationHeaderCount(request) !== 1) throw new Error("auth");
      claims = this.#sessionService.authenticate(request.headers);
    } catch {
      return rejectUpgrade(socket);
    }
    const key = request.headers["sec-websocket-key"];
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" ||
      Buffer.from(key, "base64").length !== 16
    ) {
      return rejectUpgrade(socket);
    }
    const accept = createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`, "ascii")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.#openConnection(socket, head, identityFromClaims(claims));
  }

  #openConnection(
    socket: Duplex,
    head: Buffer,
    identity: ConnectorIdentity,
  ): void {
    let initialized = false;
    let replayAfterSequence = 0;
    let processing = Promise.resolve();
    let dispatching = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sentSequences = new Set<number>();
    const sendStored = async (
      connection: ServerWebSocket,
      stored: StoredServerMessage,
    ): Promise<void> => {
      if (sentSequences.has(stored.sequence)) return;
      const message = await this.#store.materializeServerMessage(
        stored,
        this.#requestDecryptor,
      );
      connection.sendJson(message);
      sentSequences.add(stored.sequence);
    };
    const pump = async (connection: ServerWebSocket): Promise<void> => {
      if (!initialized || dispatching || this.#closed) return;
      dispatching = true;
      try {
        const offer = await this.#store.dispatchNext(identity, this.#now());
        if (offer !== null) await sendStored(connection, offer);
        const pending = await this.#store.pendingServerMessages(
          identity,
          replayAfterSequence,
          this.#now(),
        );
        for (const message of pending) await sendStored(connection, message);
      } finally {
        dispatching = false;
      }
    };
    let connection: ServerWebSocket;
    const closeConnection = (): void => {
      if (timer !== undefined) clearInterval(timer);
      this.#connections.delete(connection);
    };
    const failProtocol = async (code: string): Promise<void> => {
      try {
        const error = await this.#store.enqueueServer(
          identity,
          "protocol.error",
          { code, message: "Connector protocol error." },
          new Date(this.#now().getTime() + 60_000),
        );
        await sendStored(connection, error);
      } finally {
        connection.close();
      }
    };
    const handle = async (serialized: string): Promise<void> => {
      let message: ConnectorClientMessage;
      try {
        message = ConnectorClientMessageSchema.parse(JSON.parse(serialized));
      } catch {
        return failProtocol("INVALID_MESSAGE");
      }
      if (!initialized && message.type !== "connector.hello") {
        return failProtocol("HELLO_REQUIRED");
      }
      try {
        const accepted = await this.#store.acceptClientMessage(
          identity,
          message,
          this.#now(),
        );
        for (const replay of accepted.replay)
          await sendStored(connection, replay);
        if (accepted.response !== null) {
          await sendStored(connection, accepted.response);
        }
        if (message.type === "connector.hello" && !initialized) {
          replayAfterSequence = message.payload.last_server_sequence;
          initialized = true;
          timer = setInterval(() => {
            void pump(connection).catch(() => connection.close());
          }, this.#dispatchIntervalMs);
          timer.unref();
          await pump(connection);
        }
      } catch (error) {
        const code =
          error instanceof ConnectorStoreError ? error.code : "INTERNAL";
        await failProtocol(code);
      }
    };
    connection = new ServerWebSocket(socket, head, {
      message(value) {
        processing = processing
          .then(() => handle(value))
          .catch(() => {
            connection.close();
          });
      },
      close: closeConnection,
    });
    this.#connections.add(connection);
  }
}

export const createConnectorGateway = (
  server: HttpsServer,
  options: ConnectorGatewayOptions,
): ConnectorGateway => new ConnectorGateway(server, options);

export const connectorSessionExpiry = (
  claims: ConnectorSessionClaims,
): string => new Date(claims.exp * 1000).toISOString();

export const connectorOfflineDeadline = (lastHeartbeat: Date): Date =>
  new Date(lastHeartbeat.getTime() + CONNECTOR_OFFLINE_AFTER_MS);
