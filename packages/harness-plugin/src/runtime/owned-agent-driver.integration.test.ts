import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import {
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "../../../../tests/integration/support/tls.js";
import { SqlitePluginStore } from "../store/plugin-store.js";
import { DurableConnectorClient } from "../transport/connector-client.js";
import { CancelHandler } from "./cancel-handler.js";
import {
  JobCommandCoordinator,
  type JobOfferMessage,
} from "./job-command-coordinator.js";
import { JobStateClient } from "./job-state-client.js";
import { OwnedAgentDriver } from "./owned-agent-driver.js";
import { TerminalAuthorityIssuer } from "./terminal-authority.js";

// The transport requires a canonical POSIX repository root for outbound
// redaction; Windows realpath spellings cannot satisfy it, so the native-result
// route is exercised on the Linux required-CI runner instead.
const POSIX_REDACTION_SUPPORTED = process.platform !== "win32";

it("driver routes a confirmed cancellation through the owned sink", async () => {
  await withDriver({}, async ({ driver, store, jobId, command }) => {
    expect(await driver.admitCancellation(command)).toBe(true);
    const handler = new CancelHandler({
      resolveOwner: (value) => driver.cancellationOwner(value),
      beforeCancel: (owner) => driver.beginCancellation(owner),
    });
    expect(await handler.handle(command)).toBe("cancelled");
    expect(store.findJob(jobId)?.status).toBe("cancelled");
    const intent = store.ownedIntent(jobId, 1);
    expect(intent).toBeDefined();
    if (intent !== undefined)
      expect(store.readTerminal(intent.owner)?.kind).toBe("local");
  });
});

it("routes a cancellation through the command coordinator", async () => {
  await withDriver({}, async ({ coordinator, store, jobId, command }) => {
    await coordinator.handle(command);
    expect(store.findJob(jobId)?.status).toBe("cancelled");
  });
});

it.skipIf(!POSIX_REDACTION_SUPPORTED)(
  "driver routes a native result through the owned sink",
  async () => {
    await withDriver({ redaction: true }, async ({ driver, store, jobId }) => {
      const result = await driver.commitNativeOutcome({
        jobId,
        attempt: 1,
        outcome: "succeeded",
        eventSequence: 1,
        projection: { summary: "Completed", stage: "done" },
      });
      expect(result.kind).toBe("committed");
      expect(store.findJob(jobId)?.status).toBe("succeeded");
      const intent = store.ownedIntent(jobId, 1);
      expect(intent).toBeDefined();
      if (intent !== undefined)
        expect(store.readTerminal(intent.owner)?.kind).toBe("local");
    });
  },
);

type Context = {
  coordinator: JobCommandCoordinator;
  driver: OwnedAgentDriver;
  store: SqlitePluginStore;
  jobId: string;
  command: Extract<
    ReturnType<typeof ConnectorServerMessageSchema.parse>,
    { type: "job.cancel" }
  >;
};

async function withDriver(
  options: Readonly<{ redaction?: boolean }>,
  run: (context: Context) => Promise<void>,
): Promise<void> {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "driver-terminal-tls-")),
  );
  const store = new SqlitePluginStore(join(directory, "store.sqlite"));
  const server = createServer(LOCALHOST_TLS);
  const wss = new WebSocketServer({ server });
  const lifecycle = new AbortController();
  const jobId = randomUUID();
  const leaseId = randomUUID();
  let sequence = 0;
  let cancelling = false;
  wss.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const request = ConnectorClientMessageSchema.parse(
        JSON.parse(bytes.toString()),
      );
      const send = (type: string, payload: unknown) =>
        socket.send(
          JSON.stringify(
            ConnectorServerMessageSchema.parse({
              protocol_version: "1.0",
              type,
              message_id: randomUUID(),
              sequence: ++sequence,
              correlation_id: request.correlation_id,
              sent_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60000).toISOString(),
              payload,
            }),
          ),
        );
      if (request.type === "connector.hello")
        send("connector.welcome", {
          connector_id: request.payload.connector_id,
          capabilities: ["durable-receipts-v1", "job-coordination-v1"],
          server_sequence: sequence + 1,
          replay_from: 1,
        });
      if (request.type === "job.sync") {
        const observed = Date.now();
        send("job.state", {
          job_id: jobId,
          repository_id: "example",
          mode: "normal",
          requested_attempt: 1,
          current_attempt: 1,
          status: cancelling ? "cancelling" : "running",
          job_revision: cancelling ? 4 : 3,
          cancel_revision: cancelling ? 4 : null,
          lease_id: leaseId,
          lease_expires_at: new Date(observed + 30000).toISOString(),
          expires_at: new Date(observed + 60000).toISOString(),
          observed_at: new Date(observed).toISOString(),
          state_valid_until: new Date(observed + 2000).toISOString(),
          request_message_id: request.message_id,
          request_sequence: request.sequence,
          nonce: request.payload.nonce,
        });
      }
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new DurableConnectorClient({
    connectorId: randomUUID(),
    controlPlaneUrl: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    requireJobCoordination: true,
    requireOwnedTerminal: true,
    ...(options.redaction === true
      ? { redaction: { repositoryRoot: directory, homeDirectory: tmpdir() } }
      : {}),
    sessionTokenClient: {
      exchange: async () => ({
        token: "fixture",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    },
    bootstrapCredentialProvider: async () => "fixture",
    webSocketFactory: (url, connectionOptions) =>
      new WebSocket(url, { ...connectionOptions, ca: LOCALHOST_TLS.cert }),
  });
  const running = client.start(lifecycle.signal).catch((error) => error);
  const states = new JobStateClient({ connector: client });
  const authority = new TerminalAuthorityIssuer({
    connector: client,
    states,
    store,
  });
  let captured: unknown;
  let status: "running" | "idle" = "running";
  const agent = {
    id: "",
    get status() {
      return status;
    },
    session: undefined as unknown as Session,
    followup: (message: unknown) => {
      captured = message;
    },
    cancel: () => {
      status = "idle";
    },
    whenIdle: async () => {},
  } as unknown as Agent;
  const agents = {
    create: async (input: { sessionId: unknown }): Promise<AgentHandle> => {
      (agent as unknown as { id: string }).id = String(input.sessionId);
      (agent as unknown as { session: Session }).session = {
        ownEvents: () =>
          captured === undefined
            ? []
            : [
                {
                  type: "user/message",
                  seq: 1,
                  time: Date.now(),
                  data: captured,
                },
              ],
      } as unknown as Session;
      return { agent, dispose: async () => {} } as unknown as AgentHandle;
    },
  };
  const offer = ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.offer",
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    payload: {
      job_id: jobId,
      attempt: 1,
      repository_id: "example",
      lease_id: leaseId,
      request: "fixture request",
    },
  }) as JobOfferMessage;
  const driver = new OwnedAgentDriver({
    agents,
    store,
    states,
    authority,
    terminal: client,
    epoch: () => client.currentEpoch(),
    repositories: {
      resolve: (id) => (id === "example" ? directory : undefined),
    },
    publishClaim: async (value) => {
      await client.publish(
        "job.claim",
        {
          job_id: value.payload.job_id,
          attempt: value.payload.attempt,
          lease_id: value.payload.lease_id,
        },
        randomUUID(),
      );
    },
    flush: async () => true,
  });
  const cancellation = new CancelHandler({
    resolveOwner: (value) => driver.cancellationOwner(value),
    beforeCancel: (owner) => driver.beginCancellation(owner),
  });
  const coordinator = new JobCommandCoordinator({
    starter: driver,
    cancel: {
      handle: async (value) => {
        await driver.admitCancellation(value);
        return cancellation.handle(value);
      },
    },
    approvals: { acceptDecision: () => "ignored" },
    repositories: {
      resolve: (id) => (id === "example" ? directory : undefined),
    },
  });
  const command = ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.cancel",
    message_id: randomUUID(),
    sequence: 90,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    payload: {
      job_id: jobId,
      attempt: 1,
      job_revision: 4,
      reason: "owner",
      nonce: randomUUID(),
    },
  }) as Context["command"];
  try {
    const deadline = Date.now() + 3000;
    while (!client.currentEpoch()) {
      if (Date.now() >= deadline) throw new Error("epoch timeout");
      await new Promise((resolve) => setImmediate(resolve));
    }
    const delivered = new Promise<JobOfferMessage>((resolve) =>
      client.onCommand(async (value) => {
        if (value.type === "job.offer" && value.message_id === offer.message_id)
          resolve(value);
      }),
    );
    for (const socket of wss.clients)
      socket.send(JSON.stringify({ ...offer, sequence: ++sequence }));
    await driver.start(await delivered);
    cancelling = true;
    await run({ coordinator, driver, store, jobId, command });
  } finally {
    await driver.dispose();
    authority.dispose();
    states.dispose();
    lifecycle.abort();
    await running;
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}
