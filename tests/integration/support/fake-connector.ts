import { createHash, randomBytes } from "node:crypto";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { LOCALHOST_TLS } from "./tls.js";

export type ConnectorCredentials = {
  connector_id: string;
  credential_id: string;
  credential_secret: string;
  last_server_sequence?: number;
  last_client_sequence?: number;
};

export type ListeningHttpsApp = {
  server: {
    address(): string | AddressInfo | null;
  };
};

export type ConnectorEndpoint = string | ListeningHttpsApp;

export { LOCALHOST_TLS } from "./tls.js";

export type SendOverrides = Readonly<{
  message_id?: string;
  sequence?: number;
  correlation_id?: string;
  sent_at?: string;
  expires_at?: string;
}>;

export class ConnectorHttpError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`Connector HTTP request failed with status ${statusCode}`);
    this.name = "ConnectorHttpError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

type SessionResponse = {
  token: string;
  expires_at?: string;
};

const asBaseUrl = (endpoint: ConnectorEndpoint): string => {
  if (typeof endpoint === "string") {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      throw new Error("FakeConnector requires an HTTPS endpoint");
    }
    return url.origin;
  }

  const address = endpoint.server.address();
  if (address === null) {
    throw new Error("FakeConnector app is not listening");
  }
  if (typeof address === "string") {
    throw new Error("FakeConnector does not support named socket addresses");
  }
  return `https://127.0.0.1:${address.port}`;
};

const requestJson = async (
  url: URL,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const httpRequest = request(
      url,
      {
        method: "POST",
        ca: LOCALHOST_TLS.cert,
        rejectUnauthorized: true,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: responseBody,
          });
        });
      },
    );
    httpRequest.once("error", reject);
    httpRequest.end(body);
  });
};

