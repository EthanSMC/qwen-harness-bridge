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
  ConnectorClientMessageSchema,
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
  buildConnectorHello,
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

const required = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null)
    throw new Error("fixture value missing");
  return value;
};

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
    payload:
      type === "connector.welcome"
        ? { capabilities: ["durable-receipts-v1"], ...(payload as JsonRecord) }
        : payload,
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
  capabilities: string[];
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
    capabilities: ["durable-receipts-v1"],
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
            capabilities: fixture.capabilities,
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
  options: Partial<Omit<ConnectorClientOptions, "store">> = {},
) => {
  const input = {
    connectorId: CONNECTOR_ID,
    controlPlaneUrl: fixture.url as `wss://${string}`,
    store,
    sessionTokenClient: makeTokenClient(fixture),
    bootstrapCredentialProvider: async () => BOOTSTRAP_CREDENTIAL,
    webSocketFactory: (
      url: string,
      webSocketOptions: import("ws").ClientOptions,
    ) => new WebSocket(url, { ...webSocketOptions, ca: LOCALHOST_TLS.cert }),
    reconnectDelay: () => 0,
    ...options,
  };
  if (input.requireJobCoordination === true) {
    if (!(input.store instanceof SqlitePluginStore))
      throw new Error("fixture coordinating store required");
    return createConnectorClient({
      ...input,
      requireJobCoordination: true,
      store: input.store,
    });
  }
  return createConnectorClient({ ...input, requireJobCoordination: false });
};

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

const stateFor = (
  request: Extract<
    import("@qhb/protocol").ConnectorClientMessage,
    { type: "job.sync" }
  >,
  sequence: number,
) => {
  const observed = Date.now();
  return envelope(
    "job.state",
    sequence,
    {
      job_id: request.payload.job_id,
      repository_id: "repo-one",
      mode: "normal",
      requested_attempt: request.payload.attempt,
      current_attempt: 1,
      status: "running",
      job_revision: 2,
      cancel_revision: null,
      lease_id: null,
      lease_expires_at: null,
      expires_at: isoAfter(60_000),
      observed_at: new Date(observed).toISOString(),
      state_valid_until: new Date(observed + 2_000).toISOString(),
      request_message_id: request.message_id,
      request_sequence: request.sequence,
      nonce: request.payload.nonce,
    },
    request.correlation_id,
  );
};

