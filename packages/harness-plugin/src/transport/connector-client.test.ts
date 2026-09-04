import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "../../../../tests/integration/support/tls.js";
import type { PluginStore } from "../store/plugin-store.js";
import {
  SqlitePluginStore,
  StoreSequenceError,
} from "../store/plugin-store.js";
import { reconnectDelayMs } from "./backoff.js";
import {
  type ConnectorClient,
  type ConnectorClientOptions,
  createConnectorClient,
} from "./connector-client.js";
import {
  HttpsSessionTokenClient,
  type SessionTokenHttpRequest,
} from "./session-token-client.js";

const CONNECTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL_ID = "credential-fixture";
const BOOTSTRAP_CREDENTIAL = "bootstrap-credential-fixture";
const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type JsonRecord = Record<string, unknown>;

const isoAfter = (milliseconds: number): string =>
  new Date(Date.now() + milliseconds).toISOString();

const envelope = (
  type: ConnectorServerMessage["type"],
  sequence: number,
  payload: unknown,
  correlationId = randomUUID(),
  sentAt = new Date(),
): ConnectorServerMessage =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    message_id: randomUUID(),
    sequence,
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + 60_000).toISOString(),
    correlation_id: correlationId,
    type,
    payload,
  });

const readBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
};

type Fixture = {
  url: string;
  sessionUrl: string;
  server: ReturnType<typeof createHttpsServer>;
  sockets: Set<WebSocket>;
  clientMessages: JsonRecord[];
  tokenRequests: JsonRecord[];
  socketTokens: string[];
  nextServerSequence: number;
  tokenLifetimeMs: number;
  autoWelcome: boolean;
  preWelcomeClosesRemaining: number;
  sendWelcome(socket: WebSocket, hello: JsonRecord): void;
  send(socket: WebSocket, message: ConnectorServerMessage): void;
  closeSockets(): void;
  close(): Promise<void>;
};

