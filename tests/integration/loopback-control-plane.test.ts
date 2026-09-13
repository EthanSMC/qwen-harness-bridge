import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
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