describe("negotiated transport epochs", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const rig = async (
    options: Partial<ConnectorClientOptions> = {},
    autoWelcome = true,
  ) => {
    const fixture = await startFixture();
    fixture.capabilities.push("job-coordination-v1");
    fixture.autoWelcome = autoWelcome;
    const { store, directory } = makeStore();
    const controller = new AbortController();
    const sockets: WebSocket[] = [];
    const client = makeClient(fixture, store, {
      requireJobCoordination: true,
      webSocketFactory: (url, config) => {
        const socket = new WebSocket(url, {
          ...config,
          ca: LOCALHOST_TLS.cert,
        });
        sockets.push(socket);
        return socket;
      },
      ...options,
    });
    const outcome = client
      .start(controller.signal)
      .catch((error: Error) => error.message);
    cleanup.push(async () => {
      controller.abort();
      await outcome;
      store.close();
      await fixture.close();
    });
    if (autoWelcome) await waitFor(() => client.currentEpoch() !== undefined);
    else await waitFor(() => fixture.clientMessages.length > 0);
    return { fixture, store, directory, controller, sockets, client, outcome };
  };

  const snapshot = (directory: string) => {
    const database = new Database(join(directory, "state.sqlite"));
    try {
      return {
        inbound: database
          .prepare("SELECT * FROM inbound_messages ORDER BY sequence")
          .all(),
        outbound: database
          .prepare("SELECT * FROM outbound_events ORDER BY sequence")
          .all(),
        metadata: database.prepare("SELECT * FROM metadata ORDER BY key").all(),
      };
    } finally {
      database.close();
    }
  };
  const syncRequest = (r: Awaited<ReturnType<typeof rig>>) => {
    r.client.publishSync(
      { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
      randomUUID(),
      () => undefined,
    );
    const sync = ConnectorClientMessageSchema.parse(
      JSON.parse(
        required(r.store.outboundEvent(r.store.maxOutboundSequence())).payload,
      ),
    );
    if (sync.type !== "job.sync") throw new Error("fixture sync missing");
    return sync;
  };

  it("revalidates raw immutable disposition evidence before SQLite recovery bookkeeping", async () => {
    const r = await rig();
    const sync = syncRequest(r);
    const rejection = envelope(
      "protocol.error",
      r.fixture.nextServerSequence++,
      {
        code: "JOB_AUTHORITY_UNAVAILABLE",
        message: "The job authority is unavailable.",
      },
      sync.correlation_id,
    );
    r.store.recordInbound(
      rejection.message_id,
      rejection.sequence,
      JSON.stringify(rejection),
      { coordinationRequestSequence: sync.sequence },
    );
    const database = new Database(join(r.directory, "state.sqlite"));
    database
      .prepare("UPDATE inbound_messages SET body = ? WHERE message_id = ?")
      .run(
        JSON.stringify({
          ...rejection,
          payload: {
            code: " JOB_AUTHORITY_UNAVAILABLE ",
            message: "The job authority is unavailable.",
          },
        }),
        rejection.message_id,
      );
    database.close();
    // Force restart semantics on the same SQLite database, including its cursor.
    r.controller.abort();
    await r.outcome;
    const controller = new AbortController();
    const client = makeClient(r.fixture, r.store, {
      requireJobCoordination: true,
    });
    const outcome = client
      .start(controller.signal)
      .catch((error: Error) => error.message);
    let stopped = false;
    void outcome.then(() => {
      stopped = true;
    });
    try {
      await waitFor(
        () =>
          r.fixture.clientMessages.filter((m) => m.type === "connector.hello")
            .length === 2,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await waitFor(
        () =>
          r.store.inboundMessage(rejection.message_id)?.delivered === true ||
          stopped,
      );
      expect(r.store.inboundMessage(rejection.message_id)?.delivered).toBe(
        false,
      );
      expect(await outcome).toBe("CONNECTOR_STORED_INBOUND_INVALID");
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it("notifies eligibility once per socket despite duplicate welcome receipts", async () => {
    const r = await rig();
    let calls = 0;
    r.client.onEpoch(() => {
      calls++;
    });
    expect(calls).toBe(1);
    const welcome = required(r.store.inboundMessageBySequence(1));
    required(r.sockets[0]).emit("message", Buffer.from(welcome.body));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
  });

  it.each(["heartbeat", "renewal"] as const)(
    "contains asynchronous %s storage failure and revokes its epoch",
    async (fault) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const r = await rig();
      const epoch = required(r.client.currentEpoch());
      if (fault === "renewal") {
        vi.spyOn(r.store, "renewDelivery").mockImplementation(() => {
          throw new Error("private database detail");
        });
        syncRequest(r);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        vi.spyOn(r.store, "enqueueEvent").mockImplementation(() => {
          throw new Error("private database detail");
        });
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(epoch.signal.aborted).toBe(true);
      r.controller.abort();
      expect(await r.outcome).toBe("STORE_OUTBOUND_WRITE_FAILED");
    },
  );

  it.each(["protocol", "storage"] as const)(
    "makes coordinated %s intake failure fatal before cleanup",
    async (fault) => {
      const r = await rig({ reconnectDelay: () => 10_000 });
      const sync = syncRequest(r);
      await waitFor(() =>
        r.fixture.clientMessages.some((m) => m.type === "job.sync"),
      );
      const epoch = required(r.client.currentEpoch());
      const database = new Database(join(r.directory, "state.sqlite"));
      if (fault === "storage")
        database.exec(
          "CREATE TRIGGER reject_state BEFORE INSERT ON inbound_messages WHEN json_extract(NEW.body, '$.type') = 'job.state' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
        );
      const before = snapshot(r.directory);
      try {
        const peer = required([...r.fixture.sockets][0]);
        if (fault === "protocol") peer.send("not json");
        else
          r.fixture.send(peer, stateFor(sync, r.fixture.nextServerSequence++));
        await waitFor(() => epoch.signal.aborted);
        r.controller.abort();
        expect(await r.outcome).toBe(
          fault === "storage"
            ? "STORE_INBOUND_WRITE_FAILED"
            : "CONNECTOR_STORED_INBOUND_INVALID",
        );
        expect(snapshot(r.directory)).toEqual(before);
      } finally {
        if (fault === "storage") database.exec("DROP TRIGGER reject_state");
        database.close();
      }
    },
  );

  it.each(["refresh", "receipt timeout"] as const)(
    "aborts before deliberate %s calls socket.close",
    async (path) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      let now = Date.now();
      const r = await rig({
        now: () => new Date(now),
        sessionTokenClient: {
          exchange: async () => ({
            token: "fixture-session",
            expiresAt: new Date(
              now + (path === "refresh" ? 61_000 : 900_000),
            ).toISOString(),
          }),
        },
      });
      const epoch = required(r.client.currentEpoch());
      const socket = required(r.sockets[0]);
      const close = socket.close.bind(socket);
      let revokedBeforeClose = false;
      vi.spyOn(socket, "close").mockImplementation((...args) => {
        revokedBeforeClose = epoch.signal.aborted;
        return close(...args);
      });
      if (path === "receipt timeout") now += 30_001;
      await vi.advanceTimersByTimeAsync(1_000);
      await waitFor(() => epoch.signal.aborted);
      expect(revokedBeforeClose).toBe(true);
      r.controller.abort();
      await r.outcome;
    },
  );

  it("retains previously allocated legacy profiles under an effective pinned coordination hello", async () => {
    const fixture = await startFixture();
    fixture.capabilities.push("job-coordination-v1");
    const { store } = makeStore();
    const hello = buildConnectorHello({
      connectorId: CONNECTOR_ID,
      sequence: 1,
      lastServerSequence: 0,
      correlationId: randomUUID(),
      now: new Date(),
      capabilities: ["durable-receipts-v1", "job-coordination-v1"],
    });
    store.enqueueEvent(
      {
        messageId: hello.message_id,
        sequence: 1,
        payload: JSON.stringify(hello),
      },
      true,
    );
    const old = {
      ...hello,
      type: "job.event",
      sequence: 2,
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      payload: jobEventPayload(),
    };
    store.enqueueEvent({
      messageId: old.message_id,
      sequence: 2,
      payload: JSON.stringify(old),
    });
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const outcome = client.start(controller.signal);
    try {
      await waitFor(() => client.currentEpoch() !== undefined);
      await client.publish("job.event", jobEventPayload(), randomUUID());
      const newest = store.maxOutboundSequence();
      expect(store.outboundEvent(newest)?.expectedReceiptProfile).toBe(
        "job-coordination-v1",
      );
      await waitFor(() =>
        fixture.clientMessages.some((m) => m.message_id === old.message_id),
      );
      expect(store.outboundEvent(2)).not.toHaveProperty(
        "expectedReceiptProfile",
      );
    } finally {
      controller.abort();
      await outcome;
      store.close();
      await fixture.close();
    }
  });

  it("rejects ambiguous repeated business correlations without touching receipt state", async () => {
    const r = await rig({ reconnectDelay: () => 10_000 });
    const correlation = randomUUID();
    await r.client.publish("job.event", jobEventPayload(), correlation);
    await r.client.publish("job.event", jobEventPayload(), correlation);
    await waitFor(
      () =>
        r.fixture.clientMessages.filter((m) => m.type === "job.event")
          .length === 2,
    );
    const before = snapshot(r.directory);
    const epoch = required(r.client.currentEpoch());
    r.fixture.send(
      required([...r.fixture.sockets][0]),
      envelope(
        "protocol.error",
        r.fixture.nextServerSequence++,
        {
          code: "EVENT_REJECTED",
          message: "The job authority has changed.",
        },
        correlation,
      ),
    );
    await waitFor(() => epoch.signal.aborted);
    expect(snapshot(r.directory)).toEqual(before);
  });

  it("does not relabel a queued old socket state after reconnect", async () => {
    const r = await rig();
    const held = deferred<void>();
    let entered = false;
    const off = r.client.onCommand(async () => {
      entered = true;
      await held.promise;
    });
    const command = envelope("job.cancel", r.fixture.nextServerSequence++, {
      job_id: JOB_ID,
      attempt: 1,
      job_revision: 2,
      nonce: randomUUID(),
      reason: "owner_request",
    });
    const peer = required([...r.fixture.sockets][0]);
    r.fixture.send(peer, command);
    await waitFor(() => entered);
    const sync = syncRequest(r);
    const state = stateFor(sync, r.fixture.nextServerSequence++);
    const socket = required(r.sockets[0]);
    // Enqueue through the actual listener while its preceding handler is held.
    socket.emit("message", Buffer.from(JSON.stringify(state)));
    const old = required(r.client.currentEpoch());
    socket.terminate();
    await waitFor(() => r.sockets.length === 2);
    expect(old.signal.aborted).toBe(true);
    // The unsaved old frame cannot advance the durable server cursor.
    r.fixture.nextServerSequence = state.sequence;
    off();
    held.resolve();
    await waitFor(() => r.client.currentEpoch() !== undefined);
    expect(r.store.inboundMessage(state.message_id)).toBeUndefined();
    expect(r.client.currentEpoch()).not.toBe(old);
  });

  it.each([
    "nonce",
    "attempt",
    "correlation",
    "identity",
    "profile",
    "missing",
  ] as const)(
    "rejects state with wrong retained %s before any SQLite effect",
    async (fault) => {
      const r = await rig({ reconnectDelay: () => 10_000 });
      const sync = syncRequest(r);
      await waitFor(() =>
        r.fixture.clientMessages.some((m) => m.type === "job.sync"),
      );
      const state = stateFor(sync, r.fixture.nextServerSequence++);
      if (state.type !== "job.state") throw new Error("fixture state missing");
      if (fault === "nonce") state.payload.nonce = randomUUID();
      if (fault === "attempt") state.payload.requested_attempt = 2;
      if (fault === "correlation") state.correlation_id = randomUUID();
      if (fault === "identity") state.payload.request_message_id = randomUUID();
      if (fault === "missing") state.payload.request_sequence = 99;
      if (fault === "profile") {
        const database = new Database(join(r.directory, "state.sqlite"));
        database
          .prepare("DELETE FROM metadata WHERE key = ?")
          .run(`outbound-receipt-profile:${sync.sequence}`);
        database.close();
      }
      let calls = 0;
      r.client.onState(() => {
        calls++;
      });
      const before = snapshot(r.directory);
      const epoch = required(r.client.currentEpoch());
      r.fixture.send(required([...r.fixture.sockets][0]), state);
      await waitFor(() => epoch.signal.aborted);
      expect(snapshot(r.directory)).toEqual(before);
      expect(calls).toBe(0);
    },
  );

  it.each(["code", "message"] as const)(
    "preserves raw %s and rejects padded disposition and tombstone wire evidence",
    async (field) => {
      for (const tombstone of [false, true]) {
        let now = Date.now();
        const r = await rig({
          now: () => new Date(now),
          reconnectDelay: () => 10_000,
        });
        const sync = syncRequest(r);
        await waitFor(() =>
          r.fixture.clientMessages.some((m) => m.type === "job.sync"),
        );
        const original = envelope(
          "protocol.error",
          r.fixture.nextServerSequence++,
          {
            code: "JOB_AUTHORITY_UNAVAILABLE",
            message: "The job authority is unavailable.",
          },
          sync.correlation_id,
        );
        const peer = required([...r.fixture.sockets][0]);
        if (tombstone) {
          // Formatting and intentional UUID normalization must retain exact bytes.
          const raw = JSON.stringify(
            {
              ...original,
              correlation_id: original.correlation_id.toUpperCase(),
            },
            null,
            2,
          );
          peer.send(raw);
          await waitFor(
            () =>
              r.store.inboundMessage(original.message_id)?.delivered === true,
          );
          expect(r.store.inboundMessage(original.message_id)?.body).toBe(raw);
          now += 61_000;
        }
        const bad = {
          ...original,
          message_id: randomUUID(),
          sent_at: new Date(now).toISOString(),
          expires_at: new Date(now + 60_000).toISOString(),
          payload: tombstone
            ? {
                code: "MESSAGE_EXPIRED",
                message: "A Connector message expired before delivery.",
              }
            : { ...original.payload },
        };
        if (bad.type !== "protocol.error" || !(field in bad.payload))
          throw new Error("fixture error missing");
        const payload = bad.payload as { code: string; message: string };
        payload[field] = ` ${payload[field]} `;
        const before = snapshot(r.directory);
        const epoch = required(r.client.currentEpoch());
        peer.send(JSON.stringify(bad));
        await waitFor(() => epoch.signal.aborted);
        expect(snapshot(r.directory)).toEqual(before);
        expect(r.store.outboundEvent(sync.sequence)?.acknowledgedAt).toBeNull();
      }
    },
  );

  it.each(["code", "message"] as const)(
    "refuses restoration from a padded first tombstone %s over TLS",
    async (field) => {
      const r = await rig({ reconnectDelay: () => 10_000 });
      const sync = syncRequest(r);
      await waitFor(() =>
        r.fixture.clientMessages.some((m) => m.type === "job.sync"),
      );
      const original = stateFor(sync, r.fixture.nextServerSequence++);
      const tombstone = {
        ...original,
        type: "protocol.error",
        payload: {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
      };
      tombstone.payload[field] = ` ${tombstone.payload[field]} `;
      const peer = required([...r.fixture.sockets][0]);
      peer.send(JSON.stringify(tombstone));
      await waitFor(
        () => r.store.inboundMessage(tombstone.message_id)?.delivered === true,
      );
      expect(r.store.coordinationReceipt(original.sequence)).toBeUndefined();
      const before = snapshot(r.directory);
      const epoch = required(r.client.currentEpoch());
      peer.send(JSON.stringify({ ...original, message_id: randomUUID() }));
      await waitFor(() => epoch.signal.aborted);
      expect(snapshot(r.directory)).toEqual(before);
    },
  );

  it.each(["observation", "revision", "unknown"] as const)(
    "rejects %s replacement of retained state without changing immutable evidence",
    async (fault) => {
      let now = Date.now();
      const r = await rig({
        now: () => new Date(now),
        reconnectDelay: () => 10_000,
      });
      const sync = syncRequest(r);
      const state = stateFor(sync, r.fixture.nextServerSequence++);
      const peer = required([...r.fixture.sockets][0]);
      r.fixture.send(peer, state);
      await waitFor(
        () => r.store.inboundMessage(state.message_id)?.delivered === true,
      );
      now += 61_000;
      const tombstone = envelope(
        "protocol.error",
        state.sequence,
        {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
        sync.correlation_id,
        new Date(now),
      );
      r.fixture.send(peer, tombstone);
      await waitFor(
        () => r.store.inboundMessage(tombstone.message_id)?.delivered === true,
      );
      if (state.type !== "job.state") throw new Error("fixture state missing");
      const replacement = {
        ...state,
        message_id: randomUUID(),
        sent_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        payload: { ...state.payload },
      };
      if (fault === "revision") replacement.payload.job_revision++;
      if (fault === "observation") {
        replacement.payload.observed_at = new Date(now).toISOString();
        replacement.payload.state_valid_until = new Date(
          now + 2_000,
        ).toISOString();
      }
      const candidate =
        fault === "unknown"
          ? {
              ...replacement,
              type: "protocol.error",
              payload: { code: "UNKNOWN", message: "Unknown response." },
            }
          : replacement;
      const before = snapshot(r.directory);
      const epoch = required(r.client.currentEpoch());
      peer.send(JSON.stringify(candidate));
      await waitFor(() => epoch.signal.aborted);
      expect(snapshot(r.directory)).toEqual(before);
    },
  );

  it("restores immutable acknowledged state through expiry tombstones without another callback", async () => {
    let now = Date.now();
    const r = await rig({ now: () => new Date(now) });
    const sync = syncRequest(r);
    const state = stateFor(sync, r.fixture.nextServerSequence++);
    const peer = required([...r.fixture.sockets][0]);
    let calls = 0;
    r.client.onState(() => {
      calls++;
    });
    r.fixture.send(peer, state);
    await waitFor(
      () => r.store.inboundMessage(state.message_id)?.delivered === true,
    );
    const evidence = r.store.coordinationReceipt(state.sequence);
    expect(calls).toBe(1);
    r.fixture.send(
      peer,
      envelope(
        "ack",
        r.fixture.nextServerSequence++,
        { sequence: sync.sequence },
        sync.correlation_id,
      ),
    );
    await waitFor(
      () => r.store.outboundEvent(sync.sequence)?.acknowledgedAt !== null,
    );
    now += 61_000;
    const tombstone = envelope(
      "protocol.error",
      state.sequence,
      {
        code: "MESSAGE_EXPIRED",
        message: "A Connector message expired before delivery.",
      },
      sync.correlation_id,
      new Date(now),
    );
    r.fixture.send(peer, tombstone);
    await waitFor(
      () => r.store.inboundMessage(tombstone.message_id)?.delivered === true,
    );
    const restored = {
      ...state,
      message_id: randomUUID(),
      sent_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
    };
    r.fixture.send(peer, restored);
    await waitFor(
      () => r.store.inboundMessage(restored.message_id)?.delivered === true,
    );
    expect(r.store.coordinationReceipt(state.sequence)).toEqual(evidence);
    expect(calls).toBe(1);
  });

  it("establishes first tombstone evidence only from the exactly bound original", async () => {
    const r = await rig();
    const sync = syncRequest(r);
    const sequence = r.fixture.nextServerSequence++;
    const peer = required([...r.fixture.sockets][0]);
    const tombstone = envelope(
      "protocol.error",
      sequence,
      {
        code: "MESSAGE_EXPIRED",
        message: "A Connector message expired before delivery.",
      },
      sync.correlation_id,
    );
    r.fixture.send(peer, tombstone);
    await waitFor(
      () => r.store.inboundMessage(tombstone.message_id)?.delivered === true,
    );
    expect(r.store.coordinationReceipt(sequence)).toBeUndefined();
    const original = stateFor(sync, sequence);
    r.fixture.send(peer, original);
    await waitFor(() => r.store.coordinationReceipt(sequence) !== undefined);
    expect(r.store.coordinationReceipt(sequence)?.requestMessageId).toBe(
      sync.message_id,
    );
    expect(r.store.outboundEvent(sync.sequence)?.acknowledgedAt).toBeNull();
  });

  it.each(["new", "pinned"] as const)(
    "requires the actual extended store for %s effective coordination hello",
    async (source) => {
      const fixture = await startFixture();
      const { store } = makeStore();
      if (source === "pinned") {
        const hello = buildConnectorHello({
          connectorId: CONNECTOR_ID,
          sequence: 1,
          lastServerSequence: 0,
          correlationId: randomUUID(),
          now: new Date(),
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
        });
        store.enqueueEvent(
          {
            messageId: hello.message_id,
            sequence: 1,
            payload: JSON.stringify(hello),
          },
          true,
        );
      }
      const base = new Proxy(store, {
        get(target, property) {
          if (
            property === "coordinationReceipt" ||
            property === "coordinationRequest"
          )
            return undefined;
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const client = makeClient(
        fixture,
        base,
        source === "new" ? { capabilities: ["job-coordination-v1"] } : {},
      );
      const before = store.activeHello();
      try {
        expect(() => client.start(new AbortController().signal)).toThrow(
          "CONNECTOR_COORDINATION_STORE_REQUIRED",
        );
        expect(store.activeHello()).toEqual(before);
        expect(fixture.clientMessages).toEqual([]);
      } finally {
        store.close();
        await fixture.close();
      }
    },
  );

  it("retains an old durable-only hello and queue when mandatory coordination is requested", async () => {
    const fixture = await startFixture();
    const { store } = makeStore();
    const hello = buildConnectorHello({
      connectorId: CONNECTOR_ID,
      sequence: 1,
      lastServerSequence: 0,
      correlationId: randomUUID(),
      now: new Date(),
      capabilities: ["durable-receipts-v1"],
    });
    store.enqueueEvent(
      {
        messageId: hello.message_id,
        sequence: 1,
        payload: JSON.stringify(hello),
      },
      true,
    );
    try {
      const client = makeClient(fixture, store, {
        requireJobCoordination: true,
      });
      expect(() => client.start(new AbortController().signal)).toThrow(
        "CONNECTOR_INCOMPATIBLE_STATE",
      );
      expect(store.activeHello()?.payload).toBe(JSON.stringify(hello));
      expect(store.maxOutboundSequence()).toBe(1);
    } finally {
      store.close();
      await fixture.close();
    }
  });

  it.each([
    "job.claim",
    "job.event",
    "approval.requested",
    "job.cancelled",
  ] as const)(
    "allocates original %s profile before welcome and preserves it on reconnect",
    async (type) => {
      const r = await rig({}, false);
      const payload =
        type === "job.claim"
          ? { job_id: JOB_ID, attempt: 1, lease_id: randomUUID() }
          : type === "job.event"
            ? jobEventPayload()
            : type === "job.cancelled"
              ? { job_id: JOB_ID, attempt: 1, reason: "owner_request" }
              : {
                  job_id: JOB_ID,
                  attempt: 1,
                  job_revision: 2,
                  approval_id: randomUUID(),
                  action_summary: "Run checks",
                  impact_summary: "Checks only",
                  risk_class: "low",
                  action_fingerprint: `sha256:${"a".repeat(64)}`,
                  expires_at: isoAfter(30_000),
                };
      await r.client.publish(type, payload, randomUUID());
      const row = required(r.store.outboundEvent(2));
      expect(row.expectedReceiptProfile).toBe("job-coordination-v1");
      expect(r.fixture.clientMessages.map((m) => m.type)).toEqual([
        "connector.hello",
      ]);
      r.fixture.autoWelcome = true;
      required(r.sockets[0]).terminate();
      await waitFor(() => r.client.currentEpoch() !== undefined);
      await waitFor(() =>
        r.fixture.clientMessages.some((m) => m.type === type),
      );
      expect(r.store.outboundEvent(2)).toMatchObject({
        messageId: row.messageId,
        expectedReceiptProfile: "job-coordination-v1",
      });
      expect(r.store.activeHello()).not.toHaveProperty(
        "expectedReceiptProfile",
      );
      const request = ConnectorClientMessageSchema.parse(
        JSON.parse(row.payload),
      );
      const peer = required([...r.fixture.sockets][0]);
      r.fixture.send(
        peer,
        envelope(
          "ack",
          r.fixture.nextServerSequence++,
          { sequence: row.sequence },
          request.correlation_id,
        ),
      );
      await waitFor(
        () => r.store.outboundEvent(row.sequence)?.acknowledgedAt !== null,
      );
      const rejection = envelope(
        "protocol.error",
        r.fixture.nextServerSequence++,
        {
          code: type === "job.claim" ? "CLAIM_REJECTED" : "EVENT_REJECTED",
          message: "The job authority has changed.",
        },
        request.correlation_id,
      );
      r.fixture.send(peer, rejection);
      await waitFor(
        () => r.store.inboundMessage(rejection.message_id)?.delivered === true,
      );
      expect(
        r.store.coordinationReceipt(rejection.sequence)?.requestSequence,
      ).toBe(row.sequence);
      for (const event of r.store.pendingEvents(0)) {
        if (JSON.parse(event.payload).type === "ack")
          expect(event).not.toHaveProperty("expectedReceiptProfile");
      }
    },
  );

  it.each(["registration", "epoch", "state"] as const)(
    "aborts and fails closed on %s callback throw or async return",
    async (kind) => {
      for (const asynchronous of [false, true]) {
        const r = await rig();
        const epoch = required(r.client.currentEpoch());
        const before = r.store.maxOutboundSequence();
        const broken = (() => {
          if (asynchronous)
            return Promise.reject(new Error("private callback detail"));
          throw new Error("private callback detail");
        }) as unknown as () => undefined;
        if (kind === "epoch") {
          expect(() => r.client.onEpoch(broken)).toThrow(
            "CONNECTOR_COORDINATION_CALLBACK_FAILED",
          );
        } else if (kind === "registration") {
          expect(() =>
            r.client.publishSync(
              { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
              randomUUID(),
              broken,
            ),
          ).toThrow("CONNECTOR_COORDINATION_CALLBACK_FAILED");
          expect(r.store.maxOutboundSequence()).toBe(before + 1);
          expect(r.store.outboundEvent(before + 1)?.acknowledgedAt).toBeNull();
          expect(
            r.fixture.clientMessages.some((m) => m.type === "job.sync"),
          ).toBe(false);
        } else {
          r.client.onState(broken);
          let next = false;
          r.client.onState(() => {
            next = true;
          });
          r.client.publishSync(
            { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
            randomUUID(),
            () => undefined,
          );
          const sync = ConnectorClientMessageSchema.parse(
            JSON.parse(required(r.store.outboundEvent(before + 1)).payload),
          );
          if (sync.type !== "job.sync") throw new Error("fixture sync missing");
          const state = stateFor(sync, r.fixture.nextServerSequence++);
          r.fixture.send(required([...r.fixture.sockets][0]), state);
          await waitFor(() => epoch.signal.aborted);
          expect(next).toBe(false);
          expect(r.store.inboundMessage(state.message_id)?.delivered).toBe(
            false,
          );
        }
        expect(epoch.signal.aborted).toBe(true);
        expect(r.client.currentEpoch()).toBeUndefined();
        expect(await r.outcome).toBe("CONNECTOR_COORDINATION_CALLBACK_FAILED");
      }
    },
  );

  it("does not register or send when the SQLite sync transaction fails", async () => {
    const r = await rig();
    const db = new Database(join(r.directory, "state.sqlite"));
    const before = r.store.maxOutboundSequence();
    db.exec(
      "CREATE TRIGGER reject_sync BEFORE INSERT ON outbound_events WHEN json_extract(NEW.payload, '$.type') = 'job.sync' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    let registered = false;
    try {
      expect(() =>
        r.client.publishSync(
          { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
          randomUUID(),
          () => {
            registered = true;
          },
        ),
      ).toThrow("STORE_OUTBOUND_WRITE_FAILED");
      expect(registered).toBe(false);
      expect(r.store.maxOutboundSequence()).toBe(before);
      expect(r.fixture.clientMessages.some((m) => m.type === "job.sync")).toBe(
        false,
      );
      expect(r.client.currentEpoch()).toBeUndefined();
    } finally {
      db.exec("DROP TRIGGER reject_sync");
      db.close();
    }
  });

  it.each(["close", "error", "abort"] as const)(
    "revokes the captured epoch synchronously on %s and ignores old handlers",
    async (path) => {
      const r = await rig();
      const old = required(r.client.currentEpoch());
      const socket = required(r.sockets[0]);
      const oldClose = required(socket.listeners("close")[0]);
      if (path === "abort") r.controller.abort();
      else if (path === "error")
        socket.emit("error", new Error("private socket detail"));
      else {
        socket.terminate();
        await waitFor(() => old.signal.aborted);
      }
      expect(old.signal.aborted).toBe(true);
      expect(r.client.currentEpoch()).toBeUndefined();
      if (path === "abort") return;
      await waitFor(() => r.client.currentEpoch() !== undefined);
      const fresh = required(r.client.currentEpoch());
      expect(fresh).not.toBe(old);
      Reflect.apply(oldClose, socket, [1000, Buffer.alloc(0)]);
      expect(fresh.signal.aborted).toBe(false);
      expect(r.client.currentEpoch()).toBe(fresh);
      expect(old.signal.aborted).toBe(true);
    },
  );

  it("recovers state with null epoch after loss between SQLite commit and callback", async () => {
    const r = await rig();
    const old = required(r.client.currentEpoch());
    const deliveries: unknown[] = [];
    r.client.onState((_message, delivery) => {
      deliveries.push(delivery);
    });
    r.client.publishSync(
      { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
      randomUUID(),
      () => undefined,
    );
    const sync = ConnectorClientMessageSchema.parse(
      JSON.parse(
        required(r.store.outboundEvent(r.store.maxOutboundSequence())).payload,
      ),
    );
    if (sync.type !== "job.sync") throw new Error("fixture sync missing");
    const state = stateFor(sync, r.fixture.nextServerSequence++);
    const record = r.store.recordInbound.bind(r.store);
    const hook = vi
      .spyOn(r.store, "recordInbound")
      .mockImplementation((...args) => {
        const result = record(...args);
        if (args[0] === state.message_id) {
          hook.mockRestore();
          required(r.sockets[0]).emit(
            "error",
            new Error("fixture disconnect after commit"),
          );
          expect(old.signal.aborted).toBe(true);
          expect(deliveries).toEqual([]);
        }
        return result;
      });
    r.fixture.send(required([...r.fixture.sockets][0]), state);
    await waitFor(() => deliveries.length === 1);
    expect(deliveries).toEqual([{ epoch: null, recovered: true }]);
    expect(r.client.currentEpoch()).not.toBe(old);
    expect(r.store.inboundMessage(state.message_id)?.delivered).toBe(true);
    r.fixture.send(required([...r.fixture.sockets][0]), state);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliveries).toHaveLength(1);
  });

  it("registers the committed normalized sync before actual send and delivers state separately", async () => {
    const fixture = await startFixture();
    fixture.capabilities.push("job-coordination-v1");
    const { store } = makeStore();
    const controller = new AbortController();
    const client = makeClient(fixture, store, { requireJobCoordination: true });
    let registered = false;
    let stateCalls = 0;
    let commandCalls = 0;
    let request: import("./connector-client.js").PublishedSync | undefined;
    client.onCommand(async () => {
      commandCalls++;
    });
    const unsubscribe = client.onState((message, delivery) => {
      expect(registered).toBe(true);
      expect(delivery).toEqual({ epoch: request?.epoch, recovered: false });
      expect(store.inboundMessage(message.message_id)?.delivered).toBe(false);
      expect(store.coordinationReceipt(message.sequence)?.requestSequence).toBe(
        request?.sequence,
      );
      expect(
        store.outboundEvent(required(request).sequence)?.acknowledgedAt,
      ).toBeNull();
      stateCalls++;
    });
    const running = client.start(controller.signal);
    try {
      await waitFor(() => client.currentEpoch() !== undefined);
      let subscribed = false;
      client.onEpoch((epoch) => {
        expect(epoch).toBe(client.currentEpoch());
        subscribed = true;
      })();
      expect(subscribed).toBe(true);
      const socket = required([...fixture.sockets][0]);
      socket.on("message", (data) => {
        const sync = ConnectorClientMessageSchema.parse(
          JSON.parse(data.toString()),
        );
        if (sync.type !== "job.sync") return;
        expect(registered).toBe(true);
        fixture.send(socket, stateFor(sync, fixture.nextServerSequence++));
      });
      const result = client.publishSync(
        { job_id: JOB_ID.toUpperCase(), attempt: 1, nonce: randomUUID() },
        randomUUID(),
        (persisted) => {
          request = persisted;
          expect(Object.isFrozen(persisted)).toBe(true);
          expect(persisted.jobId).toBe(JOB_ID);
          expect(
            store.outboundEvent(persisted.sequence)?.expectedReceiptProfile,
          ).toBe("job-coordination-v1");
          expect(
            fixture.clientMessages.some((m) => m.type === "job.sync"),
          ).toBe(false);
          registered = true;
        },
      );
      expect(result).toBeUndefined();
      expect(registered).toBe(true);
      await waitFor(() => stateCalls === 1);
      expect(commandCalls).toBe(0);
      controller.abort();
      expect(required(request).epoch.signal.aborted).toBe(true);
      expect(client.currentEpoch()).toBeUndefined();
    } finally {
      unsubscribe();
      controller.abort();
      await running;
      store.close();
      await fixture.close();
    }
  });

  it("tracks original profiles for offline business allocation and denies offline sync", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    const { store } = makeStore();
    const controller = new AbortController();
    const client = makeClient(fixture, store, {
      capabilities: ["job-coordination-v1"],
    });
    const running = client.start(controller.signal);
    try {
      await client.publish("job.event", jobEventPayload(), randomUUID());
      expect(store.outboundEvent(2)?.expectedReceiptProfile).toBe(
        "job-coordination-v1",
      );
      expect(() =>
        client.publishSync(
          { job_id: JOB_ID, attempt: 1, nonce: randomUUID() },
          randomUUID(),
          () => undefined,
        ),
      ).toThrow("CONNECTOR_COORDINATION_UNAVAILABLE");
      expect(store.maxOutboundSequence()).toBe(2);
      expect(store.activeHello()).not.toHaveProperty("expectedReceiptProfile");
    } finally {
      controller.abort();
      await running;
      store.close();
      await fixture.close();
    }
  });

  it("refuses generic sync without allocating a durable request", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    const { store } = makeStore();
    const controller = new AbortController();
    const client = makeClient(fixture, store);
    const running = client.start(controller.signal);
    try {
      const before = store.maxOutboundSequence();
      await expect(
        client.publish(
          "job.sync",
          {
            job_id: JOB_ID,
            attempt: 1,
            nonce: randomUUID(),
          },
          randomUUID(),
        ),
      ).rejects.toThrow("CONNECTOR_SYNC_REQUIRES_TRACKED_ALLOCATION");
      expect(store.maxOutboundSequence()).toBe(before);
    } finally {
      controller.abort();
      await running;
      store.close();
      await fixture.close();
    }
  });

  it("requires both echoes before recovering pending commands", async () => {
    const fixture = await startFixture();
    const { store } = makeStore();
    const command = envelope("job.cancel", 1, {
      job_id: JOB_ID,
      attempt: 1,
      job_revision: 2,
      nonce: randomUUID(),
      reason: "owner_request",
    });
    store.recordInbound(command.message_id, 1, JSON.stringify(command));
    fixture.nextServerSequence = 2;
    const controller = new AbortController();
    const client = makeClient(fixture, store, { requireJobCoordination: true });
    let called = false;
    client.onCommand(async () => {
      called = true;
    });
    const running = client.start(controller.signal);
    const outcome = running.catch((error: Error) => error.message);
    try {
      await waitFor(() => fixture.clientMessages.length > 0);
      await waitFor(() => called || fixture.sockets.size === 0);
      expect(called).toBe(false);
      expect(await outcome).toBe("CONNECTOR_INCOMPATIBLE_PEER");
      expect(store.inboundMessage(command.message_id)?.delivered).toBe(false);
    } finally {
      controller.abort();
      await outcome;
      store.close();
      await fixture.close();
    }
  });
});

describe("authenticated connector transport", () => {
  const fixtures: Fixture[] = [];
  const stores: Array<{ store: SqlitePluginStore; directory: string }> = [];

  afterEach(async () => {
    for (const item of stores.splice(0)) item.store.close();
    for (const fixture of fixtures.splice(0)) await fixture.close();
    vi.useRealTimers();
  });

  it.each([
    [false, "resolve"],
    [false, "reject"],
    [true, "resolve"],
    [true, "reject"],
  ] as const)(
    "stops held handler continuation after abort and SQLite close (recovery=%s, %s)",
    async (recovery, outcome) => {
      const fixture = await startFixture();
      fixture.autoWelcome = !recovery;
      fixtures.push(fixture);
      const item = makeStore();
      stores.push(item);
      let closed = false;
      const lateAccess: string[] = [];
      const observedStore = new Proxy(item.store, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (closed) lateAccess.push(String(property));
            return Reflect.apply(value, target, args);
          };
        },
      });
      const controller = new AbortController();
      const client = makeClient(fixture, observedStore);
      const held = deferred<void>();
      let entered = false;
      let secondCalls = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      client.onCommand(async () => {
        entered = true;
        await held.promise;
      });
      client.onCommand(async () => {
        secondCalls++;
      });
      const running = client.start(controller.signal);
      let command: ConnectorServerMessage | undefined;
      try {
        await waitFor(() => fixture.clientMessages.length > 0);
        const socket = required([...fixture.sockets][0]);
        command = envelope("job.cancel", fixture.nextServerSequence++, {
          job_id: JOB_ID,
          attempt: 1,
          job_revision: 2,
          nonce: randomUUID(),
          reason: "owner_request",
        });
        fixture.send(socket, command);
        if (recovery) {
          await waitFor(
            () =>
              item.store.inboundMessage(command?.message_id ?? "") !==
              undefined,
          );
          fixture.sendWelcome(socket, required(fixture.clientMessages[0]));
        }
        await waitFor(() => entered);
        controller.abort();
        expect(
          await Promise.race([
            running.then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), 1_500),
            ),
          ]),
        ).toBe(true);
        expect(item.store.inboundMessage(command.message_id)?.delivered).toBe(
          false,
        );
        const allocated = item.store.maxOutboundSequence();
        item.store.close();
        closed = true;
        if (outcome === "resolve") held.resolve();
        else held.reject(new Error("late handler failure"));
        // Drain the callback continuation and queued receive/send work.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(secondCalls).toBe(0);
        expect(lateAccess).toEqual([]);
        expect(unhandled).toEqual([]);
        const reopened = new SqlitePluginStore(
          join(item.directory, "state.sqlite"),
        );
        try {
          expect(reopened.inboundMessage(command.message_id)?.delivered).toBe(
            false,
          );
          expect(reopened.maxOutboundSequence()).toBe(allocated);
        } finally {
          reopened.close();
        }
      } finally {
        controller.abort();
        held.resolve();
        await running;
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it("does not invoke a queued bootstrap callback after immediate abort", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    let calls = 0;
    const controller = new AbortController();
    const client = makeClient(fixture, item.store, {
      bootstrapCredentialProvider: async () => {
        calls++;
        return BOOTSTRAP_CREDENTIAL;
      },
    });
    const running = client.start(controller.signal);
    controller.abort();
    await running;
    item.store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(0);
    expect(fixture.tokenRequests).toEqual([]);
    expect(fixture.socketTokens).toEqual([]);
  });

  it("fails a missing welcome echo before commands or post-hello traffic", async () => {
    const fixture = await startFixture();
    fixture.autoWelcome = false;
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const client = makeClient(fixture, item.store);
    const handler = vi.fn(async () => undefined);
    client.onCommand(handler);
    const controller = new AbortController();
    const result = client
      .start(controller.signal)
      .catch((error: Error) => error);
    try {
      await waitFor(() => fixture.clientMessages.length === 1);
      const socket = required([...fixture.sockets][0]);
      fixture.send(
        socket,
        envelope("job.offer", 1, {
          job_id: JOB_ID,
          attempt: 1,
          lease_id: randomUUID(),
          repository_id: "repo",
          request: "Run tests",
        }),
      );
      const legacy = envelope(
        "connector.welcome",
        2,
        { connector_id: CONNECTOR_ID, server_sequence: 2, replay_from: 1 },
        required(fixture.clientMessages[0]).correlation_id as ReturnType<
          typeof randomUUID
        >,
      );
      if (legacy.type !== "connector.welcome")
        throw new Error("fixture welcome missing");
      delete legacy.payload.capabilities;
      fixture.send(socket, legacy);
      expect(await result).toMatchObject({
        message: "CONNECTOR_INCOMPATIBLE_PEER",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.clientMessages).toHaveLength(1);
    } finally {
      controller.abort();
      await result;
    }
  });

  it("restores a correlated business rejection before its receipt ACK", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const client = makeClient(fixture, item.store);
    const controller = new AbortController();
    const running = client.start(controller.signal);
    const correlation = randomUUID();
    try {
      await waitFor(() => fixture.clientMessages.some((m) => m.type === "ack"));
      await client.publish("job.event", jobEventPayload(), correlation);
      await waitFor(() =>
        fixture.clientMessages.some((m) => m.correlation_id === correlation),
      );
      const product = required(
        fixture.clientMessages.find((m) => m.correlation_id === correlation),
      );
      const socket = required([...fixture.sockets][0]);
      const tombstone = envelope(
        "protocol.error",
        2,
        {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
        correlation,
      );
      fixture.send(socket, tombstone);
      await waitFor(
        () =>
          item.store.inboundMessage(tombstone.message_id)?.delivered === true,
      );
      const restored = envelope(
        "protocol.error",
        2,
        {
          code: "EVENT_REJECTED",
          message: "The business deadline has expired.",
        },
        correlation,
      );
      fixture.send(socket, restored);
      expect(
        await becomesTrue(
          () =>
            item.store.inboundMessage(restored.message_id)?.delivered === true,
        ),
      ).toBe(true);
      fixture.send(
        socket,
        envelope("ack", 3, { sequence: product.sequence }, correlation),
      );
      await waitFor(
        () => item.store.provenClientSequence() === product.sequence,
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  it("preserves an incompatible pending legacy hello without allocating or rewriting", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const hello = buildConnectorHello({
      connectorId: CONNECTOR_ID,
      sequence: 1,
      lastServerSequence: 0,
      correlationId: randomUUID(),
      now: new Date(),
    });
    item.store.enqueueEvent(
      {
        messageId: hello.message_id,
        sequence: 1,
        payload: JSON.stringify(hello),
      },
      true,
    );
    const client = makeClient(fixture, item.store);
    expect(() => client.start(new AbortController().signal)).toThrow(
      "CONNECTOR_INCOMPATIBLE_STATE",
    );
    expect(item.store.maxOutboundSequence()).toBe(1);
    expect(item.store.activeHello()?.payload).toBe(JSON.stringify(hello));
  });

  it.each([false, true])(
    "reconnects on missing application receipt progress (welcome=%s) without retiring uncertain frames",
    async (autoWelcome) => {
      const fixture = await startFixture();
      fixture.autoWelcome = autoWelcome;
      fixtures.push(fixture);
      const item = makeStore();
      stores.push(item);
      let time = Date.now();
      const client = makeClient(fixture, item.store, {
        now: () => new Date(time),
        reconnectDelay: () => 10_000,
      });
      const controller = new AbortController();
      const running = client.start(controller.signal);
      try {
        await waitFor(
          () => fixture.clientMessages.length === (autoWelcome ? 2 : 1),
        );
        const sequence = item.store.maxOutboundSequence();
        time += 30_001;
        await waitFor(() => fixture.sockets.size === 0);
        expect(item.store.maxOutboundSequence()).toBe(sequence);
        expect(item.store.pendingEvents(0)).toHaveLength(1);
        expect(item.store.provenClientSequence()).toBe(autoWelcome ? 1 : 0);
      } finally {
        controller.abort();
        await running;
      }
    },
  );

  it("bounds unconfirmed bytes independently of its frame limit", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const client = makeClient(fixture, item.store);
    const controller = new AbortController();
    const running = client.start(controller.signal);
    try {
      await waitFor(() =>
        fixture.clientMessages.some((message) => message.type === "ack"),
      );
      const payload = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`item${i}`, "a".repeat(450)]),
      );
      for (let i = 0; i < 12; i++)
        await client.publish(
          "job.event",
          { ...jobEventPayload(), payload },
          randomUUID(),
        );
      await waitFor(() => fixture.clientMessages.length >= 10);
      const sent = fixture.clientMessages.filter(
        (message) => message.type !== "connector.hello",
      );
      const bytes = sent.reduce(
        (sum, message) => sum + Buffer.byteLength(JSON.stringify(message)),
        0,
      );
      expect(sent.length).toBeLessThan(32);
      expect(bytes).toBeLessThanOrEqual(128 * 1024);
      expect(
        bytes + Buffer.byteLength(JSON.stringify(sent.at(-1))),
      ).toBeGreaterThan(128 * 1024);
    } finally {
      controller.abort();
      await running;
    }
  });

  it("records expired disposition when SQLite receipt crosses the command deadline", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    let time = Date.now();
    const original = item.store.recordInbound.bind(item.store);
    vi.spyOn(item.store, "recordInbound").mockImplementation(
      (id, sequence, body) => {
        const result = original(id, sequence, body);
        if (JSON.parse(body).type === "job.offer") time += 61_000;
        return result;
      },
    );
    const client = makeClient(fixture, item.store, {
      now: () => new Date(time),
    });
    const handler = vi.fn(async () => undefined);
    client.onCommand(handler);
    const controller = new AbortController();
    const running = client.start(controller.signal);
    try {
      await waitFor(() =>
        fixture.clientMessages.some((message) => message.type === "ack"),
      );
      const command = envelope("job.offer", fixture.nextServerSequence++, {
        job_id: JOB_ID,
        attempt: 1,
        lease_id: randomUUID(),
        repository_id: "repo",
        request: "Run tests",
      });
      fixture.send(required([...fixture.sockets][0]), command);
      await waitFor(
        () => item.store.inboundMessage(command.message_id)?.delivered === true,
      );
      expect(handler).not.toHaveBeenCalled();
      const database = new Database(join(item.directory, "state.sqlite"), {
        readonly: true,
      });
      try {
        expect(
          database
            .prepare("SELECT value FROM metadata WHERE key = ?")
            .get(`inbound-disposition:${command.message_id}`),
        ).toEqual({ value: "expired" });
      } finally {
        database.close();
      }
    } finally {
      controller.abort();
      await running;
    }
  });

  it("renews a delayed first hello without changing its identity and retains unproven ACKs on abort", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const credentials = deferred<string>();
    let time = Date.now() - 120_000;
    const client = makeClient(fixture, item.store, {
      now: () => new Date(time),
      bootstrapCredentialProvider: () => credentials.promise,
    });
    const controller = new AbortController();
    const running = client.start(controller.signal);
    const original = JSON.parse(
      required(item.store.pendingEvents(0)[0]).payload,
    );
    time = Date.now();
    credentials.resolve(BOOTSTRAP_CREDENTIAL);
    try {
      await waitFor(() => fixture.clientMessages.some((m) => m.type === "ack"));
      const hello = required(fixture.clientMessages[0]);
      expect(hello).toEqual({
        ...original,
        expires_at: new Date(time + 60_000).toISOString(),
      });
    } finally {
      controller.abort();
      await running;
    }
    expect(
      item.store
        .pendingEvents(0)
        .some((row) => JSON.parse(row.payload).type === "ack"),
    ).toBe(true);
    expect(item.store.activeHello()?.messageId).toBe(original.message_id);
  });

  it("bounds unconfirmed traffic at 32 frames and does not ACK server ACKs", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    const client = makeClient(fixture, item.store);
    const controller = new AbortController();
    const running = client.start(controller.signal);
    try {
      await waitFor(() => fixture.clientMessages.some((m) => m.type === "ack"));
      for (let i = 0; i < 130; i++)
        await client.publish("job.event", jobEventPayload(), randomUUID());
      await waitFor(() => fixture.clientMessages.length >= 33);
      expect(
        fixture.clientMessages.filter((m) => m.type !== "connector.hello"),
      ).toHaveLength(32);
      const last = required(fixture.clientMessages.at(-1));
      const beforeAcks = fixture.clientMessages.filter(
        (m) => m.type === "ack",
      ).length;
      fixture.send(
        required([...fixture.sockets][0]),
        envelope(
          "ack",
          fixture.nextServerSequence++,
          { sequence: last.sequence },
          last.correlation_id as ReturnType<typeof randomUUID>,
        ),
      );
      await waitFor(() => fixture.clientMessages.length > 33);
      expect(
        fixture.clientMessages.filter((m) => m.type === "ack"),
      ).toHaveLength(beforeAcks);
      expect(item.store.provenClientSequence()).toBe(last.sequence);
    } finally {
      controller.abort();
      await running;
    }
  });

  it("rechecks expiry after receipt and before each handler", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const item = makeStore();
    stores.push(item);
    let time = Date.now();
    const client = makeClient(fixture, item.store, {
      now: () => new Date(time),
    });
    const first = vi.fn(async () => {
      time += 61_000;
    });
    const second = vi.fn(async () => undefined);
    client.onCommand(first);
    client.onCommand(second);
    const controller = new AbortController();
    const running = client.start(controller.signal);
    try {
      await waitFor(() => fixture.clientMessages.some((m) => m.type === "ack"));
      const command = envelope("job.offer", fixture.nextServerSequence++, {
        job_id: JOB_ID,
        attempt: 1,
        lease_id: randomUUID(),
        repository_id: "repo",
        request: "Run tests",
      });
      fixture.send(required([...fixture.sockets][0]), command);
      await waitFor(
        () => item.store.inboundMessage(command.message_id)?.delivered === true,
      );
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await running;
    }
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
    await waitFor(() => fixture.clientMessages.length >= replayStart + 2);
    const replayed = fixture.clientMessages.slice(replayStart, replayStart + 2);

    secondController.abort();
    await secondRunning;
    expect(replayed.map(({ type }) => type)).toEqual(["job.event", "ack"]);
    expect(replayed.map(({ sequence }) => sequence)).toEqual([2, 3]);
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
    expect(Date.parse(String(replayedHello.expires_at))).toBeGreaterThan(
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

  it("processes a same-sequence command tombstone once and coalesces its pending ACK", async () => {
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
        ).length === 1,
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

  it("durably receives a command before ACK, suppresses duplicates, and coalesces unconfirmed ACKs", async () => {
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
        ).length === 1,
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
      markInboundExpired: (messageId) =>
        baseStore.markInboundExpired(messageId),
      activeHello: () => baseStore.activeHello(),
      outboundEvent: (sequence) => baseStore.outboundEvent(sequence),
      renewDelivery: (...args) => baseStore.renewDelivery(...args),
      provenClientSequence: () => baseStore.provenClientSequence(),
      acknowledgeThrough: (...args) => baseStore.acknowledgeThrough(...args),
      mapJob: (input) => baseStore.mapJob(input),
      findJob: (jobId) => baseStore.findJob(jobId),
      listNonterminalJobs: () => baseStore.listNonterminalJobs(),
      enqueueEvent: (event, pinHello) => {
        const message = JSON.parse(event.payload) as JsonRecord;
        operations.push(`enqueueEvent:${String(message.type)}`);
        baseStore.enqueueEvent(event, pinHello);
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
    const pendingAck = required(store.pendingEvents(0)[0]);
    expect(JSON.parse(pendingAck.payload).type).toBe("ack");
    store.acknowledgeThrough(
      pendingAck.sequence,
      JSON.parse(pendingAck.payload).correlation_id,
    );
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
          ).length === 1,
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
