import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { JobCommandCoordinator } from "../../packages/harness-plugin/src/runtime/job-command-coordinator.js";
import { JobStateClient } from "../../packages/harness-plugin/src/runtime/job-state-client.js";
import { OwnedAgentDriver } from "../../packages/harness-plugin/src/runtime/owned-agent-driver.js";
import { TerminalAuthorityIssuer } from "../../packages/harness-plugin/src/runtime/terminal-authority.js";
import { SqlitePluginStore } from "../../packages/harness-plugin/src/store/plugin-store.js";
import { DurableConnectorClient } from "../../packages/harness-plugin/src/transport/connector-client.js";
import { HttpsSessionTokenClient } from "../../packages/harness-plugin/src/transport/session-token-client.js";
import { startLoopbackControlPlane } from "./support/loopback-control-plane.js";

/** Transport-level rehearsal of the packaged connector against a loopback
 * Control Plane: the real session-token exchange, the real WebSocket client, a
 * mid-run socket kill, and the rule that no credential material reaches the
 * wire. The job lifecycle itself is driven by the packaged live rehearsal. */
it("authenticates, survives a socket kill and keeps credentials off the wire", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "qhb-loopback-")));
  const store = new SqlitePluginStore(join(directory, "store.sqlite"));
  const plane = await startLoopbackControlPlane();
  const sentinel = "loopback-credential-sentinel-8f2a41";
  const lifecycle = new AbortController();
  const connectorId = randomUUID();

  const tokenClient = new HttpsSessionTokenClient({
    endpoint: plane.sessionEndpoint,
    credentialId: "qhb-connector-bootstrap",
    request: (options, body, signal) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          { ...options, ca: plane.ca },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () =>
              resolve({
                statusCode: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            response.once("error", reject);
          },
        );
        request.once("error", reject);
        if (signal) {
          signal.addEventListener("abort", () => request.destroy(), {
            once: true,
          });
        }
        request.end(body);
      }),
  });

  const client = new DurableConnectorClient({
    connectorId,
    controlPlaneUrl: plane.url,
    store,
    requireJobCoordination: true,
    requireOwnedTerminal: true,
    sessionTokenClient: tokenClient,
    bootstrapCredentialProvider: async () => sentinel,
    webSocketFactory: (target, options) =>
      new WebSocket(target, { ...options, ca: plane.ca }),
  });

  const running = client.start(lifecycle.signal);
  try {
    await plane.waitForInbound("connector.hello");
    expect(plane.tokenRequests).toEqual([
      {
        connectorId,
        credentialId: "qhb-connector-bootstrap",
        credentialSecret: sentinel,
      },
    ]);

    // The package id and credential id travel; the credential value never does.
    for (const frame of plane.inbound) {
      expect(frame.raw).not.toContain(sentinel);
    }
    for (const frame of plane.outbound) {
      expect(frame.raw).not.toContain(sentinel);
    }

    // Mid-run socket kill: the connector reconnects and identifies itself again.
    const firstHello = plane.inbound.findIndex(
      (frame) => frame.type === "connector.hello",
    );
    plane.killSockets();
    await plane.waitForConnection(2);
    const secondHello = await plane.waitForInbound("connector.hello", {
      after: firstHello + 1,
      timeoutMs: 10_000,
    });
    expect(secondHello.message.type).toBe("connector.hello");
    expect(
      plane.outbound.filter((f) => f.type === "connector.welcome"),
    ).toHaveLength(2);
  } finally {
    lifecycle.abort();
    await running.catch(() => undefined);
    await plane.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
/** Wires the real composed command plane onto a loopback client. */
const wireOwnedExecution = ({
  plane,
  directory,
  store,
  client,
}: {
  plane: Awaited<ReturnType<typeof startLoopbackControlPlane>>;
  directory: string;
  store: SqlitePluginStore;
  client: DurableConnectorClient;
}) => {
  let creates = 0;
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
  const resolveRepository = (id: string) =>
    id === plane.state.repositoryId ? directory : undefined;
  const driver = new OwnedAgentDriver({
    agents,
    store,
    states,
    authority,
    terminal: client,
    epoch: () => client.currentEpoch(),
    repositories: { resolve: resolveRepository },
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
  const coordinator = new JobCommandCoordinator({
    starter: driver,
    cancel: { handle: async () => "ignored" },
    approvals: { acceptDecision: () => "ignored" },
    repositories: { resolve: resolveRepository },
  });
  const unsubscribe = client.onCommand((command) =>
    coordinator.handle(command),
  );
  return { unsubscribe, creates: () => creates };
};

const frameIdentity = (frame: { message: unknown }) => {
  const message = frame.message as { message_id: string; sequence: number };
  return { messageId: message.message_id, sequence: message.sequence };
};

/** Ordered replay: an unacknowledged durable claim must be re-sent with its
 * original identity after a mid-run socket kill, never reallocated. */
it("replays an unacknowledged claim after a socket kill", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "qhb-replay-")));
  const store = new SqlitePluginStore(join(directory, "store.sqlite"));
  const plane = await startLoopbackControlPlane();
  const lifecycle = new AbortController();
  const client = new DurableConnectorClient({
    connectorId: randomUUID(),
    controlPlaneUrl: plane.url,
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
      new WebSocket(target, { ...options, ca: plane.ca }),
  });
  const wired = wireOwnedExecution({ plane, directory, store, client });
  const running = client.start(lifecycle.signal);
  try {
    await plane.waitForInbound("connector.hello");
    plane.sendOffer();
    const firstClaim = await plane.waitForInbound("job.claim", {
      timeoutMs: 15_000,
    });
    plane.killSockets();
    await plane.waitForConnection(2);
    const replayed = await plane.waitForInbound("job.claim", {
      after: plane.inbound.indexOf(firstClaim) + 1,
      timeoutMs: 15_000,
    });
    expect(frameIdentity(replayed)).toEqual(frameIdentity(firstClaim));
    // The replay proves the transport re-sends the same durable frame. It does
    // not require admission to stay blocked: a coordination response may now
    // resolve its waiter before the pump records it.
    expect(wired.creates()).toBeLessThanOrEqual(1);
    expect(
      new Set(
        plane.inbound
          .filter((frame) => frame.type === "job.claim")
          .map((frame) => frameIdentity(frame).messageId),
      ).size,
    ).toBe(1);
  } finally {
    wired.unsubscribe();
    lifecycle.abort();
    await running.catch(() => undefined);
    await plane.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
/** Reproduces a blocking transport defect found by the live rehearsal.
 *
 * The connector's receive pump serializes inbound frames and awaits every
 * command handler. `JobCommandCoordinator.handle` awaits
 * `OwnedAgentDriver.start`, whose admission performs `states.observe` and
 * therefore needs the Control Plane's `job.state` response. That response can
 * only be delivered by the same receive pump, which is still awaiting the
 * offer handler, so admission cannot complete: the coordination waiter expires
 * after 2 s, `admit` returns undefined, and no Agent is created. The in-process
 * `harness-connector-e2e.test.ts` never sees this because it invokes
 * `coordinator.handle` directly instead of through the transport.
 *
 * The transport takes a coordination `job.state` response off the socket and
 * runs its durable pass ahead of the pump whenever the request it answers was
 * published by the command handler the pump is awaiting. The offer handler can
 * therefore complete admission, and the frame is still recorded in order.
 */
it("admits a socket-delivered offer without blocking the receive pump", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "qhb-admit-")));
  const store = new SqlitePluginStore(join(directory, "store.sqlite"));
  const plane = await startLoopbackControlPlane();
  plane.setAcknowledge(true);
  const lifecycle = new AbortController();
  const client = new DurableConnectorClient({
    connectorId: randomUUID(),
    controlPlaneUrl: plane.url,
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
      new WebSocket(target, { ...options, ca: plane.ca }),
  });
  const wired = wireOwnedExecution({ plane, directory, store, client });
  const running = client.start(lifecycle.signal);
  try {
    await plane.waitForInbound("connector.hello");
    plane.sendOffer();
    const deadline = Date.now() + 6_000;
    while (wired.creates() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      wired.creates(),
      `inbound=${plane.inbound.map((f) => f.type).join(",")} outbound=${plane.outbound.map((f) => f.type).join(",")}`,
    ).toBe(1);
  } finally {
    wired.unsubscribe();
    lifecycle.abort();
    await running.catch(() => undefined);
    await plane.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
