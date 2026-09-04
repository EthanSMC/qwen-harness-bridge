import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
  SequenceCursor,
} from "@qhb/protocol";
import WebSocket, { type ClientOptions } from "ws";
import type { PluginStore } from "../store/plugin-store.js";
import {
  type StoredOutboundEvent,
  StoreSequenceError,
} from "../store/plugin-store.js";
import { reconnectDelayMs } from "./backoff.js";
import type { SessionTokenClient } from "./session-token-client.js";

export type ClientMessageType = ConnectorClientMessage["type"];
export type ServerEnvelope = ConnectorServerMessage;

export interface ConnectorClient {
  start(signal: AbortSignal): Promise<void>;
  publish(
    type: ClientMessageType,
    payload: unknown,
    correlationId: string,
  ): Promise<void>;
  onCommand(handler: (command: ServerEnvelope) => Promise<void>): () => void;
}

type SocketFactory = (url: string, options: ClientOptions) => WebSocket;

export type ConnectorClientOptions = Readonly<{
  connectorId: string;
  controlPlaneUrl: `wss://${string}`;
  store: PluginStore;
  sessionTokenClient: SessionTokenClient;
  bootstrapCredentialProvider: () => Promise<string>;
  connectorVersion?: string;
  capabilities?: readonly string[];
  now?: () => Date;
  randomUUID?: () => string;
  random?: () => number;
  webSocketFactory?: SocketFactory;
  reconnectDelay?: (attempt: number) => number;
}>;

const HEARTBEAT_INTERVAL_MS = 10_000;
const MESSAGE_TTL_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const MAX_SEQUENCE_ALLOCATION_PROBES = 100_000;

const assertWssUrl = (value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONNECTOR_WEBSOCKET_URL_INVALID");
  }
  if (
    url.protocol !== "wss:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("CONNECTOR_WEBSOCKET_TLS_REQUIRED");
  }
};

const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(fallback);

const messageEnvelope = (
  type: ClientMessageType,
  sequence: number,
  payload: unknown,
  correlationId: string,
  now: Date,
  messageId: string,
): ConnectorClientMessage =>
  ConnectorClientMessageSchema.parse({
    protocol_version: "1.0",
    message_id: messageId,
    sequence,
    sent_at: now.toISOString(),
    expires_at: new Date(now.getTime() + MESSAGE_TTL_MS).toISOString(),
    correlation_id: correlationId,
    type,
    payload,
  });

export const buildConnectorHello = (input: {
  connectorId: string;
  sequence: number;
  lastServerSequence: number;
  lastClientSequence?: number;
  correlationId: string;
  now: Date;
  messageId?: string;
  connectorVersion?: string;
  capabilities?: readonly string[];
}): ConnectorClientMessage =>
  messageEnvelope(
    "connector.hello",
    input.sequence,
    {
      connector_id: input.connectorId,
      ...(input.connectorVersion === undefined
        ? {}
        : { connector_version: input.connectorVersion }),
      ...(input.capabilities === undefined
        ? {}
        : { capabilities: [...input.capabilities] }),
      last_server_sequence: input.lastServerSequence,
      ...(input.lastClientSequence === undefined
        ? {}
        : { last_client_sequence: input.lastClientSequence }),
    },
    input.correlationId,
    input.now,
    input.messageId ?? nodeRandomUUID(),
  );

const isCommand = (
  message: ConnectorServerMessage,
): message is Extract<
  ConnectorServerMessage,
  { type: "job.offer" | "job.cancel" | "approval.decision" }
> =>
  message.type === "job.offer" ||
  message.type === "job.cancel" ||
  message.type === "approval.decision";

type PendingMessage = Readonly<{
  stored: StoredOutboundEvent;
  message: ConnectorClientMessage;
}>;

export class DurableConnectorClient implements ConnectorClient {
  readonly #options: ConnectorClientOptions;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #random: () => number;
  readonly #socketFactory: SocketFactory;
  readonly #handlers = new Set<(command: ServerEnvelope) => Promise<void>>();
  readonly #outboundBySequence = new Map<number, StoredOutboundEvent>();
  readonly #sentOnConnection = new Set<number>();
  #clientSequence = 0;
  #serverCursor = new SequenceCursor();
  #socket: WebSocket | undefined;
  #startPromise: Promise<void> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #sendPump: Promise<void> = Promise.resolve();
  #receivePump: Promise<void> = Promise.resolve();
  #welcomeWaiter: Promise<void> | undefined;
  #resolveWelcome: (() => void) | undefined;
  #helloServerSequence = 0;
  #helloMessage: PendingMessage | undefined;
  #welcomeReceived = false;
  #stopping = false;
  #nextSession: { token: string; expiresAt: string } | undefined;

