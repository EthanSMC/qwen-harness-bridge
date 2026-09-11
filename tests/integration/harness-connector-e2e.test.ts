import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import { CancelHandler } from "../../packages/harness-plugin/src/runtime/cancel-handler.js";
import { JobCommandCoordinator } from "../../packages/harness-plugin/src/runtime/job-command-coordinator.js";
import { JobStateClient } from "../../packages/harness-plugin/src/runtime/job-state-client.js";
import { OwnedAgentDriver } from "../../packages/harness-plugin/src/runtime/owned-agent-driver.js";
import { TerminalAuthorityIssuer } from "../../packages/harness-plugin/src/runtime/terminal-authority.js";
import { SqlitePluginStore } from "../../packages/harness-plugin/src/store/plugin-store.js";
import { DurableConnectorClient } from "../../packages/harness-plugin/src/transport/connector-client.js";
import { LOCALHOST_TLS } from "./support/tls.js";

/** Task 6 platform-independent acceptance: a Control-Plane offer is dispatched
 * through the composed command plane, cancelled through the same plane, and a
 * plugin restart on the same store never starts a second owned attempt. Native
 * redaction and policy classification paths are exercised by their own suites on
 * the Linux runner.
 */
it("drives one owned execution across a restart", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "qhb-e2e-")));
  const storePath = join(directory, "store.sqlite");
  const store = new SqlitePluginStore(storePath);
  const server = createServer(LOCALHOST_TLS);
  const wss = new WebSocketServer({ server });
  const lifecycle = new AbortController();
  const jobId = randomUUID();
  const leaseId = randomUUID();
  let sequence = 0;
  let cancelling = false;
  let creates = 0;
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
              expires_at: new Date(Date.now() + 60_000).toISOString(),
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
          lease_expires_at: new Date(observed + 30_000).toISOString(),
          expires_at: new Date(observed + 60_000).toISOString(),
          observed_at: new Date(observed).toISOString(),
          state_valid_until: new Date(observed + 2_000).toISOString(),
          request_message_id: request.message_id,
          request_sequence: request.sequence,
          nonce: request.payload.nonce,
        });
      }
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `wss://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const makePlane = () => {
    const client = new DurableConnectorClient({
      connectorId: randomUUID(),
      controlPlaneUrl: url,
      store,
      requireJobCoordination: true,
      requireOwnedTerminal: true,
      sessionTokenClient: {
        exchange: async () => ({
          token: "fixture",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      },
      bootstrapCredentialProvider: async () => "fixture",
      webSocketFactory: (target, options) =>
        new WebSocket(target, { ...options, ca: LOCALHOST_TLS.cert }),
    });
    const states = new JobStateClient({ connector: client });
    const authority = new TerminalAuthorityIssuer({
      connector: client,
      states,
      store,
    });
    const agents = {
      create: async (input: { sessionId: unknown }): Promise<AgentHandle> => {
        creates += 1;
        let captured: unknown;
        const agent = {
          id: String(input.sessionId),
          session: {
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
          } as unknown as Session,
          status: "running",
          followup: (message: unknown) => {
            captured = message;
          },
          cancel: () => undefined,
          whenIdle: async () => undefined,
        } as unknown as Agent;
        return {
          agent,
          dispose: async () => undefined,
        } as unknown as AgentHandle;
      },
    };
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
      publishClaim: async (offer) => {
        await client.publish(
          "job.claim",
          {
            job_id: offer.payload.job_id,
            attempt: offer.payload.attempt,
            lease_id: offer.payload.lease_id,
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
    return { client, states, driver, coordinator };
  };

  const offer = ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.offer",
    message_id: randomUUID(),
    sequence: 100,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    payload: {
      job_id: jobId,
      attempt: 1,
      repository_id: "example",
      lease_id: leaseId,
      request: "fixture request",
    },
  });
  const cancel = ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.cancel",
    message_id: randomUUID(),
    sequence: 90,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    payload: {
      job_id: jobId,
      attempt: 1,
      job_revision: 4,
      reason: "owner",
      nonce: randomUUID(),
    },
  });

  const first = makePlane();
  const running = first.client.start(lifecycle.signal).catch(() => undefined);
  try {
    const deadline = Date.now() + 3_000;
    while (!first.client.currentEpoch()) {
      if (Date.now() >= deadline) throw new Error("epoch timeout");
      await new Promise((resolve) => setImmediate(resolve));
    }
    store.recordInbound(
      offer.message_id,
      offer.sequence,
      JSON.stringify(offer),
    );
    await first.coordinator.handle(offer);
    expect(store.findJob(jobId)?.status).toBe("started");
    expect(creates).toBe(1);
    cancelling = true;
    await first.coordinator.handle(cancel);
    expect(store.findJob(jobId)?.status).toBe("cancelled");
    await first.driver.dispose();
    first.states.dispose();
  } finally {
    lifecycle.abort();
    await running;
  }

  // Restart on the same durable store: the owned intent refuses a second attempt.
  const second = makePlane();
  await second.driver.start(offer);
  expect(creates).toBe(1);
  expect(store.findJob(jobId)?.status).toBe("cancelled");
  await second.driver.dispose();
  second.states.dispose();

  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