const startFixture = async (): Promise<Fixture> => {
  const sockets = new Set<WebSocket>();
  const clientMessages: JsonRecord[] = [];
  const tokenRequests: JsonRecord[] = [];
  const socketTokens: string[] = [];
  const server = createHttpsServer(
    { cert: LOCALHOST_TLS.cert, key: LOCALHOST_TLS.key },
    async (request: IncomingMessage, response: ServerResponse) => {
      if (
        request.method !== "POST" ||
        request.url !== "/connector/v1/session"
      ) {
        response.writeHead(404).end();
        return;
      }
      const body = await readBody(request);
      tokenRequests.push(body);
      const token = `session-token-${tokenRequests.length}`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          token,
          expires_at: isoAfter(fixture.tokenLifetimeMs),
        }),
      );
    },
  );
  const webSocketServer = new WebSocketServer({
    server,
    path: "/connector/v1",
  });
  const fixture = {
    url: "",
    sessionUrl: "",
    server,
    sockets,
    clientMessages,
    tokenRequests,
    socketTokens,
    nextServerSequence: 1,
    tokenLifetimeMs: 15 * 60_000,
    autoWelcome: true,
    preWelcomeClosesRemaining: 0,
    sendWelcome(socket: WebSocket, hello: JsonRecord): void {
      const sequence = fixture.nextServerSequence++;
      fixture.send(
        socket,
        envelope(
          "connector.welcome",
          sequence,
          {
            connector_id: CONNECTOR_ID,
            server_sequence: sequence,
            replay_from:
              ((hello.payload as JsonRecord).last_server_sequence as number) +
              1,
          },
          hello.correlation_id as `${string}-${string}-${string}-${string}-${string}`,
        ),
      );
    },
    send(socket: WebSocket, message: ConnectorServerMessage): void {
      socket.send(JSON.stringify(message));
    },
    closeSockets(): void {
      for (const socket of sockets) socket.close();
    },
    close(): Promise<void> {
      for (const socket of sockets) socket.close();
      webSocketServer.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  } satisfies Fixture;

  webSocketServer.on("connection", (socket, request) => {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string") socketTokens.push(authorization);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as JsonRecord;
      clientMessages.push(message);
      if (message.type === "connector.hello") {
        if (fixture.preWelcomeClosesRemaining > 0) {
          fixture.preWelcomeClosesRemaining -= 1;
          socket.close();
        } else if (fixture.autoWelcome) {
          fixture.sendWelcome(socket, message);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  fixture.url = `wss://127.0.0.1:${address.port}/connector/v1`;
  fixture.sessionUrl = `https://127.0.0.1:${address.port}/connector/v1/session`;
  return fixture;
};

const makeStore = (): { store: SqlitePluginStore; directory: string } => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-connector-transport-"));
  return {
    directory,
    store: new SqlitePluginStore(join(directory, "state.sqlite")),
  };
};

const makeTokenClient = (
  fixture: Fixture,
  request?: SessionTokenHttpRequest,
): HttpsSessionTokenClient =>
  new HttpsSessionTokenClient({
    endpoint: fixture.sessionUrl,
    credentialId: CREDENTIAL_ID,
    request:
      request ??
      ((options, body) =>
        new Promise((resolve, reject) => {
          const requestHandle = httpsRequest(
            { ...options, ca: LOCALHOST_TLS.cert },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("end", () =>
                resolve({
                  statusCode: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          requestHandle.on("error", reject);
          requestHandle.end(body);
        })),
  });

const makeClient = (
  fixture: Fixture,
  store: PluginStore,
  options: Partial<ConnectorClientOptions> = {},
): ConnectorClient =>
  createConnectorClient({
    connectorId: CONNECTOR_ID,
    controlPlaneUrl: fixture.url as `wss://${string}`,
    store,
    sessionTokenClient: makeTokenClient(fixture),
    bootstrapCredentialProvider: async () => BOOTSTRAP_CREDENTIAL,
    webSocketFactory: (url, webSocketOptions) =>
      new WebSocket(url, { ...webSocketOptions, ca: LOCALHOST_TLS.cert }),
    reconnectDelay: () => 0,
    ...options,
  });

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture wait timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const becomesTrue = async (predicate: () => boolean): Promise<boolean> => {
  try {
    await waitFor(predicate, 500);
    return true;
  } catch {
    return false;
  }
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} => {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const jobEventPayload = (): JsonRecord => ({
  job_id: JOB_ID,
  attempt: 1,
  event_type: "progress",
  payload: { stage: "testing" },
  source: "harness",
});

describe("authenticated connector transport", () => {
  const fixtures: Fixture[] = [];
  const stores: Array<{ store: SqlitePluginStore; directory: string }> = [];

  afterEach(async () => {
    for (const item of stores.splice(0)) item.store.close();
    for (const fixture of fixtures.splice(0)) await fixture.close();
    vi.useRealTimers();
  });

  it("exchanges the bootstrap credential over HTTPS and negotiates protocol 1.0 over WSS", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const running = client.start(controller.signal);

    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    const hello = fixture.clientMessages.find(
      (message) => message.type === "connector.hello",
    );
    expect(hello).toMatchObject({
      protocol_version: "1.0",
      type: "connector.hello",
      payload: { connector_id: CONNECTOR_ID },
    });
    expect(fixture.tokenRequests).toEqual([
      {
        connector_id: CONNECTOR_ID,
        credential_id: CREDENTIAL_ID,
        credential_secret: BOOTSTRAP_CREDENTIAL,
      },
    ]);

    controller.abort();
    await running;
    expect(
      fixture.clientMessages.some(
        (message) => message.protocol_version === "2.0",
      ),
    ).toBe(false);
  });

  it("rejects publish before start without allocating an unusable sequence", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const client = makeClient(fixture, store);

    const result = await client
      .publish("job.event", jobEventPayload(), randomUUID())
      .then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : "unknown error",
      );

    expect(result).toBe("CONNECTOR_NOT_STARTED");
    expect(store.pendingEvents(0)).toHaveLength(0);
  });

  it("keeps hello, a pre-welcome publish, and the welcome ACK in client sequence order", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const running = client.start(controller.signal);

    await client.publish("job.event", jobEventPayload(), randomUUID());
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    const socket = [...fixture.sockets][0];
    const hello = fixture.clientMessages.find(
      (message) => message.type === "connector.hello",
    );
    if (socket === undefined || hello === undefined) {
      throw new Error("fixture handshake missing");
    }
    fixture.sendWelcome(socket, hello);
    await waitFor(() => fixture.clientMessages.length >= 3);
    const firstThree = fixture.clientMessages.slice(0, 3);

    controller.abort();
    await running;
    expect(firstThree.map(({ type }) => type)).toEqual([
      "connector.hello",
      "job.event",
      "ack",
    ]);
    expect(firstThree.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(firstThree[2]?.payload).toEqual({ sequence: 1 });
  });

  it("reuses the accepted hello as the replay anchor after a pre-send disconnect", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const firstController = new AbortController();
    const firstClient = makeClient(fixture, store, {
      reconnectDelay: () => 10_000,
    });
    const firstRunning = firstClient.start(firstController.signal);

    await firstClient.publish("job.event", jobEventPayload(), randomUUID());
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    const firstHello = fixture.clientMessages.find(
      (message) => message.type === "connector.hello",
    );
    const firstSocket = [...fixture.sockets][0];
    if (firstHello === undefined || firstSocket === undefined) {
      throw new Error("fixture handshake missing");
    }
    const welcome = envelope(
      "connector.welcome",
      1,
      {
        connector_id: CONNECTOR_ID,
        server_sequence: 1,
        replay_from: 1,
      },
      firstHello.correlation_id as `${string}-${string}-${string}-${string}-${string}`,
    );
    fixture.send(firstSocket, welcome);
    firstSocket.close();
    await waitFor(
      () => store.inboundMessage(welcome.message_id)?.delivered === true,
    );
    await waitFor(() => fixture.sockets.size === 0);
    firstController.abort();
    await firstRunning;
    store.close();

    const reopened = new SqlitePluginStore(join(directory, "state.sqlite"));
    stores.push({ store: reopened, directory });
    const secondController = new AbortController();
    const secondClient = makeClient(fixture, reopened);
    const secondRunning = secondClient.start(secondController.signal);
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) => message.type === "connector.hello",
        ).length === 2,
    );
    const secondHello = fixture.clientMessages.filter(
      (message) => message.type === "connector.hello",
    )[1];
    const secondSocket = [...fixture.sockets][0];
    if (secondHello === undefined || secondSocket === undefined) {
      throw new Error("fixture replay handshake missing");
    }

    expect(secondHello).toMatchObject({
      message_id: firstHello.message_id,
      sequence: firstHello.sequence,
    });
    const replayStart = fixture.clientMessages.indexOf(secondHello) + 1;
    fixture.send(secondSocket, welcome);
    await waitFor(() => fixture.clientMessages.length >= replayStart + 3);
    const replayed = fixture.clientMessages.slice(replayStart, replayStart + 3);

    secondController.abort();
    await secondRunning;
    expect(replayed.map(({ type }) => type)).toEqual([
      "job.event",
      "ack",
      "ack",
    ]);
    expect(replayed.map(({ sequence }) => sequence)).toEqual([2, 3, 4]);
  });

  it("reconnects after hello expiry with a refreshed same-sequence welcome", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    let clock = new Date();
    const controller = new AbortController();
    const client = makeClient(fixture, store, { now: () => clock });
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(({ type }) => type === "connector.hello"),
    );
    const firstHello = fixture.clientMessages.find(
      ({ type }) => type === "connector.hello",
    );
    const firstSocket = [...fixture.sockets][0];
    if (firstHello === undefined || firstSocket === undefined) {
      throw new Error("fixture handshake missing");
    }
    const welcomePayload = {
      connector_id: CONNECTOR_ID,
      server_sequence: 1,
      replay_from: 1,
    };
    const originalWelcome = envelope(
      "connector.welcome",
      1,
      welcomePayload,
      firstHello.correlation_id as `${string}-${string}-${string}-${string}-${string}`,
      clock,
    );
    fixture.send(firstSocket, originalWelcome);
    await waitFor(
      () =>
        store.inboundMessage(originalWelcome.message_id)?.delivered === true,
    );

    clock = new Date(clock.getTime() + 61_000);
    firstSocket.close();
    await waitFor(
      () =>
        fixture.clientMessages.filter(({ type }) => type === "connector.hello")
          .length === 2,
    );
    const replayedHello = fixture.clientMessages.filter(
      ({ type }) => type === "connector.hello",
    )[1];
    const secondSocket = [...fixture.sockets][0];
    if (replayedHello === undefined || secondSocket === undefined) {
      throw new Error("fixture replay handshake missing");
    }
    expect(replayedHello).toMatchObject({
      message_id: firstHello.message_id,
      sequence: firstHello.sequence,
    });
    expect(Date.parse(String(replayedHello.expires_at))).toBeLessThan(
      clock.getTime(),
    );
    const refreshedWelcome = envelope(
      "connector.welcome",
      1,
      welcomePayload,
      firstHello.correlation_id as `${string}-${string}-${string}-${string}-${string}`,
      clock,
    );
    fixture.send(secondSocket, refreshedWelcome);
    const accepted = await becomesTrue(
      () =>
        store.inboundMessage(refreshedWelcome.message_id)?.delivered === true,
    );
    const originalAfterReplacement = store.inboundMessage(
      originalWelcome.message_id,
    );

    controller.abort();
    await running;
    expect(accepted).toBe(true);
    expect(originalAfterReplacement).toBeUndefined();
  });

  it("processes a same-sequence command tombstone once and re-ACKs its duplicate", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    let handlerCalls = 0;
    client.onCommand(async () => {
      handlerCalls += 1;
    });
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    const command = envelope("job.offer", 2, {
      job_id: JOB_ID,
      attempt: 1,
      lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repository_id: "repo-one",
      request: "command replaced by tombstone",
    });
    fixture.send(socket, command);
    await waitFor(
      () => store.inboundMessage(command.message_id)?.delivered === true,
    );
    const tombstone = envelope(
      "protocol.error",
      command.sequence,
      {
        code: "MESSAGE_EXPIRED",
        message: "A Connector message expired before delivery.",
      },
      command.correlation_id,
    );
    fixture.send(socket, tombstone);
    const replacementAccepted = await becomesTrue(
      () => store.inboundMessage(tombstone.message_id)?.delivered === true,
    );
    if (replacementAccepted) fixture.send(socket, tombstone);
    const duplicateReacked = await becomesTrue(
      () =>
        fixture.clientMessages.filter(
          (message) =>
            message.type === "ack" &&
            (message.payload as JsonRecord).sequence === command.sequence,
        ).length === 3,
    );

    controller.abort();
    await running;
    expect(replacementAccepted).toBe(true);
    expect(duplicateReacked).toBe(true);
    expect(store.inboundMessage(command.message_id)).toBeUndefined();
    expect(handlerCalls).toBe(1);
  });

  it("rejects a fresh-ID rewrite of a still-valid incompatible sequence", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const running = makeClient(fixture, store, {
      reconnectDelay: () => 10_000,
    }).start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    const original = envelope("protocol.error", 2, {
      code: "ORIGINAL",
      message: "Original durable envelope.",
    });
    fixture.send(socket, original);
    await waitFor(
      () => store.inboundMessage(original.message_id)?.delivered === true,
    );
    const incompatible = envelope(
      "protocol.error",
      original.sequence,
      { code: "REWRITTEN", message: "Must fail closed." },
      original.correlation_id,
    );
    fixture.send(socket, incompatible);
    await waitFor(() => fixture.sockets.size === 0);
    const durable = store.inboundMessageBySequence(original.sequence);

    controller.abort();
    await running;
    expect(durable?.messageId).toBe(original.message_id);
    expect(store.inboundMessage(incompatible.message_id)).toBeUndefined();
  });

  it("sends a heartbeat every ten seconds", async () => {
    vi.useFakeTimers();
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const running = makeClient(fixture, store).start(controller.signal);
    await vi.waitFor(() =>
      expect(
        fixture.clientMessages.some(
          (message) =>
            message.type === "ack" &&
            (message.payload as JsonRecord).sequence === 1,
        ),
      ).toBe(true),
    );
    const heartbeatCountAfterHandshake = fixture.clientMessages.filter(
      (message) => message.type === "connector.heartbeat",
    ).length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      store
        .pendingEvents(0)
        .some(
          ({ payload }) =>
            (JSON.parse(payload) as JsonRecord).type === "connector.heartbeat",
        ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        fixture.clientMessages.filter(
          (message) => message.type === "connector.heartbeat",
        ).length,
      ).toBeGreaterThan(heartbeatCountAfterHandshake),
    );

    controller.abort();
    await running;
  });

  it("durably receives a command before ACK, suppresses duplicates, and re-ACKs them", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    let releaseHandler: (() => void) | undefined;
    let handlerCalls = 0;
    const client = makeClient(fixture, store);
    client.onCommand(async () => {
      handlerCalls += 1;
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    });
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    const command = envelope("job.offer", 2, {
      job_id: JOB_ID,
      attempt: 1,
      lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repository_id: "repo-one",
      request: "run tests",
    });
    fixture.send(socket, command);
    await waitFor(() => handlerCalls === 1);
    expect(
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === command.sequence,
      ),
    ).toBe(false);

    releaseHandler?.();
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) =>
            message.type === "ack" &&
            (message.payload as JsonRecord).sequence === command.sequence,
        ).length === 1,
    );
    fixture.send(socket, command);
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) =>
            message.type === "ack" &&
            (message.payload as JsonRecord).sequence === command.sequence,
        ).length === 2,
    );
    expect(handlerCalls).toBe(1);

    controller.abort();
    await running;
  });

  it("does not redispatch a blocked command on a replacement connection", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    let releaseHandler: (() => void) | undefined;
    let handlerCalls = 0;
    const client = makeClient(fixture, store);
    client.onCommand(async () => {
      handlerCalls += 1;
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    });
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const firstSocket = [...fixture.sockets][0];
    if (firstSocket === undefined) throw new Error("fixture socket missing");
    const command = envelope("job.offer", 2, {
      job_id: JOB_ID,
      attempt: 1,
      lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repository_id: "repo-one",
      request: "serialize handler generations",
    });
    fixture.send(firstSocket, command);
    await waitFor(() => handlerCalls === 1);

    fixture.nextServerSequence = 3;
    firstSocket.close();
    await waitFor(
      () =>
        fixture.clientMessages.filter(({ type }) => type === "connector.hello")
          .length === 2,
    );
    const concurrentRedispatch = await becomesTrue(() => handlerCalls > 1);
    releaseHandler?.();
    await waitFor(
      () => store.inboundMessage(command.message_id)?.delivered === true,
    );

    controller.abort();
    await running;
    expect(concurrentRedispatch).toBe(false);
    expect(handlerCalls).toBe(1);
  });

  it("retries a failed in-flight command only after the old generation settles", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    let releaseFailure: (() => void) | undefined;
    let handlerCalls = 0;
    const client = makeClient(fixture, store);
    client.onCommand(async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFailure = resolve;
        });
        throw new Error("old generation failed");
      }
    });
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const firstSocket = [...fixture.sockets][0];
    if (firstSocket === undefined) throw new Error("fixture socket missing");
    const command = envelope("job.offer", 2, {
      job_id: JOB_ID,
      attempt: 1,
      lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repository_id: "repo-one",
      request: "retry after old handler failure",
    });
    fixture.send(firstSocket, command);
    await waitFor(() => handlerCalls === 1);

    fixture.nextServerSequence = 3;
    firstSocket.close();
    await waitFor(
      () =>
        fixture.clientMessages.filter(({ type }) => type === "connector.hello")
          .length === 2,
    );
    const concurrentRedispatch = await becomesTrue(() => handlerCalls > 1);
    releaseFailure?.();
    await waitFor(
      () =>
        handlerCalls === 2 &&
        store.inboundMessage(command.message_id)?.delivered === true,
    );

    controller.abort();
    await running;
    expect(concurrentRedispatch).toBe(false);
    expect(handlerCalls).toBe(2);
  });

  it("enqueues a received-message ACK before putting it on the socket", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store: baseStore, directory } = makeStore();
    stores.push({ store: baseStore, directory });
    const operations: string[] = [];
    const store: PluginStore = {
      recordInbound: (...args) => {
        operations.push("recordInbound");
        return baseStore.recordInbound(...args);
      },
      maxInboundSequence: () => baseStore.maxInboundSequence(),
      maxOutboundSequence: () => baseStore.maxOutboundSequence(),
      inboundMessage: (messageId) => baseStore.inboundMessage(messageId),
      inboundMessageBySequence: (sequence) =>
        baseStore.inboundMessageBySequence(sequence),
      replaceInbound: (replacement) => baseStore.replaceInbound(replacement),
      pendingInboundMessages: () => baseStore.pendingInboundMessages(),
      markInboundDelivered: (messageId) =>
        baseStore.markInboundDelivered(messageId),
      mapJob: (input) => baseStore.mapJob(input),
      findJob: (jobId) => baseStore.findJob(jobId),
      listNonterminalJobs: () => baseStore.listNonterminalJobs(),
      enqueueEvent: (event) => {
        const message = JSON.parse(event.payload) as JsonRecord;
        operations.push(`enqueueEvent:${String(message.type)}`);
        baseStore.enqueueEvent(event);
      },
      pendingEvents: (afterSequence) => baseStore.pendingEvents(afterSequence),
      acknowledgeEvent: (messageId) => baseStore.acknowledgeEvent(messageId),
      close: () => baseStore.close(),
    };
    const controller = new AbortController();
    const running = makeClient(fixture, store).start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    expect(operations.indexOf("recordInbound")).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf("enqueueEvent:ack")).toBeGreaterThan(
      operations.indexOf("recordInbound"),
    );

    controller.abort();
    await running;
  });

  it("rejects an inbound sequence gap before it can poison durable state", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const running = makeClient(fixture, store, {
      reconnectDelay: () => 10_000,
    }).start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const socket = [...fixture.sockets][0];
    if (socket === undefined) throw new Error("fixture socket missing");
    fixture.send(
      socket,
      envelope("job.offer", 3, {
        job_id: JOB_ID,
        attempt: 1,
        lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        repository_id: "repo-one",
        request: "gap must not persist",
      }),
    );
    await waitFor(() => fixture.sockets.size === 0);
    const cursorAfterGap = store.maxInboundSequence();

    controller.abort();
    await running;
    expect(cursorAfterGap).toBe(1);
  });

  it.each(["correlation", "connector"] as const)(
    "rejects a welcome with an invalid %s before durable receipt",
    async (invalidField) => {
      const fixture = await startFixture();
      fixture.autoWelcome = false;
      fixtures.push(fixture);
      const { store, directory } = makeStore();
      stores.push({ store, directory });
      const controller = new AbortController();
      const running = makeClient(fixture, store, {
        reconnectDelay: () => 10_000,
      }).start(controller.signal);
      await waitFor(() =>
        fixture.clientMessages.some(
          (message) => message.type === "connector.hello",
        ),
      );
      const socket = [...fixture.sockets][0];
      const hello = fixture.clientMessages.find(
        (message) => message.type === "connector.hello",
      );
      if (socket === undefined || hello === undefined) {
        throw new Error("fixture handshake missing");
      }
      fixture.send(
        socket,
        envelope(
          "connector.welcome",
          1,
          {
            connector_id:
              invalidField === "connector"
                ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
                : CONNECTOR_ID,
            server_sequence: 1,
            replay_from: 1,
          },
          invalidField === "correlation"
            ? randomUUID()
            : (hello.correlation_id as `${string}-${string}-${string}-${string}-${string}`),
        ),
      );
      const rejected = await becomesTrue(() => fixture.sockets.size === 0);
      const acknowledged = fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      );
      const persistedCursor = store.maxInboundSequence();

      controller.abort();
      await running;
      expect(rejected).toBe(true);
      expect(acknowledged).toBe(false);
      expect(persistedCursor).toBe(0);
    },
  );

  it("persists outbound events before sending and replays pending events after reconnect", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );

    await client.publish(
      "job.event",
      {
        job_id: JOB_ID,
        attempt: 1,
        event_type: "progress",
        payload: { stage: "testing" },
        source: "harness",
      },
      randomUUID(),
    );
    await waitFor(() =>
      fixture.clientMessages.some((message) => message.type === "job.event"),
    );
    const original = fixture.clientMessages.find(
      (message) => message.type === "job.event",
    );
    if (original === undefined) throw new Error("outbound event missing");
    expect(
      store
        .pendingEvents(0)
        .filter(
          ({ payload }) =>
            (JSON.parse(payload) as JsonRecord).type === "job.event",
        ),
    ).toHaveLength(1);

    const firstSocket = [...fixture.sockets][0];
    if (firstSocket === undefined) throw new Error("fixture socket missing");
    firstSocket.close();
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) => message.type === "connector.hello",
        ).length >= 2,
    );
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) =>
            message.type === "job.event" &&
            message.message_id === original.message_id,
        ).length >= 2,
    );

    const replay = fixture.clientMessages.find(
      (message, index) =>
        index > fixture.clientMessages.indexOf(original) &&
        message.type === "job.event" &&
        message.message_id === original.message_id,
    );
    expect(replay).toMatchObject({
      message_id: original.message_id,
      sequence: original.sequence,
    });
    fixture.send(
      [...fixture.sockets][0] as WebSocket,
      envelope(
        "ack",
        fixture.nextServerSequence++,
        { sequence: original.sequence },
        original.correlation_id as `${string}-${string}-${string}-${string}-${string}`,
      ),
    );
    await waitFor(() =>
      store
        .pendingEvents(0)
        .every(
          ({ payload }) =>
            (JSON.parse(payload) as JsonRecord).type !== "job.event",
        ),
    );

    controller.abort();
    await running;
  });

  it("continues the client sequence after restarting with no pending event rows", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });

    const firstController = new AbortController();
    const firstRunning = makeClient(fixture, store).start(
      firstController.signal,
    );
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) => message.type === "connector.hello",
        ).length === 1,
    );
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    firstController.abort();
    await firstRunning;
    expect(store.pendingEvents(0)).toHaveLength(0);

    const secondController = new AbortController();
    const secondRunning = makeClient(fixture, store).start(
      secondController.signal,
    );
    await waitFor(
      () =>
        fixture.clientMessages.filter(
          (message) => message.type === "connector.hello",
        ).length === 2,
    );
    const hellos = fixture.clientMessages.filter(
      (message) => message.type === "connector.hello",
    );
    expect(hellos[1]?.sequence).toBeGreaterThan(hellos[0]?.sequence as number);

    secondController.abort();
    await secondRunning;
  });

  it("starts promptly at sequence 100001 after 100000 acknowledged events", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const seeded = makeStore();
    seeded.store.close();
    const databasePath = join(seeded.directory, "state.sqlite");
    const database = new Database(databasePath);
    const insert = database.prepare(
      `INSERT INTO outbound_events
        (message_id, sequence, payload_json, attempts, acknowledged_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    );
    const seedHistory = database.transaction(() => {
      for (let sequence = 1; sequence <= 100_000; sequence += 1) {
        insert.run(
          `historical-${sequence}`,
          sequence,
          "{}",
          "2026-09-05T00:00:00.000Z",
          "2026-09-05T00:00:00.000Z",
        );
      }
    });
    seedHistory();
    database.close();
    const store = new SqlitePluginStore(databasePath);
    stores.push({ store, directory: seeded.directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);

    const startedAt = performance.now();
    let running: Promise<void> | undefined;
    expect(() => {
      running = client.start(controller.signal);
    }).not.toThrow();
    const elapsedMs = performance.now() - startedAt;
    const pending = store.pendingEvents(100_000);

    controller.abort();
    if (running === undefined) throw new Error("connector did not start");
    await running;
    expect(elapsedMs).toBeLessThan(1_000);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sequence).toBe(100_001);
    expect(JSON.parse(pending[0]?.payload ?? "null")).toMatchObject({
      type: "connector.hello",
      sequence: 100_001,
    });
  });

  it("fails closed on a concurrent outbound sequence writer without probing", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store: baseStore, directory } = makeStore();
    stores.push({ store: baseStore, directory });
    let enqueueAttempts = 0;
    const store = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === "enqueueEvent") {
          return () => {
            enqueueAttempts += 1;
            if (enqueueAttempts === 1) throw new StoreSequenceError();
            throw new Error("CONNECTOR_RETRIED_SEQUENCE_ALLOCATION");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PluginStore;
    const client = makeClient(fixture, store);
    const controller = new AbortController();

    expect(() => client.start(controller.signal)).toThrow(
      "CONNECTOR_SEQUENCE_CONFLICT",
    );
    expect(enqueueAttempts).toBe(1);
  });

  it("restores hello.last_server_sequence from durable inbound state", async () => {
    const fixture = await startFixture();
    fixture.nextServerSequence = 2;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const prior = envelope("protocol.error", 1, {
      code: "PRIOR_MESSAGE",
      message: "Previously handled message.",
    });
    store.recordInbound(
      prior.message_id,
      prior.sequence,
      JSON.stringify(prior),
    );
    store.markInboundDelivered(prior.message_id);
    const controller = new AbortController();
    const running = makeClient(fixture, store).start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    const hello = fixture.clientMessages.find(
      (message) => message.type === "connector.hello",
    );

    controller.abort();
    await running;
    expect(hello?.payload).toMatchObject({ last_server_sequence: 1 });
  });

  it("reconciles an expired recovered command without dispatching or ACKing it", async () => {
    const fixture = await startFixture();
    fixture.nextServerSequence = 2;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const clock = new Date();
    const expiredCommand = envelope(
      "job.offer",
      1,
      {
        job_id: JOB_ID,
        attempt: 1,
        lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        repository_id: "repo-one",
        request: "expired recovered command",
      },
      randomUUID(),
      new Date(clock.getTime() - 120_000),
    );
    store.recordInbound(
      expiredCommand.message_id,
      expiredCommand.sequence,
      JSON.stringify(expiredCommand),
    );
    let handlerCalls = 0;
    const controller = new AbortController();
    const client = makeClient(fixture, store, { now: () => clock });
    client.onCommand(async () => {
      handlerCalls += 1;
    });
    const running = client.start(controller.signal);
    await waitFor(
      () => store.inboundMessage(expiredCommand.message_id)?.delivered === true,
    );
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 2,
      ),
    );
    const expiredAcked = fixture.clientMessages.some(
      (message) =>
        message.type === "ack" &&
        (message.payload as JsonRecord).sequence === expiredCommand.sequence,
    );

    controller.abort();
    await running;
    expect(handlerCalls).toBe(0);
    expect(expiredAcked).toBe(false);
  });

  it("retries an unfinished durable command after restart and re-ACKs only after success", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    let handlerCalls = 0;
    const firstController = new AbortController();
    const firstClient = makeClient(fixture, store, {
      reconnectDelay: () => 10_000,
    });
    firstClient.onCommand(async () => {
      handlerCalls += 1;
      throw new Error("simulated handler failure");
    });
    const firstRunning = firstClient.start(firstController.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const firstSocket = [...fixture.sockets][0];
    if (firstSocket === undefined) throw new Error("fixture socket missing");
    const command = envelope("job.offer", 2, {
      job_id: JOB_ID,
      attempt: 1,
      lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repository_id: "repo-one",
      request: "retry unfinished delivery",
    });
    fixture.nextServerSequence = 3;
    fixture.send(firstSocket, command);
    await waitFor(() => handlerCalls === 1);
    await waitFor(() => fixture.sockets.size === 0);
    firstController.abort();
    await firstRunning;
    expect(store.inboundMessage(command.message_id)?.delivered).toBe(false);
    store.close();

    const reopened = new SqlitePluginStore(join(directory, "state.sqlite"));
    stores.push({ store: reopened, directory });
    const secondController = new AbortController();
    const secondClient = makeClient(fixture, reopened);
    secondClient.onCommand(async () => {
      handlerCalls += 1;
    });
    const secondRunning = secondClient.start(secondController.signal);
    const delivered = await becomesTrue(
      () =>
        handlerCalls === 2 &&
        fixture.clientMessages.some(
          (message) =>
            message.type === "ack" &&
            (message.payload as JsonRecord).sequence === command.sequence,
        ),
    );
    let duplicateReacked = false;
    if (delivered) {
      const secondSocket = [...fixture.sockets][0];
      if (secondSocket === undefined) throw new Error("fixture socket missing");
      fixture.send(secondSocket, command);
      duplicateReacked = await becomesTrue(
        () =>
          fixture.clientMessages.filter(
            (message) =>
              message.type === "ack" &&
              (message.payload as JsonRecord).sequence === command.sequence,
          ).length === 2,
      );
    }
    const deliveryState = reopened.inboundMessage(command.message_id);

    secondController.abort();
    await secondRunning;
    expect(delivered).toBe(true);
    expect(duplicateReacked).toBe(true);
    expect(handlerCalls).toBe(2);
    expect(deliveryState?.delivered).toBe(true);
  });

  it("refreshes the session token before expiry", async () => {
    const fixture = await startFixture();
    fixture.tokenLifetimeMs = 30_000;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    vi.useFakeTimers();
    const controller = new AbortController();
    const running = makeClient(fixture, store).start(controller.signal);
    await vi.waitFor(() => expect(fixture.tokenRequests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(fixture.tokenRequests.length).toBeGreaterThanOrEqual(2),
    );
    await vi.waitFor(() => expect(fixture.socketTokens).toHaveLength(2));
    expect(fixture.socketTokens).toEqual([
      "Bearer session-token-1",
      "Bearer session-token-2",
    ]);
    expect(fixture.tokenRequests[0]?.credential_secret).toBe(
      BOOTSTRAP_CREDENTIAL,
    );
    expect(fixture.tokenRequests[1]?.credential_secret).toBe(
      BOOTSTRAP_CREDENTIAL,
    );

    controller.abort();
    await running;
  });

  it.each(["bootstrap credential", "session exchange"] as const)(
    "settles start promptly when abort interrupts a pending initial %s",
    async (boundary) => {
      const fixture = await startFixture();
      fixtures.push(fixture);
      const { store, directory } = makeStore();
      stores.push({ store, directory });
      const pending = deferred<never>();
      let entered = false;
      const controller = new AbortController();
      const client = makeClient(fixture, store, {
        bootstrapCredentialProvider:
          boundary === "bootstrap credential"
            ? () => {
                entered = true;
                return pending.promise;
              }
            : async () => BOOTSTRAP_CREDENTIAL,
        ...(boundary === "session exchange"
          ? {
              sessionTokenClient: {
                exchange: () => {
                  entered = true;
                  return pending.promise;
                },
              },
            }
          : {}),
      });
      const running = client.start(controller.signal);
      await waitFor(() => entered);

      controller.abort();
      const settledPromptly = await Promise.race([
        running.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100),
        ),
      ]);
      pending.reject(new Error("late abort test rejection"));
      await running;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settledPromptly).toBe(true);
    },
  );

  it("passes the start signal to a cancellable bootstrap provider", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    let entered = false;
    let observedSignal: AbortSignal | undefined;
    let providerAborted = false;
    const controller = new AbortController();
    const client = makeClient(fixture, store, {
      bootstrapCredentialProvider: (signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          entered = true;
          observedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new Error("bootstrap provider aborted"));
            },
            { once: true },
          );
        }),
    });
    const running = client.start(controller.signal);
    await waitFor(() => entered);

    controller.abort();
    await running;

    expect(observedSignal).toBe(controller.signal);
    expect(providerAborted).toBe(true);
    expect(fixture.tokenRequests).toHaveLength(0);
  });

  it("passes AbortSignal through the HTTPS session request", async () => {
    let entered = false;
    let observedSignal: AbortSignal | undefined;
    let requestAborted = false;
    const sessionClient = new HttpsSessionTokenClient({
      endpoint: "https://control-plane.example/connector/v1/session",
      credentialId: CREDENTIAL_ID,
      request: (_options, _body, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          entered = true;
          observedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(new Error("session request aborted"));
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const exchange = sessionClient.exchange(
      {
        connectorId: CONNECTOR_ID,
        bootstrapCredential: BOOTSTRAP_CREDENTIAL,
      },
      controller.signal,
    );
    await waitFor(() => entered);

    controller.abort();
    const settledPromptly = await Promise.race([
      exchange.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(observedSignal).toBe(controller.signal);
    expect(requestAborted).toBe(true);
    expect(settledPromptly).toBe(true);
  });

  it("cancels an in-flight refresh exchange without late state work", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    vi.useFakeTimers();
    let exchangeCalls = 0;
    let refreshSignal: AbortSignal | undefined;
    let refreshAborted = false;
    const controller = new AbortController();
    const client = makeClient(fixture, store, {
      sessionTokenClient: {
        exchange: (_input, signal?: AbortSignal) => {
          exchangeCalls += 1;
          if (exchangeCalls === 1) {
            return Promise.resolve({
              token: "short-lived-session",
              expiresAt: isoAfter(30_000),
            });
          }
          return new Promise((_resolve, reject) => {
            refreshSignal = signal;
            signal?.addEventListener(
              "abort",
              () => {
                refreshAborted = true;
                reject(new Error("refresh exchange aborted"));
              },
              { once: true },
            );
          });
        },
      },
    });
    const running = client.start(controller.signal);
    await vi.waitFor(() =>
      expect(
        fixture.clientMessages.some(({ type }) => type === "connector.hello"),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(exchangeCalls).toBe(2));

    controller.abort();
    await running;
    await vi.advanceTimersByTimeAsync(1_001);
    const timersAfterAbort = vi.getTimerCount();

    expect(refreshSignal).toBe(controller.signal);
    expect(refreshAborted).toBe(true);
    expect(exchangeCalls).toBe(2);
    expect(fixture.socketTokens).toEqual(["Bearer short-lived-session"]);
    expect(timersAfterAbort).toBe(0);
  });

  it.each(["bootstrap credential", "session exchange"] as const)(
    "abandons a pending refresh %s on abort without scheduling late work",
    async (boundary) => {
      const fixture = await startFixture();
      fixtures.push(fixture);
      const { store, directory } = makeStore();
      stores.push({ store, directory });
      vi.useFakeTimers();
      const pendingCredential = deferred<string>();
      const pendingSession = deferred<{ token: string; expiresAt: string }>();
      let credentialCalls = 0;
      let exchangeCalls = 0;
      const controller = new AbortController();
      const client = makeClient(fixture, store, {
        bootstrapCredentialProvider: () => {
          credentialCalls += 1;
          if (boundary === "bootstrap credential" && credentialCalls === 2) {
            return pendingCredential.promise;
          }
          return Promise.resolve(BOOTSTRAP_CREDENTIAL);
        },
        sessionTokenClient: {
          exchange: () => {
            exchangeCalls += 1;
            if (boundary === "session exchange" && exchangeCalls === 2) {
              return pendingSession.promise;
            }
            return Promise.resolve({
              token: "short-lived-session",
              expiresAt: isoAfter(30_000),
            });
          },
        },
      });
      const running = client.start(controller.signal);
      await vi.waitFor(() =>
        expect(
          fixture.clientMessages.some(({ type }) => type === "connector.hello"),
        ).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        if (boundary === "bootstrap credential") {
          expect(credentialCalls).toBe(2);
        } else {
          expect(exchangeCalls).toBe(2);
        }
      });

      controller.abort();
      await running;
      await vi.advanceTimersByTimeAsync(1_001);
      if (boundary === "bootstrap credential") {
        pendingCredential.resolve(BOOTSTRAP_CREDENTIAL);
      } else {
        pendingSession.resolve({
          token: "late-session",
          expiresAt: isoAfter(30_000),
        });
      }
      await Promise.resolve();
      await Promise.resolve();
      const timersAfterLateResolution = vi.getTimerCount();
      await vi.runOnlyPendingTimersAsync();

      expect(timersAfterLateResolution).toBe(0);
    },
  );

  it("uses bounded exponential reconnect backoff with twenty percent jitter", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelayMs(attempt, 0.5)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(reconnectDelayMs(0, 0)).toBe(800);
    expect(reconnectDelayMs(0, 1)).toBe(1_200);
    expect(reconnectDelayMs(5, 0)).toBe(24_000);
    expect(reconnectDelayMs(5, 1)).toBe(36_000);
  });

  it("does not reset reconnect backoff when sockets close before welcome", async () => {
    const fixture = await startFixture();
    fixture.preWelcomeClosesRemaining = 4;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const observedDelays: number[] = [];
    const controller = new AbortController();
    const running = makeClient(fixture, store, {
      reconnectDelay: (attempt) => {
        observedDelays.push(reconnectDelayMs(attempt, 0.5));
        return 0;
      },
    }).start(controller.signal);
    await waitFor(() => observedDelays.length >= 3);
    const firstThreeDelays = observedDelays.slice(0, 3);

    controller.abort();
    await running;
    expect(firstThreeDelays).toEqual([1_000, 2_000, 4_000]);
  });

  it("resets reconnect backoff after welcome even when the socket later errors", async () => {
    const fixture = await startFixture();
    fixture.preWelcomeClosesRemaining = 2;
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const observedDelays: number[] = [];
    const clientSockets: WebSocket[] = [];
    const controller = new AbortController();
    const running = makeClient(fixture, store, {
      webSocketFactory: (url, webSocketOptions) => {
        const socket = new WebSocket(url, {
          ...webSocketOptions,
          ca: LOCALHOST_TLS.cert,
        });
        clientSockets.push(socket);
        return socket;
      },
      reconnectDelay: (attempt) => {
        observedDelays.push(reconnectDelayMs(attempt, 0.5));
        return 0;
      },
    }).start(controller.signal);
    await waitFor(() => observedDelays.length === 2);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) =>
          message.type === "ack" &&
          (message.payload as JsonRecord).sequence === 1,
      ),
    );
    const welcomedSocket = clientSockets[2];
    if (welcomedSocket === undefined) {
      throw new Error("welcomed client socket missing");
    }
    welcomedSocket.emit("error", new Error("post-welcome socket failure"));
    await waitFor(() => observedDelays.length === 3);
    const firstThreeDelays = observedDelays.slice(0, 3);

    controller.abort();
    await running;
    expect(firstThreeDelays).toEqual([1_000, 2_000, 1_000]);
  });

  it("stops reconnecting and closes the socket through AbortSignal", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const { store, directory } = makeStore();
    stores.push({ store, directory });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const running = client.start(controller.signal);
    await waitFor(() =>
      fixture.clientMessages.some(
        (message) => message.type === "connector.hello",
      ),
    );
    controller.abort();
    await running;
    const helloCount = fixture.clientMessages.filter(
      (message) => message.type === "connector.hello",
    ).length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      fixture.clientMessages.filter(
        (message) => message.type === "connector.hello",
      ),
    ).toHaveLength(helloCount);
    await waitFor(() => fixture.sockets.size === 0);
  });
});
