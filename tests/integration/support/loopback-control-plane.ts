import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "./tls.js";

/** One parsed frame in arrival order, kept with its raw text so a test can
 * assert that no secret material ever reached the wire. */
export interface RecordedFrame {
  readonly type: string;
  readonly raw: string;
  readonly message: ConnectorClientMessage | ConnectorServerMessage;
}

export interface LoopbackJobState {
  jobId: string;
  repositoryId: string;
  attempt: number;
  status: "running" | "cancelling" | "succeeded" | "failed";
  jobRevision: number;
  cancelRevision: number | null;
  leaseId: string;
}

export interface LoopbackControlPlaneOptions {
  readonly repositoryId?: string;
  readonly token?: string;
}

export interface LoopbackControlPlane {
  /** `wss://` connector endpoint. */
  readonly url: string;
  /** `https://` base the session-token client appends `/session` to. */
  readonly sessionEndpoint: string;
  /** CA certificate the test client must trust. */
  readonly ca: string;
  readonly inbound: RecordedFrame[];
  readonly outbound: RecordedFrame[];
  readonly tokenRequests: {
    connectorId: string;
    credentialId: string;
    credentialSecret: string;
  }[];
  readonly state: LoopbackJobState;
  connections(): number;
  ackedSequences(): number[];
  /** When enabled every durable client frame is acknowledged in arrival order. */
  setAcknowledge(value: boolean): void;
  sendOffer(overrides?: Partial<LoopbackJobState>): void;
  sendCancel(): void;
  sendApprovalDecision(overrides?: Record<string, unknown>): void;
  ackInbound(): void;
  killSockets(): void;
  waitForConnection(count: number, timeoutMs?: number): Promise<void>;
  waitForInbound(
    type: string,
    options?: { after?: number; timeoutMs?: number },
  ): Promise<RecordedFrame>;
  close(): Promise<void>;
}

