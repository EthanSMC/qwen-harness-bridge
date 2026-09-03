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
const MAX_FRAGMENT_COUNT = 1_024;
const MAX_FRAGMENT_OVERHEAD_BYTES = 64 * 1024;
const MAX_PENDING_MESSAGES = 128;
const MAX_PENDING_MESSAGE_BYTES = 512 * 1024;
const MAX_SCHEDULED_STORE_OPERATIONS = 2;
const MAX_OUTBOUND_QUEUE_FRAMES = 128;
const MAX_OUTBOUND_QUEUE_BYTES = 256 * 1024;
const SOCKET_WRITE_TIMEOUT_MS = 1_000;
const DEFAULT_DISPATCH_INTERVAL_MS = 250;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const DEADLINE_EXCEEDED = Symbol("connector gateway deadline exceeded");

const isValidCloseStatusCode = (code: number): boolean =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);

const awaitBeforeDeadline = async <T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T | typeof DEADLINE_EXCEEDED> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return DEADLINE_EXCEEDED;
  return new Promise<T | typeof DEADLINE_EXCEEDED>((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), remaining);
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

type OutboundWrite = {
  frame: Buffer;
  deadline: number;
  resolve(): void;
  reject(error: Error): void;
};

class ServerWebSocket {
  readonly #socket: Duplex;
  readonly #handlers: FrameHandlers;
  #buffer: Buffer;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #fragmentedText: Buffer[] | undefined;
  #fragmentedTextBytes = 0;
  #fragmentedTextFrameCount = 0;
  #fragmentedTextOverheadBytes = 0;
  #outboundQueue: OutboundWrite[] = [];
  #outboundQueueBytes = 0;
  #writeInProgress = false;
  #pendingPong: Buffer | undefined;
  #pongDraining = false;

  constructor(socket: Duplex, head: Buffer, handlers: FrameHandlers) {
    this.#socket = socket;
    this.#buffer = head;
    this.#handlers = handlers;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.once("close", () => this.#finish());
    socket.once("error", () => this.#finish());
    if (head.length > 0) this.#read(Buffer.alloc(0));
  }

  get isClosing(): boolean {
    return this.#closing;
  }

  async sendJson(
    message: ConnectorServerMessage,
    deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
  ): Promise<void> {
    await this.#sendFrame(
      0x1,
      Buffer.from(JSON.stringify(message), "utf8"),
      false,
      deadline,
    );
  }

  close(): Promise<void> {
    return this.closeGracefully();
  }

