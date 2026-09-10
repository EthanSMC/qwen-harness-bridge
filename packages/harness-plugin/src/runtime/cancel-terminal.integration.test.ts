import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "../../../../tests/integration/support/tls.js";
import { SqlitePluginStore } from "../store/plugin-store.js";
import { DurableConnectorClient } from "../transport/connector-client.js";
import { CancelHandler, type CancellationOwner } from "./cancel-handler.js";
import { JobStateClient } from "./job-state-client.js";
import {
  beginTerminalAuthority,
  TerminalAuthorityIssuer,
} from "./terminal-authority.js";

it.each(["cancel", "result", "retry", "remote"] as const)(
  "actual CancelHandler shares the durable sink: %s",
  async (scenario) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "cancel-terminal-tls-")),
    );
    const path = join(directory, "store.sqlite");
    const store = new SqlitePluginStore(path);
    const raw = new Database(path);
    const server = createServer(LOCALHOST_TLS);
    const wss = new WebSocketServer({ server });
    const lifecycle = new AbortController();
    const operationLifetime = new AbortController();
    const normalWork = new AbortController();
    const jobId = randomUUID();
    let sequence = 0;
    let remote = false;
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
            status: remote ? "expired" : "cancelling",
            job_revision: 7,
            cancel_revision: 4,
            lease_id: null,
            lease_expires_at: null,
            expires_at: new Date(
              observed + (remote ? -1000 : 60000),
            ).toISOString(),
            observed_at: new Date(observed).toISOString(),
            state_valid_until: new Date(observed + 2000).toISOString(),
            request_message_id: request.message_id,
            request_sequence: request.sequence,
            nonce: request.payload.nonce,
          });
        }
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = new DurableConnectorClient({
      connectorId: randomUUID(),
      controlPlaneUrl: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
      store,
      requireJobCoordination: true,
      requireOwnedTerminal: true,
      redaction: { repositoryRoot: directory, homeDirectory: tmpdir() },
      sessionTokenClient: {
        exchange: async () => ({
          token: "fixture",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      },
      bootstrapCredentialProvider: async () => "fixture",
      webSocketFactory: (url, options) =>
        new WebSocket(url, { ...options, ca: LOCALHOST_TLS.cert }),
    });
    const running = client.start(lifecycle.signal).catch((error) => error);
    const states = new JobStateClient({ connector: client });
    const issuer = new TerminalAuthorityIssuer({
      connector: client,
      states,
      store,
    });
    try {
      const deadline = Date.now() + 2000;
      while (!client.currentEpoch()) {
        if (Date.now() >= deadline) throw new Error("epoch timeout");
        await new Promise((resolve) => setImmediate(resolve));
      }
      const offer = ConnectorServerMessageSchema.parse({
        protocol_version: "1.0",
        type: "job.offer",
        message_id: randomUUID(),
        sequence: ++sequence,
        correlation_id: randomUUID(),
        sent_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        payload: {
          job_id: jobId,
          attempt: 1,
          repository_id: "example",
          lease_id: randomUUID(),
          request: "fixture",
        },
      });
      if (offer.type !== "job.offer") throw new Error();
      const delivered = new Promise<void>((resolve) =>
        client.onCommand(async (command) => {
          if (command.message_id === offer.message_id) resolve();
        }),
      );
      for (const socket of wss.clients) socket.send(JSON.stringify(offer));
      await delivered;
      let record = store.prepareOwnedIntent({
        offer,
        sessionId: randomUUID(),
        ownerGeneration: randomUUID(),
        initialMessageId: "initial",
      });
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "creating",
        mode: "normal",
      });
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "submitting",
      });
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "started",
        evidence: {
          sessionId: record.owner.sessionId,
          messageId: record.initialMessageId,
          requestDigest: record.requestDigest,
          eventSequence: 0,
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
          reason: "fixture",
          nonce: randomUUID(),
        },
      });
      if (command.type !== "job.cancel") throw new Error();
      const binding = {
        owner: record.owner,
        expectedVersion: record.version,
        operation: { kind: "cancel" as const, cancelRevision: 4 },
      };
      const authority = await issuer.issue({
        ...binding,
        command,
        signal: operationLifetime.signal,
      });
      const resultBinding = {
        ...binding,
        operation: {
          kind: "native" as const,
          outcome: "succeeded" as const,
          eventSequence: 1,
        },
      };
      const resultAuthority =
        scenario === "result"
          ? await issuer.issue({
              ...resultBinding,
              signal: operationLifetime.signal,
            })
          : undefined;
      let cancellations = 0,
        aborts = 0;
      normalWork.signal.addEventListener("abort", () => aborts++);
      let status = "running";
      let terminalWork: Promise<unknown> = Promise.resolve();
      const agent = {
        get status() {
          return status;
        },
        cancel() {
          cancellations++;
          status = "idle";
          // Enlist synchronously, then drain the actual shared-client result commit.
          if (resultAuthority)
            terminalWork = Promise.resolve().then(() =>
              client.commitTerminal(resultBinding, resultAuthority, {
                summary: "Completed",
              }),
            );
        },
        whenIdle: async () => {},
      } as unknown as Agent;
      const owner: CancellationOwner = {
        jobId,
        attempt: 1,
        revision: 4,
        agent,
        approval: normalWork,
        isCurrent: () => !operationLifetime.signal.aborted,
        hasTerminal: () => store.readTerminal(record.owner)?.kind === "local",
        drainTerminals: async () => {
          await terminalWork;
        },
        commitCancelled: () => {
          const result = client.commitTerminal(binding, authority);
          if (result.kind === "remote")
            throw new Error("CONNECTOR_TERMINAL_RECONCILIATION_REQUIRED");
          return result.kind === "committed" || result.relation === "same";
        },
      };
      const handler = new CancelHandler({
        resolveOwner: () => owner,
        beforeCancel: () => {
          beginTerminalAuthority(authority, binding);
          normalWork.abort();
          return undefined;
        },
      });
      let reached = 0;
      if (scenario === "retry") {
        (store as unknown as { database: Database.Database }).database.function(
          "cancel_fail",
          () => {
            reached++;
            return 1;
          },
        );
        raw.exec(
          "CREATE TRIGGER cancel_fail AFTER INSERT ON outbound_events WHEN json_extract(NEW.payload_json, '$.type') = 'job.cancelled' BEGIN SELECT cancel_fail(); SELECT RAISE(ABORT, 'fixture'); END",
        );
        expect(await handler.handle(command)).toBe("unavailable");
        expect(reached).toBe(1);
        expect(store.readTerminal(record.owner)).toBeUndefined();
        raw.exec("DROP TRIGGER cancel_fail");
      }
      if (scenario === "remote") {
        remote = true;
        const reconciliation = {
          ...binding,
          operation: { kind: "reconcile" as const },
        };
        const remoteAuthority = await issuer.issue({
          ...reconciliation,
          signal: operationLifetime.signal,
        });
        const before = store.maxOutboundSequence();
        expect(
          client.reconcileTerminal(reconciliation, remoteAuthority).kind,
        ).toBe("reconciled");
        expect(store.maxOutboundSequence()).toBe(before);
      }
      expect(await handler.handle(command)).toBe(
        scenario === "result"
          ? "terminal"
          : scenario === "remote"
            ? "unavailable"
            : "cancelled",
      );
      expect(cancellations).toBe(1);
      expect(aborts).toBe(1);
      expect(operationLifetime.signal.aborted).toBe(false);
      expect(store.findJob(jobId)?.status).toBe(
        scenario === "result"
          ? "succeeded"
          : scenario === "remote"
            ? "expired"
            : "cancelled",
      );
      if (scenario !== "remote")
        expect(await handler.handle(command)).toBe("terminal");
      expect(cancellations).toBe(1);
    } finally {
      issuer.dispose();
      states.dispose();
      lifecycle.abort();
      await running;
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      raw.close();
      store.close();
    }
  },
);
