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
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "../../../../tests/integration/support/tls.js";
import type { PluginStore } from "../store/plugin-store.js";
import { SqlitePluginStore } from "../store/plugin-store.js";
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
): ConnectorServerMessage =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    message_id: randomUUID(),
    sequence,
    sent_at: new Date().toISOString(),
    expires_at: isoAfter(60_000),
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
      if (message.type === "connector.hello")
        fixture.sendWelcome(socket, message);
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
          (message) => message.type === "connector.hello",
        ),
      ).toBe(true),
    );
    const heartbeatCountAfterHandshake = fixture.clientMessages.filter(
      (message) => message.type === "connector.heartbeat",
    ).length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      fixture.clientMessages.filter(
        (message) => message.type === "connector.heartbeat",
      ).length,
    ).toBeGreaterThan(heartbeatCountAfterHandshake);

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
      mapJob: (input) => baseStore.mapJob(input),
      findJob: (jobId) => baseStore.findJob(jobId),
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
    expect(store.pendingEvents(0)).toHaveLength(1);

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
    await waitFor(() => store.pendingEvents(0).length === 0);

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

  it("uses bounded exponential reconnect backoff with twenty percent jitter", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelayMs(attempt, 0.5)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(reconnectDelayMs(0, 0)).toBe(800);
    expect(reconnectDelayMs(0, 1)).toBe(1_200);
    expect(reconnectDelayMs(5, 0)).toBe(24_000);
    expect(reconnectDelayMs(5, 1)).toBe(36_000);
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
