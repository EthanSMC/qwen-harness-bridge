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
const SOCKET_WRITE_TIMEOUT_MS = 1_000;
const DEFAULT_DISPATCH_INTERVAL_MS = 250;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const isValidCloseStatusCode = (code: number): boolean =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);

const awaitBeforeDeadline = async <T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T | undefined> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), remaining);
    timer.unref();
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

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
  #closing = false;

  constructor(socket: Duplex, head: Buffer, handlers: FrameHandlers) {
    this.#socket = socket;
    this.#buffer = head;
    this.#handlers = handlers;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.once("close", () => this.#finish());
    socket.once("error", () => this.#finish());
    if (head.length > 0) this.#read(Buffer.alloc(0));
  }

  async sendJson(message: ConnectorServerMessage): Promise<void> {
    await this.#sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  close(): void {
    void this.closeGracefully().catch(() => undefined);
  }

  #closeForProtocolError(): void {
    void this.closeGracefully(1002).catch(() => undefined);
  }

  async closeGracefully(
    statusCode?: number,
    deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
  ): Promise<void> {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    try {
      const payload =
        statusCode === undefined
          ? Buffer.alloc(0)
          : Buffer.from([(statusCode >> 8) & 0xff, statusCode & 0xff]);
      await this.#sendFrame(0x8, payload, true, deadline);
      const remaining = deadline - Date.now();
      if (remaining > 0 && !this.#closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          timer.unref();
          this.#socket.end(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      this.#finish();
    }
  }

  async #sendFrame(
    opcode: number,
    payload: Buffer,
    allowClosing = false,
    deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
  ): Promise<void> {
    if (this.#closed || (this.#closing && !allowClosing)) {
      throw new Error("Connector WebSocket is closed");
    }
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
    await new Promise<void>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.#finish();
        reject(new Error("Connector WebSocket write deadline exceeded"));
        return;
      }
      const timer = setTimeout(() => {
        this.#finish();
        reject(new Error("Connector WebSocket write timed out"));
      }, remaining);
      timer.unref();
      this.#socket.write(frame, (error?: Error | null) => {
        clearTimeout(timer);
        if (error !== undefined && error !== null) {
          this.#finish();
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #read(chunk: Buffer): void {
    if (this.#closing) return;
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.length >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      if (
        (first & 0x80) === 0 ||
        (first & 0x70) !== 0 ||
        (second & 0x80) === 0
      ) {
        this.close();
        return;
      }
      const opcode = first & 0x0f;
      const lengthCode = second & 0x7f;
      const controlFrame = opcode >= 0x8;
      if (
        ![0x1, 0x8, 0x9, 0xa].includes(opcode) ||
        (controlFrame && lengthCode > 125)
      ) {
        this.close();
        return;
      }
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
      if (opcode === 0x8) {
        if (payload.length === 1) {
          this.#closeForProtocolError();
          return;
        }
        if (payload.length >= 2) {
          const statusCode = payload.readUInt16BE(0);
          if (!isValidCloseStatusCode(statusCode)) {
            this.#closeForProtocolError();
            return;
          }
          try {
            utf8Decoder.decode(payload.subarray(2));
          } catch {
            this.#closeForProtocolError();
            return;
          }
        }
        void this.closeGracefully().catch(() => undefined);
        return;
      }
      if (opcode === 0x1) {
        try {
          this.#handlers.message(utf8Decoder.decode(payload));
        } catch {
          this.close();
          return;
        }
      } else if (opcode === 0x9) {
        void this.#sendFrame(0xa, payload).catch(() => this.#finish());
      }
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    if (!this.#socket.destroyed) this.#socket.destroy();
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
    const decodedKey =
      typeof key === "string" ? Buffer.from(key, "base64") : undefined;
    const connectionTokens = request.headers.connection
      ?.split(",")
      .map((token) => token.trim().toLowerCase());
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !connectionTokens?.includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" ||
      decodedKey?.length !== 16 ||
      decodedKey.toString("base64") !== key
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
    let accepting = true;
    let scanAfterSequence = 0;
    let processing = Promise.resolve();
    let dispatching = false;
    let failureGeneration = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const canContinue = (generation: number): boolean =>
      accepting && generation === failureGeneration && !this.#closed;
    const sendStored = async (
      connection: ServerWebSocket,
      stored: StoredServerMessage,
      retransmit = false,
      generation = failureGeneration,
    ): Promise<boolean> => {
      if (!canContinue(generation)) return false;
      if (!retransmit && stored.sequence <= scanAfterSequence) return true;
      const message = await this.#store.materializeServerMessage(
        stored,
        this.#requestDecryptor,
      );
      if (!canContinue(generation)) return false;
      await connection.sendJson(message);
      if (!retransmit && canContinue(generation)) {
        scanAfterSequence = Math.max(scanAfterSequence, stored.sequence);
      }
      return true;
    };
    const pump = async (connection: ServerWebSocket): Promise<void> => {
      const generation = failureGeneration;
      if (!canContinue(generation) || !initialized || dispatching) {
        return;
      }
      dispatching = true;
      try {
        if (!canContinue(generation)) return;
        await this.#store.dispatchNext(identity, this.#now());
        if (!canContinue(generation)) return;
        const pending = await this.#store.pendingServerMessages(
          identity,
          scanAfterSequence,
          this.#now(),
        );
        for (const message of pending) {
          if (!(await sendStored(connection, message, false, generation))) {
            return;
          }
        }
      } finally {
        dispatching = false;
      }
    };
    let connection: ServerWebSocket;
    const closeConnection = (): void => {
      accepting = false;
      if (timer !== undefined) clearInterval(timer);
      this.#connections.delete(connection);
    };
    const failProtocol = async (code: string): Promise<void> => {
      if (!accepting) return;
      accepting = false;
      failureGeneration += 1;
      if (timer !== undefined) clearInterval(timer);
      const deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS;
      try {
        const errorMessage = await awaitBeforeDeadline(
          () =>
            this.#store.enqueueServer(
              identity,
              "protocol.error",
              { code, message: "Connector protocol error." },
              new Date(this.#now().getTime() + 60_000),
            ),
          deadline,
        );
        if (
          errorMessage !== undefined &&
          errorMessage.sequence === scanAfterSequence + 1
        ) {
          const error = await awaitBeforeDeadline(
            () =>
              this.#store.materializeServerMessage(
                errorMessage,
                this.#requestDecryptor,
              ),
            deadline,
          );
          if (error !== undefined) {
            await awaitBeforeDeadline(
              () => connection.sendJson(error),
              deadline,
            );
          }
        }
      } finally {
        await connection.closeGracefully(undefined, deadline);
      }
    };
    const handle = async (serialized: string): Promise<void> => {
      if (!accepting) return;
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
        if (message.type === "connector.hello" && !initialized) {
          scanAfterSequence = message.payload.last_server_sequence;
        }
        for (const replay of accepted.replay)
          await sendStored(connection, replay);
        if (accepted.response !== null) {
          await sendStored(connection, accepted.response, accepted.duplicate);
        }
        if (message.type === "connector.hello" && !initialized) {
          initialized = true;
          timer = setInterval(() => {
            void pump(connection).catch(() => {
              accepting = false;
              connection.close();
            });
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
        if (!accepting) return;
        processing = processing
          .then(() => handle(value))
          .catch(() => {
            accepting = false;
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