  constructor(options: ConnectorClientOptions) {
    assertWssUrl(options.controlPlaneUrl);
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#random = options.random ?? Math.random;
    this.#socketFactory =
      options.webSocketFactory ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    const pending = options.store.pendingEvents(0);
    for (const event of pending) {
      this.#rememberPending(event);
      this.#clientSequence = Math.max(this.#clientSequence, event.sequence);
    }
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#stopping = signal.aborted;
    this.#startPromise = this.#run(signal);
    return this.#startPromise;
  }

  async publish(
    type: ClientMessageType,
    payload: unknown,
    correlationId: string,
  ): Promise<void> {
    if (
      type === "connector.hello" ||
      type === "connector.heartbeat" ||
      type === "ack"
    ) {
      throw new Error("CONNECTOR_PUBLISH_TYPE_NOT_DURABLE");
    }
    const messageId = this.#randomUUID();
    const now = this.#now();
    this.#persistMessage((sequence) =>
      messageEnvelope(type, sequence, payload, correlationId, now, messageId),
    );
    this.#scheduleSendPump();
  }

  onCommand(handler: (command: ServerEnvelope) => Promise<void>): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async #run(signal: AbortSignal): Promise<void> {
    const onAbort = (): void => {
      this.#stopping = true;
      this.#clearTimers();
      this.#closeSocket();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let attempt = 0;
    try {
      while (!signal.aborted) {
        try {
          await this.#connectOnce(signal);
          attempt = 0;
        } catch {
          if (signal.aborted) break;
        }
        if (signal.aborted) break;
        const delay = (
          this.#options.reconnectDelay ??
          ((index) => reconnectDelayMs(index, this.#random()))
        )(attempt);
        attempt += 1;
        await this.#sleep(delay, signal);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#clearTimers();
      this.#closeSocket();
      this.#nextSession = undefined;
      this.#stopping = true;
    }
  }

  async #connectOnce(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let session = this.#nextSession;
    if (session === undefined) {
      const bootstrapCredential =
        await this.#options.bootstrapCredentialProvider();
      if (signal.aborted) return;
      session = await this.#options.sessionTokenClient.exchange({
        connectorId: this.#options.connectorId,
        bootstrapCredential,
      });
    }
    if (signal.aborted) return;
    this.#nextSession = undefined;
    this.#scheduleTokenRefresh(session.expiresAt, signal);

    const socket = this.#socketFactory(this.#options.controlPlaneUrl, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    this.#socket = socket;
    this.#sentOnConnection.clear();
    this.#welcomeReceived = false;
    this.#welcomeWaiter = new Promise<void>((resolve) => {
      this.#resolveWelcome = resolve;
    });
    this.#receivePump = Promise.resolve();
    this.#sendPump = Promise.resolve();
    this.#helloServerSequence = this.#serverCursor.lastSequence;
    const closePromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error);
      };
      socket.once("open", () => {
        void this.#afterOpen(socket, signal).catch((error: unknown) => {
          this.#closeSocket(socket);
          finish(asError(error, "CONNECTOR_SOCKET_OPEN_FAILED"));
        });
      });
      socket.on("message", (data) => {
        const serialized = typeof data === "string" ? data : data.toString();
        this.#receivePump = this.#receivePump
          .then(() => this.#handleIncoming(socket, serialized))
          .catch(() => {
            this.#closeSocket(socket);
          });
      });
      socket.once("error", (error) =>
        finish(asError(error, "CONNECTOR_SOCKET_ERROR")),
      );
      socket.once("close", () => {
        this.#resolveWelcome?.();
        finish();
      });
    });
    try {
      await closePromise;
    } finally {
      if (this.#socket === socket) this.#socket = undefined;
      this.#welcomeWaiter = undefined;
      this.#resolveWelcome = undefined;
      this.#clearHeartbeat();
    }
  }

  async #afterOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
    const pendingHello = this.#pendingMessages().find(
      ({ message }) => message.type === "connector.hello",
    );
    const hello =
      pendingHello ??
      this.#persistMessage((sequence) =>
        buildConnectorHello({
          connectorId: this.#options.connectorId,
          sequence,
          lastServerSequence: this.#serverCursor.lastSequence,
          lastClientSequence:
            this.#clientSequence === 0 ? undefined : this.#clientSequence,
          correlationId: this.#randomUUID(),
          messageId: this.#randomUUID(),
          now: this.#now(),
          connectorVersion:
            this.#options.connectorVersion ?? "qhb-harness-plugin/1.0",
          capabilities: this.#options.capabilities ?? ["harness", "replay"],
        }),
      );
    if (hello.message.type !== "connector.hello") {
      throw new Error("CONNECTOR_HELLO_MISSING");
    }
    this.#helloMessage = hello;
    this.#helloServerSequence = hello.message.payload.last_server_sequence;
    this.#sendJson(socket, hello.message);
    this.#heartbeatTimer = setInterval(() => {
      if (
        signal.aborted ||
        this.#socket !== socket ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      void this.#sendHeartbeat(socket).catch(() => this.#closeSocket(socket));
    }, HEARTBEAT_INTERVAL_MS);
    await this.#welcomeWaiter;
    if (signal.aborted || this.#socket !== socket) return;
    await this.#sendPending(socket);
  }

  async #handleIncoming(socket: WebSocket, serialized: string): Promise<void> {
    if (this.#socket !== socket || this.#stopping) return;
    let message: ConnectorServerMessage;
    try {
      message = ConnectorServerMessageSchema.parse(JSON.parse(serialized));
      if (Date.parse(message.expires_at) <= this.#now().getTime()) {
        throw new Error("CONNECTOR_MESSAGE_EXPIRED");
      }
    } catch {
      this.#closeSocket(socket);
      return;
    }
    let receipt: "new" | "duplicate";
    try {
      receipt = this.#options.store.recordInbound(
        message.message_id,
        message.sequence,
        serialized,
      );
    } catch {
      this.#closeSocket(socket);
      return;
    }
    if (receipt === "new") {
      try {
        if (
          this.#serverCursor.lastSequence > 0 &&
          message.sequence > this.#serverCursor.lastSequence + 1
        ) {
          this.#closeSocket(socket);
          return;
        }
        if (message.sequence <= this.#serverCursor.lastSequence) {
          this.#closeSocket(socket);
          return;
        }
        this.#serverCursor.accept(message.sequence);
      } catch {
        this.#closeSocket(socket);
        return;
      }
    } else if (message.sequence > this.#serverCursor.lastSequence) {
      try {
        if (
          this.#serverCursor.lastSequence > 0 &&
          message.sequence > this.#serverCursor.lastSequence + 1
        ) {
          this.#closeSocket(socket);
          return;
        }
        this.#serverCursor.accept(message.sequence);
      } catch {
        this.#closeSocket(socket);
        return;
      }
    }

    if (message.type === "connector.welcome") {
      if (
        message.payload.connector_id !== this.#options.connectorId ||
        message.payload.server_sequence !== message.sequence ||
        message.payload.replay_from !== this.#helloServerSequence + 1
      ) {
        this.#closeSocket(socket);
        return;
      }
      this.#welcomeReceived = true;
      if (this.#helloMessage !== undefined) {
        this.#options.store.acknowledgeEvent(
          this.#helloMessage.stored.messageId,
        );
        this.#outboundBySequence.delete(this.#helloMessage.stored.sequence);
        this.#helloMessage = undefined;
      }
    }
    if (message.type === "ack") {
      this.#acknowledgeOutbound(
        message.payload.sequence,
        message.correlation_id,
      );
    }
    if (receipt === "new" && isCommand(message)) {
      for (const handler of [...this.#handlers]) await handler(message);
    }
    if (this.#socket === socket && socket.readyState === WebSocket.OPEN) {
      await this.#sendAck(socket, message.sequence);
    }
    if (message.type === "connector.welcome") this.#resolveWelcome?.();
  }

  #acknowledgeOutbound(sequence: number, correlationId: string): void {
    const stored = this.#outboundBySequence.get(sequence);
    if (stored === undefined) return;
    try {
      const message = ConnectorClientMessageSchema.parse(
        JSON.parse(stored.payload),
      );
      if (message.correlation_id !== correlationId) return;
    } catch {
      return;
    }
    this.#options.store.acknowledgeEvent(stored.messageId);
    this.#outboundBySequence.delete(sequence);
  }

  #sendAck(socket: WebSocket, sequence: number): void {
    const { message, stored } = this.#persistMessage((nextSequence) =>
      messageEnvelope(
        "ack",
        nextSequence,
        { sequence },
        this.#randomUUID(),
        this.#now(),
        this.#randomUUID(),
      ),
    );
    this.#sendJson(socket, message);
    this.#options.store.acknowledgeEvent(stored.messageId);
    this.#outboundBySequence.delete(stored.sequence);
  }

  async #sendHeartbeat(socket: WebSocket): Promise<void> {
    const { message, stored } = this.#persistMessage((nextSequence) =>
      messageEnvelope(
        "connector.heartbeat",
        nextSequence,
        {},
        this.#randomUUID(),
        this.#now(),
        this.#randomUUID(),
      ),
    );
    this.#sendJson(socket, message);
    this.#options.store.acknowledgeEvent(stored.messageId);
    this.#outboundBySequence.delete(stored.sequence);
  }

  #persistMessage(
    build: (sequence: number) => ConnectorClientMessage,
  ): PendingMessage {
    let sequence = this.#clientSequence + 1;
    for (let probe = 0; probe < MAX_SEQUENCE_ALLOCATION_PROBES; probe += 1) {
      const message = build(sequence);
      const serialized = JSON.stringify(message);
      try {
        this.#options.store.enqueueEvent({
          messageId: message.message_id,
          sequence,
          payload: serialized,
        });
        this.#clientSequence = sequence;
        const stored: StoredOutboundEvent = {
          messageId: message.message_id,
          sequence,
          payload: serialized,
          attempts: 0,
          acknowledgedAt: null,
        };
        this.#outboundBySequence.set(sequence, stored);
        return { stored, message };
      } catch (error) {
        if (!(error instanceof StoreSequenceError)) throw error;
        sequence += 1;
      }
    }
    throw new Error("CONNECTOR_SEQUENCE_EXHAUSTED");
  }

  #sendJson(socket: WebSocket, message: ConnectorClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("CONNECTOR_SOCKET_NOT_OPEN");
    socket.send(JSON.stringify(message));
  }

  #rememberPending(event: StoredOutboundEvent): void {
    try {
      const message = ConnectorClientMessageSchema.parse(
        JSON.parse(event.payload),
      );
      if (
        message.message_id !== event.messageId ||
        message.sequence !== event.sequence
      ) {
        return;
      }
      this.#outboundBySequence.set(event.sequence, event);
    } catch {
      // The store only contains locally-created payloads. Ignore an invalid
      // legacy row here; it cannot be safely sent to the control plane.
    }
  }

  #pendingMessages(): PendingMessage[] {
    return this.#options.store.pendingEvents(0).flatMap((stored) => {
      try {
        const message = ConnectorClientMessageSchema.parse(
          JSON.parse(stored.payload),
        );
        if (
          message.message_id !== stored.messageId ||
          message.sequence !== stored.sequence
        ) {
          return [];
        }
        return [{ stored, message }];
      } catch {
        return [];
      }
    });
  }

  #sendPending(socket: WebSocket): Promise<void> {
    const operation = this.#sendPump.then(async () => {
      for (const pending of this.#pendingMessages()) {
        if (this.#sentOnConnection.has(pending.stored.sequence)) continue;
        if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN)
          return;
        this.#outboundBySequence.set(pending.stored.sequence, pending.stored);
        this.#sendJson(socket, pending.message);
        this.#sentOnConnection.add(pending.stored.sequence);
        if (
          pending.message.type === "ack" ||
          pending.message.type === "connector.heartbeat"
        ) {
          this.#options.store.acknowledgeEvent(pending.stored.messageId);
          this.#outboundBySequence.delete(pending.stored.sequence);
        }
      }
    });
    this.#sendPump = operation.catch(() => undefined);
    return operation;
  }

  #scheduleSendPump(): void {
    const socket = this.#socket;
    if (socket === undefined || !this.#welcomeReceived) return;
    void this.#sendPending(socket).catch(() => this.#closeSocket(socket));
  }

  #scheduleTokenRefresh(expiresAt: string, signal: AbortSignal): void {
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    const expiry = Date.parse(expiresAt);
    const delay = Number.isFinite(expiry)
      ? Math.max(1, expiry - this.#now().getTime() - TOKEN_REFRESH_SKEW_MS)
      : 1;
    this.#refreshTimer = setTimeout(() => {
      void this.#refreshToken(signal);
    }, delay);
  }

  async #refreshToken(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#stopping) return;
    try {
      const bootstrapCredential =
        await this.#options.bootstrapCredentialProvider();
      if (signal.aborted) return;
      const session = await this.#options.sessionTokenClient.exchange({
        connectorId: this.#options.connectorId,
        bootstrapCredential,
      });
      this.#nextSession = session;
      this.#scheduleTokenRefresh(session.expiresAt, signal);
      const socket = this.#socket;
      if (
        socket !== undefined &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      )
        socket.close();
    } catch {
      this.#refreshTimer = setTimeout(
        () => void this.#refreshToken(signal),
        1_000,
      );
    }
  }

  #sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  #closeSocket(expected?: WebSocket): void {
    const socket = expected ?? this.#socket;
    if (socket === undefined) return;
    try {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
        setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, SOCKET_CLOSE_TIMEOUT_MS);
      }
    } catch {
      socket.terminate();
    }
  }
}

export const createConnectorClient = (
  options: ConnectorClientOptions,
): DurableConnectorClient => new DurableConnectorClient(options);