export const exchangeConnectorSession = async (
  endpoint: ConnectorEndpoint,
  credentials: Pick<
    ConnectorCredentials,
    "connector_id" | "credential_id" | "credential_secret"
  >,
): Promise<SessionResponse> => {
  const response = await requestJson(
    new URL("/connector/v1/session", asBaseUrl(endpoint)),
    {
      connector_id: credentials.connector_id,
      credential_id: credentials.credential_id,
      credential_secret: credentials.credential_secret,
    },
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ConnectorHttpError(response.statusCode, response.body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("Connector session response was not JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.token !== "string"
  ) {
    throw new Error("Connector session response did not contain a token");
  }
  return {
    token: parsed.token,
    ...(typeof parsed.expires_at === "string"
      ? { expires_at: parsed.expires_at }
      : {}),
  };
};

type FrameHandler = (payload: string) => void;
type CloseHandler = () => void;
type ErrorHandler = (error: Error) => void;
const MAX_FRAME_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const isValidCloseStatusCode = (code: number): boolean =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);

class RawWebSocket {
  static async connect(
    baseUrl: string,
    sessionToken: string,
  ): Promise<RawWebSocket> {
    const url = new URL("/connector/v1", baseUrl);
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const httpRequest = request(url, {
        method: "GET",
        ca: LOCALHOST_TLS.cert,
        rejectUnauthorized: true,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${sessionToken}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
        },
      });
      let settled = false;
      httpRequest.once("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101) {
          socket.destroy();
          if (!settled) {
            settled = true;
            reject(
              new Error(`Connector upgrade returned ${response.statusCode}`),
            );
          }
          return;
        }
        const expectedAccept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
          .digest("base64");
        if (response.headers["sec-websocket-accept"] !== expectedAccept) {
          socket.destroy();
          if (!settled) {
            settled = true;
            reject(new Error("Connector upgrade returned an invalid accept"));
          }
          return;
        }
        if (!settled) {
          settled = true;
          resolve(new RawWebSocket(socket, head));
        }
      });
      httpRequest.once("response", (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.once("end", () => {
          if (!settled) {
            settled = true;
            reject(
              new ConnectorHttpError(response.statusCode ?? 0, responseBody),
            );
          }
        });
      });
      httpRequest.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      httpRequest.end();
    });
  }

  readonly #socket: Duplex;
  readonly #messageHandlers: FrameHandler[] = [];
  readonly #closeHandlers: CloseHandler[] = [];
  readonly #errorHandlers: ErrorHandler[] = [];
  #buffer: Buffer;
  #closed = false;
  #closeResponseSent = false;
  #closeResponseMasked = false;
  #fragmentedText: Buffer[] | undefined;
  #fragmentedTextBytes = 0;

  private constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    this.#buffer = head;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.once("close", () => this.#finishClose());
    socket.once("error", () => this.#finishClose());
    if (head.byteLength > 0) {
      this.#read(Buffer.alloc(0));
    }
  }

  onMessage(handler: FrameHandler): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.#closeHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.#errorHandlers.push(handler);
  }

  sendText(payload: string): void {
    this.#sendFrame(0x1, Buffer.from(payload, "utf8"));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#sendFrame(0x8, Buffer.alloc(0));
    await this.#waitForClose();
  }

  async destroy(): Promise<void> {
    if (this.#closed) return;
    this.#socket.destroy();
    await this.#waitForClose();
  }

  sendFrameForTest(
    opcode: number,
    payload: string,
    rsv = 0,
    fin = true,
    masked = true,
  ): void {
    this.#sendFrame(opcode, Buffer.from(payload, "utf8"), rsv, fin, masked);
  }

  waitForClose(): Promise<void> {
    return this.#waitForClose();
  }

  get closeResponseSent(): boolean {
    return this.#closeResponseSent;
  }

  get closeResponseMasked(): boolean {
    return this.#closeResponseMasked;
  }

  #waitForClose(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#closeHandlers.push(resolve));
  }

  #sendFrame(
    opcode: number,
    payload: Buffer,
    rsv = 0,
    fin = true,
    masked = true,
  ): void {
    if (this.#closed) throw new Error("Connector WebSocket is closed");
    const mask = masked ? randomBytes(4) : undefined;
    const length = payload.byteLength;
    const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
    const frame = Buffer.alloc(headerLength + (masked ? 4 : 0) + length);
    frame[0] = (fin ? 0x80 : 0) | (rsv & 0x70) | opcode;
    if (length < 126) {
      frame[1] = (masked ? 0x80 : 0) | length;
    } else if (length <= 0xffff) {
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
    this.#socket.write(frame);
  }

  #read(chunk: Buffer): void {
    if (chunk.byteLength > 0) {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      const lengthCode = second & 0x7f;
      const controlFrame = opcode >= 0x8;
      if (rsv !== 0 || masked) {
        this.#failReceive(
          new Error("FakeConnector received an invalid server frame header"),
        );
        return;
      }
      if (
        ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode) ||
        (controlFrame && (!fin || lengthCode > 125)) ||
        (opcode === 0x0 && this.#fragmentedText === undefined) ||
        (opcode === 0x1 && this.#fragmentedText !== undefined)
      ) {
        this.#failReceive(
          new Error("FakeConnector received an invalid server frame"),
        );
        return;
      }
      if (opcode === 0x2) {
        this.#failReceive(
          new Error("FakeConnector received an unsupported binary frame"),
        );
        return;
      }
      let offset = 2;
      let length: number;
      if (lengthCode < 126) {
        length = lengthCode;
      } else if (lengthCode === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = this.#buffer.readUInt16BE(2);
        if (length < 126) {
          this.#failReceive(
            new Error(
              "FakeConnector received a non-minimal server frame length",
            ),
          );
          return;
        }
        offset = 4;
      } else {
        if (this.#buffer.byteLength < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if ((extended & 0x8000000000000000n) !== 0n || extended < 65_536n) {
          this.#failReceive(
            new Error(
              "FakeConnector received a non-minimal server frame length",
            ),
          );
          return;
        }
        if (extended > BigInt(MAX_FRAME_BYTES)) {
          this.#failReceive(
            new Error("FakeConnector received an oversized server frame"),
          );
          return;
        }
        length = Number(extended);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.#failReceive(
          new Error("FakeConnector received an oversized server frame"),
        );
        return;
      }
      const frameLength = offset + length;
      if (this.#buffer.byteLength < frameLength) return;
      const payload = Buffer.from(
        this.#buffer.subarray(offset, offset + length),
      );
      this.#buffer = this.#buffer.subarray(frameLength);

      if (opcode === 0x8) {
        if (payload.length === 1) {
          this.#failReceive(
            new Error("FakeConnector received a one-byte close frame"),
          );
          return;
        }
        if (payload.length >= 2) {
          const statusCode = payload.readUInt16BE(0);
          if (!isValidCloseStatusCode(statusCode)) {
            this.#failReceive(
              new Error("FakeConnector received an invalid close status"),
            );
            return;
          }
          try {
            utf8Decoder.decode(payload.subarray(2));
          } catch {
            this.#failReceive(
              new Error("FakeConnector received an invalid close reason"),
            );
            return;
          }
        }
        try {
          this.#sendFrame(0x8, payload, 0, true, true);
          this.#closeResponseSent = true;
          this.#closeResponseMasked = true;
          this.#socket.end();
        } catch {
          this.#finishClose();
        }
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x1 || opcode === 0x0) {
        if (this.#fragmentedTextBytes + payload.length > MAX_FRAME_BYTES) {
          this.#failReceive(
            new Error("FakeConnector received an oversized server message"),
          );
          return;
        }
        this.#fragmentedText ??= [];
        this.#fragmentedText.push(payload);
        this.#fragmentedTextBytes += payload.length;
        if (!fin) continue;
        const message = Buffer.concat(this.#fragmentedText);
        this.#fragmentedText = undefined;
        this.#fragmentedTextBytes = 0;
        let serialized: string;
        try {
          serialized = utf8Decoder.decode(message);
        } catch {
          this.#failReceive(
            new Error("FakeConnector received invalid UTF-8 text"),
          );
          return;
        }
        for (const handler of this.#messageHandlers) {
          handler(serialized);
        }
      }
    }
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    for (const handler of this.#closeHandlers.splice(0)) {
      handler();
    }
  }

  #failReceive(error: Error): void {
    if (this.#closed) return;
    for (const handler of this.#errorHandlers) {
      handler(error);
    }
    this.#finishClose();
  }
}