const waitFor = async <T>(
  probe: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`TIMEOUT_WAITING_FOR_${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A loopback Control Plane for rehearsals: it serves the session-token
 * exchange over HTTPS and the connector protocol over WebSocket, records every
 * frame in both directions, and can drop sockets to exercise reconnect.
 */
export const startLoopbackControlPlane = async (
  options: LoopbackControlPlaneOptions = {},
): Promise<LoopbackControlPlane> => {
  const repositoryId = options.repositoryId ?? "example";
  const token = options.token ?? "fixture-session-token";
  const inbound: RecordedFrame[] = [];
  const outbound: RecordedFrame[] = [];
  const tokenRequests: LoopbackControlPlane["tokenRequests"] = [];
  const acked = new Set<number>();
  let acknowledge = false;
  let sequence = 0;
  let connectionCount = 0;
  const state: LoopbackJobState = {
    jobId: randomUUID(),
    repositoryId,
    attempt: 1,
    status: "running",
    jobRevision: 3,
    cancelRevision: null,
    leaseId: randomUUID(),
  };

  const server: Server = createServer(LOCALHOST_TLS, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.endsWith("/session")) {
        response.writeHead(404).end();
        return;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        response.writeHead(400).end();
        return;
      }
      tokenRequests.push({
        connectorId: String(parsed.connector_id ?? ""),
        credentialId: String(parsed.credential_id ?? ""),
        credentialSecret: String(parsed.credential_secret ?? ""),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          token,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        }),
      );
    });
  });
  const sockets = new WebSocketServer({ server });

  const record = (
    target: RecordedFrame[],
    raw: string,
    message: ConnectorClientMessage | ConnectorServerMessage,
  ) => {
    target.push({ type: message.type, raw, message });
  };

  const send = (type: string, payload: unknown, correlationId?: string) => {
    const envelope = ConnectorServerMessageSchema.parse({
      protocol_version: "1.0",
      type,
      message_id: randomUUID(),
      sequence: ++sequence,
      correlation_id: correlationId ?? randomUUID(),
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload,
    });
    const raw = JSON.stringify(envelope);
    for (const socket of sockets.clients) socket.send(raw);
    record(outbound, raw, envelope);
    serverLog.push({ envelope, raw });
    return { envelope, raw };
  };

  /** The server keeps its own durable log; a reconnect replays those exact
   * frames in sequence order instead of minting new ones, which the client
   * would reject as a stored-inbound conflict or a sequence gap. */
  const serverLog: { envelope: ConnectorServerMessage; raw: string }[] = [];
  const replayServerLog = () => {
    for (const entry of serverLog) {
      for (const socket of sockets.clients) socket.send(entry.raw);
      record(outbound, entry.raw, entry.envelope);
    }
  };

  const sendState = (request: RecordedFrame["message"]) => {
    const payload = request.payload as Record<string, unknown>;
    const observed = Date.now();
    send(
      "job.state",
      {
        job_id: state.jobId,
        repository_id: state.repositoryId,
        mode: "normal",
        requested_attempt: state.attempt,
        current_attempt: state.attempt,
        status: state.status,
        job_revision: state.jobRevision,
        cancel_revision: state.cancelRevision,
        lease_id: state.leaseId,
        lease_expires_at: new Date(observed + 30_000).toISOString(),
        expires_at: new Date(observed + 60_000).toISOString(),
        observed_at: new Date(observed).toISOString(),
        state_valid_until: new Date(observed + 2_000).toISOString(),
        request_message_id: request.message_id,
        request_sequence: request.sequence,
        nonce: payload.nonce,
      },
      request.correlation_id,
    );
  };

  sockets.on("connection", (socket: WebSocket) => {
    connectionCount += 1;
    socket.on("message", (bytes: Buffer) => {
      const raw = bytes.toString("utf8");
      let message: ConnectorClientMessage;
      try {
        message = ConnectorClientMessageSchema.parse(JSON.parse(raw));
      } catch {
        return;
      }
      const frame: RecordedFrame = { type: message.type, raw, message };
      inbound.push(frame);
      if (message.type === "connector.hello") {
        if (serverLog.length === 0) {
          const payload = message.payload as { connector_id: string };
          send(
            "connector.welcome",
            {
              connector_id: payload.connector_id,
              capabilities: ["durable-receipts-v1", "job-coordination-v1"],
              server_sequence: sequence + 1,
              replay_from: 1,
            },
            message.correlation_id,
          );
        } else {
          replayServerLog();
        }
      }
      if (message.type === "job.sync") sendState(message);
      if (message.type === "ack") {
        acked.add((message.payload as { sequence: number }).sequence);
      } else if (acknowledge && message.type !== "connector.hello") {
        send("ack", { sequence: message.sequence }, message.correlation_id);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `wss://127.0.0.1:${port}`,
    sessionEndpoint: `https://127.0.0.1:${port}/connector/v1`,
    ca: LOCALHOST_TLS.cert,
    inbound,
    outbound,
    tokenRequests,
    state,
    connections: () => connectionCount,
    ackedSequences: () => [...acked].sort((left, right) => left - right),
    setAcknowledge: (value: boolean) => {
      acknowledge = value;
    },
    sendOffer: (overrides = {}) => {
      send("job.offer", {
        job_id: overrides.jobId ?? state.jobId,
        attempt: overrides.attempt ?? state.attempt,
        lease_id: overrides.leaseId ?? state.leaseId,
        repository_id: overrides.repositoryId ?? state.repositoryId,
        request: "fixture request",
      });
    },
    sendCancel: () =>
      send("job.cancel", {
        job_id: state.jobId,
        attempt: state.attempt,
        job_revision: state.jobRevision,
        reason: "owner",
        nonce: randomUUID(),
      }),
    sendApprovalDecision: (overrides = {}) =>
      send("approval.decision", {
        approval_id: randomUUID(),
        job_id: state.jobId,
        attempt: state.attempt,
        job_revision: state.jobRevision,
        action_fingerprint: "a".repeat(64),
        decision: "approve",
        ...overrides,
      }),
    /** Acknowledge every durable client frame received so far, on the wire. */
    ackInbound: () => {
      for (const frame of inbound) {
        if (frame.type === "connector.hello" || frame.type === "ack") continue;
        if (acked.has(frame.message.sequence)) continue;
        acked.add(frame.message.sequence);
        send("ack", { sequence: frame.message.sequence });
      }
    },
    killSockets: () => {
      for (const socket of sockets.clients) socket.terminate();
    },
    waitForConnection: async (count, timeoutMs = 5_000) => {
      await waitFor(
        () => (connectionCount >= count ? count : undefined),
        timeoutMs,
        `CONNECTION_${count}`,
      );
    },
    waitForInbound: async (type, { after = 0, timeoutMs = 5_000 } = {}) =>
      waitFor(
        () => inbound.slice(after).find((frame) => frame.type === type),
        timeoutMs,
        type.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"),
      ),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