  #closeForProtocolError(statusCode = 1002): void {
    void this.closeGracefully(statusCode).catch(() => undefined);
  }

  closeGracefully(
    statusCode?: number,
    deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
  ): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#pendingPong = undefined;
    this.#dropQueuedWrites(new Error("Connector WebSocket is closing"));
    this.#closePromise = this.#performClose(statusCode, deadline);
    return this.#closePromise;
  }

  async #performClose(statusCode: number | undefined, deadline: number) {
    try {
      const payload =
        statusCode === undefined
          ? Buffer.alloc(0)
          : Buffer.from([(statusCode >> 8) & 0xff, statusCode & 0xff]);
      await this.#sendFrame(0x8, payload, true, deadline);
      const remaining = deadline - Date.now();
      if (remaining > 0 && !this.#closed) {
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.#finish();
            resolve();
          }, remaining);
          timer.unref();
          this.#socket.once("close", finish);
          this.#socket.end();
        });
      }
    } finally {
      this.#finish();
    }
  }

  #sendFrame(
    opcode: number,
    payload: Buffer,
    allowClosing = false,
    deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
  ): Promise<void> {
    if (this.#closed || (this.#closing && !allowClosing)) {
      return Promise.reject(new Error("Connector WebSocket is closed"));
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
    if (
      this.#outboundQueue.length >= MAX_OUTBOUND_QUEUE_FRAMES ||
      this.#outboundQueueBytes + frame.length > MAX_OUTBOUND_QUEUE_BYTES
    ) {
      const error = new Error("Connector WebSocket outbound queue exceeded");
      this.#finish();
      return Promise.reject(error);
    }
    const write = new Promise<void>((resolve, reject) => {
      this.#outboundQueue.push({ frame, deadline, resolve, reject });
      this.#outboundQueueBytes += frame.length;
    });
    this.#drainWrites();
    return write;
  }

  #drainWrites(): void {
    if (this.#closed || this.#writeInProgress) return;
    const write = this.#outboundQueue.shift();
    if (write === undefined) return;
    this.#outboundQueueBytes -= write.frame.length;
    this.#writeInProgress = true;
    void this.#writeOne(write.frame, write.deadline)
      .then(
        () => write.resolve(),
        (error: unknown) =>
          write.reject(
            error instanceof Error
              ? error
              : new Error("Connector WebSocket write failed"),
          ),
      )
      .then(
        () => {
          this.#writeInProgress = false;
          this.#drainWrites();
        },
        () => {
          this.#writeInProgress = false;
          this.#drainWrites();
        },
      );
  }

  #writeOne(frame: Buffer, deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.#finish();
        reject(new Error("Connector WebSocket write deadline exceeded"));
        return;
      }
      let settled = false;
      let callbackDone = false;
      let writeReturned = false;
      let needsDrain = false;
      let drainSeen = false;
      const timer = setTimeout(() => {
        finish(new Error("Connector WebSocket write timed out"));
      }, remaining);
      timer.unref();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#socket.off("drain", onDrain);
        this.#socket.off("error", onError);
        this.#socket.off("close", onClose);
        if (error === undefined) {
          resolve();
        } else {
          this.#finish();
          reject(error);
        }
      };
      const maybeFinish = (): void => {
        if (writeReturned && callbackDone && (!needsDrain || drainSeen)) {
          finish();
        }
      };
      const onDrain = (): void => {
        drainSeen = true;
        maybeFinish();
      };
      const onError = (error: Error): void => finish(error);
      const onClose = (): void =>
        finish(new Error("Connector WebSocket closed during write"));
      this.#socket.once("error", onError);
      this.#socket.once("close", onClose);
      try {
        const returned = this.#socket.write(frame, (error?: Error | null) => {
          if (error !== undefined && error !== null) {
            finish(error);
            return;
          }
          callbackDone = true;
          maybeFinish();
        });
        needsDrain = !returned;
        if (!needsDrain) drainSeen = true;
        if (needsDrain && !settled) this.#socket.once("drain", onDrain);
        writeReturned = true;
        maybeFinish();
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Connector WebSocket write failed"),
        );
      }
    });
  }

  #dropQueuedWrites(error: Error): void {
    const queued = this.#outboundQueue.splice(0);
    this.#outboundQueueBytes = 0;
    for (const write of queued) write.reject(error);
  }

  #queuePong(payload: Buffer): void {
    if (this.#closed || this.#closing) return;
    this.#pendingPong = Buffer.from(payload);
    if (this.#pongDraining) return;
    this.#pongDraining = true;
    void this.#drainPongs().then(
      () => {
        this.#pongDraining = false;
      },
      () => {
        this.#pongDraining = false;
        this.#finish();
      },
    );
  }

  async #drainPongs(): Promise<void> {
    while (!this.#closed && !this.#closing) {
      const payload = this.#pendingPong;
      if (payload === undefined) return;
      this.#pendingPong = undefined;
      await this.#sendFrame(0xa, payload);
    }
  }

  #read(chunk: Buffer): void {
    if (this.#closing) return;
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.length >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const controlFrame = opcode >= 0x8;
      const lengthCode = second & 0x7f;
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) {
        this.#closeForProtocolError();
        return;
      }
      if (
        ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode) ||
        (controlFrame && (!fin || lengthCode > 125)) ||
        (opcode === 0x0 && this.#fragmentedText === undefined) ||
        (opcode === 0x1 && this.#fragmentedText !== undefined)
      ) {
        this.#closeForProtocolError();
        return;
      }
      if (opcode === 0x2) {
        this.#closeForProtocolError(1003);
        return;
      }
      let offset = 2;
      let length: number;
      if (lengthCode < 126) {
        length = lengthCode;
      } else if (lengthCode === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        if (length < 126) {
          this.#closeForProtocolError();
          return;
        }
        offset = 4;
      } else {
        if (this.#buffer.length < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if ((extended & 0x8000000000000000n) !== 0n || extended < 65_536n) {
          this.#closeForProtocolError();
          return;
        }
        if (extended > BigInt(MAX_FRAME_BYTES)) {
          this.#closeForProtocolError(1009);
          return;
        }
        length = Number(extended);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.#closeForProtocolError(1009);
        return;
      }
      const frameOverheadBytes = offset + 4;
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
      if (opcode === 0x9) {
        this.#queuePong(payload);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x1 || opcode === 0x0) {
        const fragmentCount = this.#fragmentedTextFrameCount + 1;
        const fragmentOverheadBytes =
          this.#fragmentedTextOverheadBytes + frameOverheadBytes;
        if (
          this.#fragmentedTextBytes + payload.length > MAX_FRAME_BYTES ||
          fragmentCount > MAX_FRAGMENT_COUNT ||
          fragmentOverheadBytes > MAX_FRAGMENT_OVERHEAD_BYTES
        ) {
          this.#closeForProtocolError(1009);
          return;
        }
        this.#fragmentedText ??= [];
        this.#fragmentedText.push(payload);
        this.#fragmentedTextBytes += payload.length;
        this.#fragmentedTextFrameCount = fragmentCount;
        this.#fragmentedTextOverheadBytes = fragmentOverheadBytes;
        if (!fin) continue;
        const text = Buffer.concat(this.#fragmentedText);
        this.#fragmentedText = undefined;
        this.#fragmentedTextBytes = 0;
        this.#fragmentedTextFrameCount = 0;
        this.#fragmentedTextOverheadBytes = 0;
        try {
          this.#handlers.message(utf8Decoder.decode(text));
        } catch {
          this.#closeForProtocolError(1007);
          return;
        }
      }
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    this.#pendingPong = undefined;
    this.#dropQueuedWrites(new Error("Connector WebSocket is closed"));
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
  #closePromise: Promise<void> | undefined;

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

  close(server: HttpsServer): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    clearInterval(this.#healthTimer);
    server.off("upgrade", this.#upgradeListener);
    const connections = [...this.#connections];
    this.#connections.clear();
    this.#closePromise = Promise.allSettled(
      connections.map((connection) => connection.closeGracefully()),
    ).then(() => undefined);
    return this.#closePromise;
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
    let pendingMessageCount = 0;
    let pendingMessageBytes = 0;
    let dispatching = false;
    let scheduledStoreOperations = 0;
    let storeOperationTail = Promise.resolve();
    let failureGeneration = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const runStoreBeforeDeadline = async <T>(
      operation: () => Promise<T>,
      deadline: number,
      canStart: () => boolean = () => true,
    ): Promise<T | typeof DEADLINE_EXCEEDED> => {
      if (scheduledStoreOperations >= MAX_SCHEDULED_STORE_OPERATIONS) {
        throw new Error("Connector store operation queue is full");
      }
      scheduledStoreOperations += 1;
      const previousOperation = storeOperationTail;
      let releaseStoreSlot!: () => void;
      const storeSlot = new Promise<void>((resolve) => {
        releaseStoreSlot = resolve;
      });
      storeOperationTail = previousOperation
        .catch(() => undefined)
        .then(() => storeSlot);
      const finishStoreOperation = (): void => {
        scheduledStoreOperations -= 1;
        releaseStoreSlot();
        if (scheduledStoreOperations === 0) {
          storeOperationTail = Promise.resolve();
        }
      };

      const acquired = await awaitBeforeDeadline(
        () => previousOperation.catch(() => undefined),
        deadline,
      );
      if (
        acquired === DEADLINE_EXCEEDED ||
        Date.now() >= deadline ||
        !canStart()
      ) {
        finishStoreOperation();
        return DEADLINE_EXCEEDED;
      }

      let operationPromise: Promise<T>;
      try {
        operationPromise = operation();
      } catch (error) {
        finishStoreOperation();
        throw error;
      }
      void operationPromise.then(finishStoreOperation, finishStoreOperation);
      return awaitBeforeDeadline(() => operationPromise, deadline);
    };
    const canContinue = (generation: number): boolean =>
      accepting &&
      generation === failureGeneration &&
      !this.#closed &&
      !connection.isClosing;
    const sendStored = async (
      connection: ServerWebSocket,
      stored: StoredServerMessage,
      retransmit = false,
      generation = failureGeneration,
      deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS,
    ): Promise<boolean> => {
      if (!canContinue(generation)) return false;
      if (!retransmit && stored.sequence <= scanAfterSequence) return true;
      if (!retransmit && stored.sequence !== scanAfterSequence + 1) {
        return false;
      }
      let message: ConnectorServerMessage | typeof DEADLINE_EXCEEDED;
      try {
        message = await runStoreBeforeDeadline(
          () =>
            this.#store.materializeServerMessage(
              stored,
              this.#requestDecryptor,
            ),
          deadline,
          () => canContinue(generation),
        );
      } catch (error) {
        if (
          error instanceof ConnectorStoreError &&
          String(error.code) === "MESSAGE_EXPIRED"
        ) {
          return false;
        }
        throw error;
      }
      if (message === DEADLINE_EXCEEDED) return false;
      if (!canContinue(generation)) return false;
      const sent = await awaitBeforeDeadline(
        () => connection.sendJson(message, deadline),
        deadline,
      );
      if (sent === DEADLINE_EXCEEDED) return false;
      if (!retransmit && canContinue(generation)) {
        scanAfterSequence = Math.max(scanAfterSequence, stored.sequence);
      }
      return true;
    };
    const pump = async (connection: ServerWebSocket): Promise<void> => {
      const generation = failureGeneration;
      if (
        !canContinue(generation) ||
        !initialized ||
        dispatching ||
        scheduledStoreOperations > 0
      ) {
        return;
      }
      dispatching = true;
      const deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS;
      try {
        if (!canContinue(generation)) return;
        const dispatched = await runStoreBeforeDeadline(
          () => this.#store.dispatchNext(identity, this.#now()),
          deadline,
          () => canContinue(generation),
        );
        if (dispatched === DEADLINE_EXCEEDED) return;
        if (!canContinue(generation)) return;
        const pending = await runStoreBeforeDeadline(
          () =>
            this.#store.pendingServerMessages(
              identity,
              scanAfterSequence,
              this.#now(),
            ),
          deadline,
          () => canContinue(generation),
        );
        if (pending === DEADLINE_EXCEEDED) return;
        for (const message of pending) {
          if (
            !(await sendStored(
              connection,
              message,
              false,
              generation,
              deadline,
            ))
          ) {
            return;
          }
        }
      } finally {
        dispatching = false;
      }
    };
    let connection: ServerWebSocket;
    const rejectPendingOverflow = (): void => {
      if (!accepting) return;
      accepting = false;
      failureGeneration += 1;
      if (timer !== undefined) clearInterval(timer);
      void connection.closeGracefully(1013).catch(() => undefined);
    };
    const closeConnection = (): void => {
      accepting = false;
      failureGeneration += 1;
      if (timer !== undefined) clearInterval(timer);
      this.#connections.delete(connection);
    };
    const failProtocol = async (code: string): Promise<void> => {
      if (!accepting) return;
      accepting = false;
      failureGeneration += 1;
      const generation = failureGeneration;
      if (timer !== undefined) clearInterval(timer);
      const deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS;
      const canContinueFailure = (): boolean =>
        generation === failureGeneration &&
        !this.#closed &&
        !connection.isClosing;
      try {
        const errorMessage = await runStoreBeforeDeadline(
          () =>
            this.#store.enqueueServer(
              identity,
              "protocol.error",
              { code, message: "Connector protocol error." },
              new Date(this.#now().getTime() + 60_000),
            ),
          deadline,
          canContinueFailure,
        );
        if (
          errorMessage !== DEADLINE_EXCEEDED &&
          errorMessage.sequence === scanAfterSequence + 1
        ) {
          const error = await runStoreBeforeDeadline(
            () =>
              this.#store.materializeServerMessage(
                errorMessage,
                this.#requestDecryptor,
              ),
            deadline,
            canContinueFailure,
          );
          if (error !== DEADLINE_EXCEEDED) {
            await awaitBeforeDeadline(
              () => connection.sendJson(error, deadline),
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
      const generation = failureGeneration;
      let message: ConnectorClientMessage;
      try {
        message = ConnectorClientMessageSchema.parse(JSON.parse(serialized));
      } catch {
        return failProtocol("INVALID_MESSAGE");
      }
      if (!initialized && message.type !== "connector.hello") {
        return failProtocol("HELLO_REQUIRED");
      }
      if (initialized && message.type === "connector.hello") {
        return failProtocol("HELLO_ALREADY_INITIALIZED");
      }
      const deadline = Date.now() + SOCKET_WRITE_TIMEOUT_MS;
      try {
        const accepted = await runStoreBeforeDeadline(
          () => this.#store.acceptClientMessage(identity, message, this.#now()),
          deadline,
          () => canContinue(generation),
        );
        if (accepted === DEADLINE_EXCEEDED) return;
        if (!canContinue(generation)) return;
        const isInitialHello =
          message.type === "connector.hello" && !initialized;
        if (isInitialHello) {
          scanAfterSequence = message.payload.last_server_sequence;
          initialized = true;
          dispatching = true;
          timer = setInterval(() => {
            void pump(connection).catch(() => {
              accepting = false;
              void connection.close().catch(() => undefined);
            });
          }, this.#dispatchIntervalMs);
          timer.unref();
        }
        try {
          for (const replay of accepted.replay) {
            if (
              !(await sendStored(
                connection,
                replay,
                false,
                generation,
                deadline,
              ))
            ) {
              return;
            }
          }
          if (isInitialHello) {
            while (true) {
              const pending = await runStoreBeforeDeadline(
                () =>
                  this.#store.pendingServerMessages(
                    identity,
                    scanAfterSequence,
                    this.#now(),
                  ),
                deadline,
                () => canContinue(generation),
              );
              if (pending === DEADLINE_EXCEEDED) return;
              if (pending.length === 0) break;
              for (const replay of pending) {
                if (
                  !(await sendStored(
                    connection,
                    replay,
                    false,
                    generation,
                    deadline,
                  ))
                ) {
                  return;
                }
              }
            }
          }
          if (accepted.response !== null) {
            if (
              !(await sendStored(
                connection,
                accepted.response,
                accepted.duplicate,
                generation,
                deadline,
              ))
            ) {
              return;
            }
          }
        } finally {
          if (isInitialHello) dispatching = false;
        }
        if (isInitialHello) {
          await pump(connection);
        }
      } catch (error) {
        const code =
          error instanceof ConnectorStoreError ? error.code : "INTERNAL";
        await failProtocol(code);
      }
    };
    connection = new ServerWebSocket(socket, head, {
      message: (value) => {
        if (!accepting || connection.isClosing || this.#closed) return;
        const messageBytes = Buffer.byteLength(value, "utf8");
        if (
          pendingMessageCount >= MAX_PENDING_MESSAGES ||
          pendingMessageBytes + messageBytes > MAX_PENDING_MESSAGE_BYTES
        ) {
          rejectPendingOverflow();
          return;
        }
        pendingMessageCount += 1;
        pendingMessageBytes += messageBytes;
        processing = processing
          .then(() => handle(value))
          .catch(() => {
            accepting = false;
            failureGeneration += 1;
            if (timer !== undefined) clearInterval(timer);
            void connection.close().catch(() => undefined);
          })
          .finally(() => {
            pendingMessageCount -= 1;
            pendingMessageBytes -= messageBytes;
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
