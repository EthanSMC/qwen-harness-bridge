import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
  SequenceCursor,
} from "@qhb/protocol";
import WebSocket, { type ClientOptions } from "ws";
import type {
  PluginStore,
  StoredInboundMessage,
} from "../store/plugin-store.js";
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
  bootstrapCredentialProvider: (signal?: AbortSignal) => Promise<string>;
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
const DURABLE_RECEIPTS = "durable-receipts-v1";
const MAX_UNCONFIRMED_FRAMES = 32;
const MAX_UNCONFIRMED_BYTES = 128 * 1024;
const RECEIPT_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const ABORTED = Symbol("CONNECTOR_ABORTED");

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
  readonly #unconfirmed = new Map<number, number>();
  #lastReceiptProgress = 0;
  #receiptTimer: ReturnType<typeof setInterval> | undefined;
  #fatalError: Error | undefined;
  #clientSequence = 0;
  #serverCursor: SequenceCursor;
  #socket: WebSocket | undefined;
  #startPromise: Promise<void> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #sendPump: Promise<void> = Promise.resolve();
  #receivePump: Promise<void> = Promise.resolve();
  #welcomeWaiter: Promise<void> | undefined;
  #resolveWelcome: (() => void) | undefined;
  #helloMessage: PendingMessage | undefined;
  #welcomeReceived = false;
  #started = false;
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
    this.#serverCursor = new SequenceCursor(options.store.maxInboundSequence());
    this.#clientSequence = options.store.maxOutboundSequence();
    const pending = options.store.pendingEvents(0);
    for (const event of pending) {
      this.#rememberPending(event);
    }
    const anchor = options.store.activeHello();
    if (anchor !== undefined) this.#rememberPending(anchor);
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#started = true;
    this.#stopping = signal.aborted;
    if (!signal.aborted) this.#prepareHello();
    this.#startPromise = this.#run(signal);
    return this.#startPromise;
  }

  async publish(
    type: ClientMessageType,
    payload: unknown,
    correlationId: string,
  ): Promise<void> {
    if (!this.#started) throw new Error("CONNECTOR_NOT_STARTED");
    if (this.#stopping) throw new Error("CONNECTOR_STOPPED");
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
        this.#prepareHello();
        try {
          const welcomed = await this.#connectOnce(signal);
          if (welcomed) attempt = 0;
        } catch {
          if (this.#fatalError !== undefined) throw this.#fatalError;
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

  async #connectOnce(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    let session = this.#nextSession;
    if (session === undefined) {
      const bootstrapCredential = await this.#abortable(
        () => this.#options.bootstrapCredentialProvider(signal),
        signal,
      );
      if (bootstrapCredential === ABORTED || signal.aborted || this.#stopping)
        return false;
      const exchanged = await this.#abortable(
        () =>
          this.#options.sessionTokenClient.exchange(
            {
              connectorId: this.#options.connectorId,
              bootstrapCredential,
            },
            signal,
          ),
        signal,
      );
      if (exchanged === ABORTED || signal.aborted || this.#stopping)
        return false;
      session = exchanged;
    }
    if (signal.aborted) return false;
    this.#nextSession = undefined;
    this.#scheduleTokenRefresh(session.expiresAt, signal);

    const socket = this.#socketFactory(this.#options.controlPlaneUrl, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    this.#socket = socket;
    this.#sentOnConnection.clear();
    this.#unconfirmed.clear();
    this.#welcomeReceived = false;
    this.#welcomeWaiter = new Promise<void>((resolve) => {
      this.#resolveWelcome = resolve;
    });
    // Keep receive work serialized across socket generations. A handler from the
    // previous connection may still own an uncompleted durable delivery.
    this.#sendPump = Promise.resolve();
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
          .then(() => this.#handleIncoming(socket, serialized, signal))
          .catch(() => {
            this.#closeSocket(socket);
          });
      });
      socket.once("error", (error) => {
        this.#closeSocket(socket);
        finish(asError(error, "CONNECTOR_SOCKET_ERROR"));
      });
      socket.once("close", () => {
        this.#resolveWelcome?.();
        finish();
      });
    });
    try {
      await closePromise;
      if (this.#fatalError !== undefined) throw this.#fatalError;
      return this.#welcomeReceived;
    } catch (error) {
      if (this.#fatalError !== undefined) throw this.#fatalError;
      if (this.#welcomeReceived) return true;
      throw error;
    } finally {
      if (this.#socket === socket) this.#socket = undefined;
      this.#welcomeWaiter = undefined;
      this.#resolveWelcome = undefined;
      this.#clearHeartbeat();
      if (this.#receiptTimer !== undefined) clearInterval(this.#receiptTimer);
      this.#receiptTimer = undefined;
    }
  }

  async #afterOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#stopping || this.#socket !== socket) return;
    const hello = this.#helloMessage;
    if (hello === undefined) throw new Error("CONNECTOR_HELLO_MISSING");
    if (hello.message.type !== "connector.hello") {
      throw new Error("CONNECTOR_HELLO_MISSING");
    }
    this.#helloMessage = hello;
    this.#sendRenewed(socket, hello);
    this.#lastReceiptProgress = this.#now().getTime();
    this.#receiptTimer = setInterval(() => {
      if (
        (!this.#welcomeReceived || this.#unconfirmed.size > 0) &&
        this.#now().getTime() - this.#lastReceiptProgress >= RECEIPT_TIMEOUT_MS
      )
        this.#closeSocket(socket);
    }, 1_000);
    await this.#welcomeWaiter;
    if (
      signal.aborted ||
      this.#stopping ||
      this.#socket !== socket ||
      !this.#welcomeReceived
    )
      return;
    await this.#sendPending(socket);
  }

  #prepareHello(): void {
    if (this.#stopping) return;
    if (this.#helloMessage !== undefined) {
      const message = this.#helloMessage.message;
      if (
        message.type !== "connector.hello" ||
        !message.payload.capabilities?.includes(DURABLE_RECEIPTS)
      )
        throw new Error("CONNECTOR_INCOMPATIBLE_STATE");
      if (this.#options.store.provenClientSequence() !== this.#clientSequence)
        return;
    }
    const lastClientSequence = this.#clientSequence;
    this.#helloMessage = this.#persistMessage((sequence) =>
      buildConnectorHello({
        connectorId: this.#options.connectorId,
        sequence,
        lastServerSequence: this.#serverCursor.lastSequence,
        lastClientSequence:
          lastClientSequence === 0 ? undefined : lastClientSequence,
        correlationId: this.#randomUUID(),
        messageId: this.#randomUUID(),
        now: this.#now(),
        connectorVersion:
          this.#options.connectorVersion ?? "qhb-harness-plugin/1.0",
        capabilities: [
          ...new Set([
            ...(this.#options.capabilities ?? ["harness", "replay"]),
            DURABLE_RECEIPTS,
          ]),
        ],
      }),
    );
  }

  async #handleIncoming(
    socket: WebSocket,
    serialized: string,
    signal: AbortSignal,
  ): Promise<void> {
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
    if (message.type === "connector.welcome" && !this.#validWelcome(message)) {
      if (!message.payload.capabilities?.includes(DURABLE_RECEIPTS))
        this.#fatalError = new Error("CONNECTOR_INCOMPATIBLE_PEER");
      this.#closeSocket(socket);
      return;
    }
    if (message.type === "ack" && !this.#validReceipt(message)) {
      this.#closeSocket(socket);
      return;
    }

    const existing = this.#options.store.inboundMessage(message.message_id);
    if (
      existing !== undefined &&
      (existing.sequence !== message.sequence || existing.body !== serialized)
    ) {
      this.#closeSocket(socket);
      return;
    }
    const existingAtSequence =
      existing === undefined
        ? this.#options.store.inboundMessageBySequence(message.sequence)
        : existing;
    let replacement = false;
    if (
      existing === undefined &&
      existingAtSequence !== undefined &&
      this.#validReplacement(existingAtSequence, message)
    ) {
      try {
        this.#options.store.replaceInbound({
          previousMessageId: existingAtSequence.messageId,
          previousBody: existingAtSequence.body,
          messageId: message.message_id,
          sequence: message.sequence,
          body: serialized,
        });
        replacement = true;
      } catch {
        this.#closeSocket(socket);
        return;
      }
    } else if (existing === undefined && existingAtSequence !== undefined) {
      this.#closeSocket(socket);
      return;
    }
    if (
      existing === undefined &&
      !replacement &&
      message.sequence !== this.#serverCursor.lastSequence + 1
    ) {
      this.#closeSocket(socket);
      return;
    }
    if (
      message.type === "connector.welcome" &&
      this.#welcomeReceived &&
      existing === undefined &&
      !replacement
    ) {
      this.#closeSocket(socket);
      return;
    }
    if (existing === undefined && !replacement) {
      try {
        this.#options.store.recordInbound(
          message.message_id,
          message.sequence,
          serialized,
        );
        this.#serverCursor.accept(message.sequence);
      } catch {
        this.#closeSocket(socket);
        return;
      }
    }

    if (this.#stopping) return;
    if (message.type === "connector.welcome") {
      this.#welcomeReceived = true;
      const hello = this.#helloMessage?.message;
      if (hello === undefined) throw new Error("CONNECTOR_HELLO_MISSING");
      this.#acknowledgeOutbound(hello.sequence, hello.correlation_id);
      this.#startHeartbeat(socket, signal);
      // The hello remains pinned separately after its receipt retires the row
      // from the pending queue. Reconnect retains its immutable identity.
      await this.#recoverPendingInbound(socket);
      if (this.#stopping) return;
      if (existing?.delivered === true) {
        await this.#completeInbound(message, true);
      }
      if (this.#stopping) return;
      this.#resolveWelcome?.();
      return;
    }
    if (!this.#welcomeReceived) return;
    await this.#completeInbound(message, existing?.delivered ?? false);
  }

  #validReplacement(
    stored: StoredInboundMessage,
    replacement: ConnectorServerMessage,
  ): boolean {
    const previous = this.#parseStoredInbound(stored);
    if (
      previous === undefined ||
      previous.message_id === replacement.message_id ||
      previous.sequence !== replacement.sequence ||
      previous.correlation_id !== replacement.correlation_id
    ) {
      return false;
    }
    const previousExpired =
      Date.parse(previous.expires_at) <= this.#now().getTime();
    const sameSemanticEnvelope =
      previous.type === replacement.type &&
      JSON.stringify(previous.payload) === JSON.stringify(replacement.payload);
    const replacementCode =
      replacement.type === "protocol.error"
        ? replacement.payload.code
        : undefined;
    const isExpiryTombstone = replacementCode === "MESSAGE_EXPIRED";
    const isInactiveOfferTombstone =
      previous.type === "job.offer" &&
      (isExpiryTombstone || replacementCode === "JOB_CANCELLED");
    const restoresWelcome =
      previous.type === "protocol.error" &&
      previous.payload.code === "MESSAGE_EXPIRED" &&
      replacement.type === "connector.welcome" &&
      this.#validWelcome(replacement);
    const restoresAck =
      previous.type === "protocol.error" &&
      previous.payload.code === "MESSAGE_EXPIRED" &&
      replacement.type === "ack" &&
      this.#validReceipt(replacement);
    const restoresRejection =
      previous.type === "protocol.error" &&
      previous.payload.code === "MESSAGE_EXPIRED" &&
      replacement.type === "protocol.error" &&
      this.#pendingMessages().some(
        ({ message }) =>
          message.correlation_id === replacement.correlation_id &&
          ((message.type === "job.claim" &&
            replacement.payload.code === "CLAIM_REJECTED" &&
            [
              "The business deadline has expired.",
              "The offered job was cancelled before it was claimed.",
            ].includes(replacement.payload.message)) ||
            (["job.event", "approval.requested", "job.cancelled"].includes(
              message.type,
            ) &&
              replacement.payload.code === "EVENT_REJECTED" &&
              replacement.payload.message ===
                "The business deadline has expired.")),
      );
    return (
      (previousExpired &&
        ((sameSemanticEnvelope && !isCommand(replacement)) ||
          isExpiryTombstone)) ||
      isInactiveOfferTombstone ||
      restoresWelcome ||
      restoresAck ||
      restoresRejection
    );
  }

  #validWelcome(
    message: Extract<ConnectorServerMessage, { type: "connector.welcome" }>,
  ): boolean {
    const hello = this.#helloMessage?.message;
    return (
      hello?.type === "connector.hello" &&
      message.payload.capabilities?.includes(DURABLE_RECEIPTS) === true &&
      message.correlation_id === hello.correlation_id &&
      message.payload.connector_id === this.#options.connectorId &&
      message.payload.server_sequence === message.sequence &&
      message.payload.replay_from === hello.payload.last_server_sequence + 1
    );
  }

  async #recoverPendingInbound(socket: WebSocket): Promise<void> {
    if (this.#stopping) return;
    for (const stored of this.#options.store.pendingInboundMessages()) {
      if (
        this.#stopping ||
        this.#socket !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      const message = this.#parseStoredInbound(stored);
      if (message === undefined) {
        throw new Error("CONNECTOR_STORED_INBOUND_INVALID");
      }
      if (Date.parse(message.expires_at) <= this.#now().getTime()) {
        this.#options.store.markInboundExpired(message.message_id);
        continue;
      }
      await this.#completeInbound(message, false);
    }
  }

  #parseStoredInbound(
    stored: StoredInboundMessage,
  ): ConnectorServerMessage | undefined {
    try {
      const message = ConnectorServerMessageSchema.parse(
        JSON.parse(stored.body),
      );
      if (
        message.message_id !== stored.messageId ||
        message.sequence !== stored.sequence
      ) {
        return undefined;
      }
      return message;
    } catch {
      return undefined;
    }
  }

  async #completeInbound(
    message: ConnectorServerMessage,
    delivered: boolean,
  ): Promise<void> {
    if (this.#stopping) return;
    if (!delivered) {
      if (message.type === "ack") {
        this.#acknowledgeOutbound(
          message.payload.sequence,
          message.correlation_id,
        );
      }
      if (isCommand(message)) {
        if (Date.parse(message.expires_at) <= this.#now().getTime()) {
          this.#options.store.markInboundExpired(message.message_id);
          this.#enqueueAck(message.sequence);
          return;
        }
        for (const handler of [...this.#handlers]) {
          if (this.#stopping) return;
          if (Date.parse(message.expires_at) <= this.#now().getTime()) {
            this.#options.store.markInboundExpired(message.message_id);
            this.#enqueueAck(message.sequence);
            return;
          }
          await handler(message);
          // start() does not await uncooperative application handlers on abort.
          // A late completion retains the unfinished receipt for recovery and
          // must never invoke another handler or touch a possibly closed store.
          if (this.#stopping) return;
        }
      }
    }
    if (this.#stopping) return;
    if (message.type !== "ack") this.#enqueueAck(message.sequence);
    if (this.#stopping) return;
    if (!delivered) {
      // ACK persistence precedes this marker. A crash after handler success but
      // before the marker can redeliver, giving commands at-least-once rather
      // than risking silent loss. Handlers must therefore make external effects
      // idempotent using the command's product identifiers.
      this.#options.store.markInboundDelivered(message.message_id);
    }
  }

  #acknowledgeOutbound(sequence: number, correlationId: string): void {
    if (this.#stopping) return;
    this.#options.store.acknowledgeThrough(sequence, correlationId);
    if (this.#stopping) return;
    const prefix = this.#options.store.provenClientSequence();
    for (const candidate of this.#outboundBySequence.keys()) {
      if (candidate <= prefix) this.#outboundBySequence.delete(candidate);
    }
    for (const candidate of this.#unconfirmed.keys()) {
      if (candidate <= prefix) {
        this.#unconfirmed.delete(candidate);
        this.#lastReceiptProgress = this.#now().getTime();
      }
    }
    this.#scheduleSendPump();
  }

  #validReceipt(
    message: Extract<ConnectorServerMessage, { type: "ack" }>,
  ): boolean {
    if (this.#stopping) return false;
    const stored = this.#options.store.outboundEvent(message.payload.sequence);
    if (stored === undefined) return false;
    const parsed = ConnectorClientMessageSchema.safeParse(
      JSON.parse(stored.payload),
    );
    return (
      parsed.success &&
      parsed.data.sequence === stored.sequence &&
      parsed.data.message_id === stored.messageId &&
      parsed.data.correlation_id === message.correlation_id
    );
  }

  #enqueueAck(sequence: number): void {
    if (this.#stopping) return;
    if (
      this.#pendingMessages().some(
        ({ message }) =>
          message.type === "ack" && message.payload.sequence === sequence,
      )
    )
      return;
    this.#persistMessage((nextSequence) =>
      messageEnvelope(
        "ack",
        nextSequence,
        { sequence },
        this.#randomUUID(),
        this.#now(),
        this.#randomUUID(),
      ),
    );
    this.#scheduleSendPump();
  }

  #enqueueHeartbeat(): void {
    if (this.#stopping) return;
    this.#persistMessage((nextSequence) =>
      messageEnvelope(
        "connector.heartbeat",
        nextSequence,
        {},
        this.#randomUUID(),
        this.#now(),
        this.#randomUUID(),
      ),
    );
    this.#scheduleSendPump();
  }

  #persistMessage(
    build: (sequence: number) => ConnectorClientMessage,
  ): PendingMessage {
    if (this.#stopping) throw new Error("CONNECTOR_STOPPED");
    const sequence = this.#clientSequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("CONNECTOR_SEQUENCE_EXHAUSTED");
    }
    const message = build(sequence);
    const serialized = JSON.stringify(message);
    if (this.#stopping) throw new Error("CONNECTOR_STOPPED");
    try {
      this.#options.store.enqueueEvent(
        {
          messageId: message.message_id,
          sequence,
          payload: serialized,
        },
        message.type === "connector.hello",
      );
    } catch (error) {
      if (error instanceof StoreSequenceError) {
        // One client process exclusively owns a Connector store. A conflict
        // means an unsupported concurrent writer violated that invariant.
        throw new Error("CONNECTOR_SEQUENCE_CONFLICT");
      }
      throw error;
    }
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
  }

  #sendJson(socket: WebSocket, message: ConnectorClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("CONNECTOR_SOCKET_NOT_OPEN");
    socket.send(JSON.stringify(message));
  }

  #sendRenewed(socket: WebSocket, pending: PendingMessage): void {
    if (this.#stopping) return;
    const stored = this.#options.store.renewDelivery(
      pending.stored.sequence,
      new Date(this.#now().getTime() + MESSAGE_TTL_MS).toISOString(),
    );
    const message = ConnectorClientMessageSchema.parse(
      JSON.parse(stored.payload),
    );
    if (this.#unconfirmed.size === 0)
      this.#lastReceiptProgress = this.#now().getTime();
    this.#outboundBySequence.set(stored.sequence, stored);
    this.#unconfirmed.set(stored.sequence, Buffer.byteLength(stored.payload));
    this.#sentOnConnection.add(stored.sequence);
    this.#sendJson(socket, message);
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
        throw new Error("CONNECTOR_STORED_OUTBOUND_INVALID");
      }
      this.#outboundBySequence.set(event.sequence, event);
      if (message.type === "connector.hello") {
        this.#helloMessage = { stored: event, message };
      }
    } catch {
      throw new Error("CONNECTOR_STORED_OUTBOUND_INVALID");
    }
  }

  #pendingMessages(): PendingMessage[] {
    if (this.#stopping) return [];
    return this.#options.store.pendingEvents(0).flatMap((stored) => {
      try {
        const message = ConnectorClientMessageSchema.parse(
          JSON.parse(stored.payload),
        );
        if (
          message.message_id !== stored.messageId ||
          message.sequence !== stored.sequence
        ) {
          throw new Error("CONNECTOR_STORED_OUTBOUND_INVALID");
        }
        return [{ stored, message }];
      } catch {
        throw new Error("CONNECTOR_STORED_OUTBOUND_INVALID");
      }
    });
  }

  #sendPending(socket: WebSocket): Promise<void> {
    const operation = this.#sendPump.then(async () => {
      if (this.#stopping || this.#socket !== socket) return;
      for (const pending of this.#pendingMessages()) {
        if (this.#stopping) return;
        if (pending.message.type === "connector.hello") continue;
        if (this.#sentOnConnection.has(pending.stored.sequence)) continue;
        if (
          this.#unconfirmed.size >= MAX_UNCONFIRMED_FRAMES ||
          [...this.#unconfirmed.values()].reduce(
            (sum, bytes) => sum + bytes,
            0,
          ) +
            Buffer.byteLength(
              JSON.stringify({
                ...pending.message,
                expires_at: new Date(
                  this.#now().getTime() + MESSAGE_TTL_MS,
                ).toISOString(),
              }),
            ) >
            MAX_UNCONFIRMED_BYTES
        )
          return;
        if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN)
          return;
        this.#outboundBySequence.set(pending.stored.sequence, pending.stored);
        this.#sendRenewed(socket, pending);
      }
    });
    this.#sendPump = operation.catch(() => undefined);
    return operation;
  }

  #scheduleSendPump(): void {
    if (this.#stopping) return;
    const socket = this.#socket;
    if (socket === undefined || !this.#welcomeReceived) return;
    void this.#sendPending(socket).catch(() => this.#closeSocket(socket));
  }

  #startHeartbeat(socket: WebSocket, signal: AbortSignal): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (
        signal.aborted ||
        this.#socket !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        !this.#welcomeReceived
      ) {
        return;
      }
      this.#enqueueHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  #scheduleTokenRefresh(expiresAt: string, signal: AbortSignal): void {
    if (signal.aborted || this.#stopping) return;
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
      const bootstrapCredential = await this.#abortable(
        () => this.#options.bootstrapCredentialProvider(signal),
        signal,
      );
      if (bootstrapCredential === ABORTED || signal.aborted || this.#stopping)
        return;
      const session = await this.#abortable(
        () =>
          this.#options.sessionTokenClient.exchange(
            {
              connectorId: this.#options.connectorId,
              bootstrapCredential,
            },
            signal,
          ),
        signal,
      );
      if (session === ABORTED || signal.aborted || this.#stopping) return;
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
      if (!signal.aborted && !this.#stopping) {
        this.#refreshTimer = setTimeout(
          () => void this.#refreshToken(signal),
          1_000,
        );
      }
    }
  }

  #abortable<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T | typeof ABORTED> {
    if (signal.aborted || this.#stopping) {
      return Promise.resolve(ABORTED);
    }
    return new Promise<T | typeof ABORTED>((resolve, reject) => {
      let settled = false;
      const finish = (result: T | typeof ABORTED): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = (): void => finish(ABORTED);
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then<T | typeof ABORTED>(() =>
          signal.aborted || this.#stopping ? ABORTED : operation(),
        )
        .then(finish, fail);
    });
  }

  #sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
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
    if (this.#receiptTimer !== undefined) clearInterval(this.#receiptTimer);
    this.#receiptTimer = undefined;
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