type ServerMessageOf<T extends ConnectorServerMessage["type"]> = Extract<
  ConnectorServerMessage,
  { type: T }
>;

type MessageWaiter = {
  type: ConnectorServerMessage["type"];
  resolve(message: ConnectorServerMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class FakeConnector {
  static readonly #seenByConnector = new Map<
    string,
    Map<string, { sequence: number; serialized: string }>
  >();
  static readonly #sequenceByConnector = new Map<string, Map<number, string>>();

  static async connect(
    endpoint: ConnectorEndpoint,
    credentials: ConnectorCredentials,
  ): Promise<FakeConnector> {
    const session = await exchangeConnectorSession(endpoint, credentials);
    return FakeConnector.connectWithSessionToken(
      endpoint,
      credentials,
      session.token,
    );
  }

  static async connectWithSessionToken(
    endpoint: ConnectorEndpoint,
    credentials: ConnectorCredentials,
    sessionToken: string,
  ): Promise<FakeConnector> {
    const socket = await RawWebSocket.connect(
      asBaseUrl(endpoint),
      sessionToken,
    );
    const connector = new FakeConnector(socket, credentials);
    await connector.send("connector.hello", {
      connector_id: credentials.connector_id,
      connector_version: "fake-connector/1.0",
      capabilities: ["harness", "integration-test"],
      last_server_sequence: credentials.last_server_sequence ?? 0,
      last_client_sequence: credentials.last_client_sequence ?? 0,
    });
    await connector.next("connector.welcome");
    return connector;
  }

  static async exchangeSession(
    endpoint: ConnectorEndpoint,
    credentials: ConnectorCredentials,
  ): Promise<SessionResponse> {
    return exchangeConnectorSession(endpoint, credentials);
  }

  readonly received: ConnectorServerMessage[] = [];
  readonly wireReceived: ConnectorServerMessage[] = [];
  readonly credentials: ConnectorCredentials;
  #clientSequence: number;
  #serverSequence: number;
  #pending: ConnectorServerMessage[] = [];
  #waiters: MessageWaiter[] = [];
  #socket: RawWebSocket;
  #receiveError: Error | undefined;

  private constructor(socket: RawWebSocket, credentials: ConnectorCredentials) {
    this.#socket = socket;
    this.credentials = credentials;
    this.#clientSequence = credentials.last_client_sequence ?? 0;
    this.#serverSequence = credentials.last_server_sequence ?? 0;
    socket.onMessage((serialized) => this.#receive(serialized));
    socket.onError((error) => this.#failReceive(error));
    socket.onClose(() => {
      const error =
        this.#receiveError ?? new Error("FakeConnector WebSocket closed");
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  get lastClientSequence(): number {
    return this.#clientSequence;
  }

  get lastServerSequence(): number {
    return this.#serverSequence;
  }

  get closeResponseSent(): boolean {
    return this.#socket.closeResponseSent;
  }

  get closeResponseMasked(): boolean {
    return this.#socket.closeResponseMasked;
  }

  async send(
    type: ConnectorClientMessage["type"],
    payload: unknown,
    overrides: SendOverrides = {},
  ): Promise<ConnectorClientMessage> {
    const now = new Date();
    const sequence = overrides.sequence ?? this.#clientSequence + 1;
    const message = ConnectorClientMessageSchema.parse({
      protocol_version: "1.0",
      message_id: overrides.message_id ?? crypto.randomUUID(),
      sequence,
      sent_at: overrides.sent_at ?? now.toISOString(),
      expires_at:
        overrides.expires_at ?? new Date(now.getTime() + 60_000).toISOString(),
      correlation_id: overrides.correlation_id ?? crypto.randomUUID(),
      type,
      payload,
    });
    this.#clientSequence = Math.max(this.#clientSequence, message.sequence);
    this.credentials.last_client_sequence = this.#clientSequence;
    this.#socket.sendText(JSON.stringify(message));
    return message;
  }

  async ack(message: ConnectorServerMessage): Promise<ConnectorClientMessage> {
    return this.send("ack", { sequence: message.sequence });
  }

  async next<T extends ConnectorServerMessage["type"]>(
    type: T,
    timeoutMs = 2_000,
  ): Promise<ServerMessageOf<T>> {
    if (this.#receiveError !== undefined) {
      return Promise.reject(this.#receiveError);
    }
    const pendingIndex = this.#pending.findIndex(
      (message) => message.type === type,
    );
    if (pendingIndex >= 0) {
      const [message] = this.#pending.splice(pendingIndex, 1);
      return message as ServerMessageOf<T>;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for Connector message ${type}`));
      }, timeoutMs);
      const waiter: MessageWaiter = {
        type,
        resolve: (message) => resolve(message as ServerMessageOf<T>),
        reject,
        timer,
      };
      this.#waiters.push(waiter);
    });
  }

  async disconnectWithoutAck(): Promise<void> {
    await this.#socket.destroy();
  }

  async close(): Promise<void> {
    await this.#socket.close();
  }

  async sendFrameForTest(
    opcode: number,
    payload: string,
    rsv = 0,
  ): Promise<void> {
    this.#socket.sendFrameForTest(opcode, payload, rsv);
  }

  async waitForClose(): Promise<void> {
    await this.#socket.waitForClose();
  }

  #receive(serialized: string): void {
    let parsed: ConnectorServerMessage;
    try {
      parsed = ConnectorServerMessageSchema.parse(JSON.parse(serialized));
    } catch {
      const error = new Error(
        "FakeConnector received an invalid server message",
      );
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.#receiveError = error;
      void this.#socket.destroy();
      return;
    }
    this.wireReceived.push(parsed);
    const connectorId = this.credentials.connector_id;
    const seen =
      FakeConnector.#seenByConnector.get(connectorId) ??
      new Map<string, { sequence: number; serialized: string }>();
    FakeConnector.#seenByConnector.set(this.credentials.connector_id, seen);
    const serializedMessage = canonicalJson(parsed);
    const previous = seen.get(parsed.message_id);
    if (previous !== undefined) {
      if (
        previous.sequence !== parsed.sequence ||
        previous.serialized !== serializedMessage
      ) {
        this.#failReceive(
          new Error("FakeConnector received a mismatched server replay"),
        );
        return;
      }
      if (parsed.sequence > this.#serverSequence + 1) {
        this.#failReceive(
          new Error(
            `FakeConnector expected server sequence ${this.#serverSequence + 1} but received replay ${parsed.sequence}`,
          ),
        );
        return;
      }
      if (parsed.sequence === this.#serverSequence + 1) {
        this.#serverSequence = parsed.sequence;
        this.credentials.last_server_sequence = this.#serverSequence;
      }
      return;
    }
    const bySequence =
      FakeConnector.#sequenceByConnector.get(connectorId) ??
      new Map<number, string>();
    FakeConnector.#sequenceByConnector.set(connectorId, bySequence);
    const previousMessageId = bySequence.get(parsed.sequence);
    if (previousMessageId !== undefined) {
      this.#failReceive(
        new Error("FakeConnector received a different message for a sequence"),
      );
      return;
    }
    if (parsed.sequence !== this.#serverSequence + 1) {
      this.#failReceive(
        new Error(
          `FakeConnector expected server sequence ${this.#serverSequence + 1} but received ${parsed.sequence}`,
        ),
      );
      return;
    }
    seen.set(parsed.message_id, {
      sequence: parsed.sequence,
      serialized: serializedMessage,
    });
    bySequence.set(parsed.sequence, parsed.message_id);
    this.received.push(parsed);
    this.#serverSequence = parsed.sequence;
    this.credentials.last_server_sequence = this.#serverSequence;
    const waiterIndex = this.#waiters.findIndex(
      (waiter) => waiter.type === parsed.type,
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.#waiters.splice(waiterIndex, 1);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      }
      return;
    }
    this.#pending.push(parsed);
  }

  #failReceive(error: Error): void {
    if (this.#receiveError !== undefined) return;
    this.#receiveError = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    void this.#socket.destroy();
  }
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));
