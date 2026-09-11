import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { LOCALHOST_TLS } from "../../../../tests/integration/support/tls.js";
import { JobStateClient } from "../runtime/job-state-client.js";
import { TerminalAuthorityIssuer } from "../runtime/terminal-authority.js";
import { SqlitePluginStore } from "../store/plugin-store.js";
import {
  type ConnectorClientOptions,
  DurableConnectorClient,
} from "./connector-client.js";

it.each([
  "normal",
  "failed",
  "uncertain",
  "reentrant",
  "exhausted",
  "options",
  "accessors",
  "invalid-projection",
  "generic-profiled",
  "generic-legacy",
  "generic-profiled-raw-race",
  "generic-legacy-raw-race",
] as const)(
  "live shared terminal persistence and delivery: %s",
  async (scenario) => {
    const legacy = scenario.startsWith("generic-legacy");
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "owned-terminal-tls-")),
    );
    const store = new SqlitePluginStore(join(directory, "store.sqlite"));
    let receivingStore = store;
    const connectorId = randomUUID();
    const server = createServer(LOCALHOST_TLS);
    const wss = new WebSocketServer({ server });
    const controller = new AbortController();
    const frames: ConnectorClientMessage[] = [];
    const jobId = randomUUID();
    if (scenario === "exhausted") {
      const messageId = randomUUID();
      const sequence = Number.MAX_SAFE_INTEGER - 8;
      store.enqueueEvent({
        messageId,
        sequence,
        payload: JSON.stringify({
          protocol_version: "1.0",
          type: "job.event",
          message_id: messageId,
          sequence,
          correlation_id: randomUUID(),
          sent_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
          payload: {
            job_id: randomUUID(),
            attempt: 1,
            event_type: "progress",
            source: "harness",
            payload: { summary: "Retained history" },
          },
        }),
      });
      store.acknowledgeEvent(messageId);
    }
    let sequence = 0;
    let persistedAtSend = false;
    wss.on("connection", (socket) =>
      socket.on("message", (bytes) => {
        const request = ConnectorClientMessageSchema.parse(
          JSON.parse(bytes.toString()),
        );
        frames.push(request);
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
            capabilities: legacy
              ? ["durable-receipts-v1"]
              : ["durable-receipts-v1", "job-coordination-v1"],
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
            status: "running",
            job_revision: 2,
            cancel_revision: null,
            lease_id: null,
            lease_expires_at: null,
            expires_at: new Date(observed + 60000).toISOString(),
            observed_at: new Date(observed).toISOString(),
            state_valid_until: new Date(observed + 2000).toISOString(),
            request_message_id: request.message_id,
            request_sequence: request.sequence,
            nonce: request.payload.nonce,
          });
        }
        if (request.type === "job.event")
          persistedAtSend =
            receivingStore.findJob(jobId)?.status === "succeeded" &&
            receivingStore.outboundEvent(request.sequence)?.messageId ===
              request.message_id;
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const allocations = { uuid: 0, clock: 0, factory: 0 };
    let onUUID = () => {};
    const clientOptions: ConnectorClientOptions = {
      connectorId,
      controlPlaneUrl: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
      store,
      requireJobCoordination: !legacy,
      requireOwnedTerminal: !legacy,
      now: () => {
        allocations.clock++;
        return new Date();
      },
      randomUUID: () => {
        allocations.uuid++;
        onUUID();
        return randomUUID();
      },
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
    };
    const reads: Record<string, number> = {};
    let sourceSecrets: string[] | undefined;
    if (scenario === "accessors") {
      sourceSecrets = ["synthetic-sentinel-unique"];
      const redaction = {
        repositoryRoot: directory,
        homeDirectory: tmpdir(),
        secrets: sourceSecrets,
      };
      for (const key of Object.keys(redaction) as (keyof typeof redaction)[]) {
        const value = redaction[key];
        Object.defineProperty(redaction, key, {
          enumerable: true,
          get() {
            reads[key] = (reads[key] ?? 0) + 1;
            return key === "secrets" && reads[key] > 1 ? [] : value;
          },
        });
      }
      Object.assign(clientOptions, { redaction });
      Object.assign(clientOptions, {
        capabilities: ["harness", "replay"],
        connectorVersion: "fixture",
        random: undefined,
        reconnectDelay: undefined,
      });
      for (const key of Object.keys(
        clientOptions,
      ) as (keyof ConnectorClientOptions)[]) {
        const value = clientOptions[key];
        Object.defineProperty(clientOptions, key, {
          enumerable: true,
          get() {
            reads[key] = (reads[key] ?? 0) + 1;
            return value;
          },
        });
      }
    }
    const client = new DurableConnectorClient(clientOptions);
    sourceSecrets?.splice(0);
    if (scenario === "options") {
      Object.assign(clientOptions, { requireOwnedTerminal: false });
      Object.assign(clientOptions.redaction ?? {}, {
        repositoryRoot: "not canonical",
      });
    }
    const running = client.start(controller.signal).catch((error) => error);
    const states = new JobStateClient({ connector: client });
    const issuer = new TerminalAuthorityIssuer({
      connector: client,
      states,
      store,
    });
    try {
      const deadline = Date.now() + 2000;
      while (
        legacy
          ? !frames.some((frame) => frame.type === "connector.hello")
          : !client.currentEpoch()
      ) {
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
      const binding = {
        owner: record.owner,
        expectedVersion: record.version,
        operation: {
          kind: "native" as const,
          outcome: "succeeded" as const,
          eventSequence: 1,
        },
      };
      const db = (store as unknown as { database: Database.Database }).database;
      const snapshot = () =>
        ["metadata", "job_mappings", "inbound_messages", "outbound_events"].map(
          (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      if (scenario.startsWith("generic-")) {
        // Command delivery resolves before the receive pump has persisted/sent
        // its ACK. Measure operation deltas only after that fixture work drains.
        const ackDeadline = Date.now() + 2000;
        while (
          !frames.some(
            (frame) =>
              frame.type === "ack" && frame.payload.sequence === offer.sequence,
          )
        ) {
          if (Date.now() >= ackDeadline) throw new Error("offer ACK timeout");
          await new Promise((resolve) => setImmediate(resolve));
        }
        const before = snapshot();
        const counts = { ...allocations };
        const messages = [
          "succeeded",
          "success",
          "completed",
          "job.succeeded",
          "failed",
          "failure",
          "job.failed",
          "cancelled",
          "canceled",
          "job.cancelled",
          "JOB.SUCCEEDED",
          " completed ",
          "completed\n",
          "unknown",
          " progress.updated ",
          "stage.changed\n",
          "\ttool.started",
          "tool.finished\u2028",
        ].map((event_type) => ({
          job_id: jobId,
          attempt: 1,
          event_type,
          source: "harness",
          payload: { summary: "Progress" },
        }));
        for (const status of ["failed", "running", null, 0, false, {}])
          messages.push({
            job_id: jobId,
            attempt: 1,
            event_type: "progress.updated",
            source: "harness",
            payload: { summary: "Progress", status },
          } as never);
        for (const payload of messages)
          await expect(
            client.publish("job.event", payload, randomUUID()),
          ).rejects.toThrow("OWNED_INTENT_CONFLICT");
        await expect(
          client.publish(
            "job.event",
            {
              job_id: jobId,
              attempt: 1,
              event_type: "progress.updated",
              source: "harness",
              payload: Object.defineProperty(
                { summary: "Progress" },
                "status",
                { value: "failed" },
              ),
            },
            randomUUID(),
          ),
        ).rejects.toThrow();
        await expect(
          client.publish(
            "job.cancelled",
            { job_id: jobId, attempt: 1, reason: "Cancelled by owner" },
            randomUUID(),
          ),
        ).rejects.toThrow("OWNED_INTENT_CONFLICT");
        expect(allocations).toEqual(counts);
        expect(snapshot()).toEqual(before);
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          frames.filter(
            (frame) =>
              frame.type === "job.event" || frame.type === "job.cancelled",
          ),
        ).toEqual([]);
        for (const event_type of [
          "stage.changed",
          "progress.updated",
          "tool.started",
          "tool.finished",
        ]) {
          let reads = 0;
          const business = { summary: "Progress" };
          const payload = {
            job_id: jobId,
            attempt: 1,
            source: "harness",
            get event_type() {
              reads++;
              return reads === 1 ? event_type : "completed";
            },
            payload: business,
          };
          onUUID = () => Object.assign(business, { status: "failed" });
          const previous = store.maxOutboundSequence();
          await client.publish("job.event", payload, randomUUID());
          onUUID = () => {};
          expect(reads).toBe(1);
          const retained = store.outboundEvent(previous + 1);
          expect(retained?.expectedReceiptProfile).toBe(
            legacy ? undefined : "job-coordination-v1",
          );
          expect(
            JSON.parse(retained?.payload ?? "null").payload.payload,
          ).toEqual({ summary: "Progress" });
        }
        for (const event_type of [
          " progress.updated ",
          "stage.changed\n",
          "\ttool.started",
          "tool.finished\u2028",
        ]) {
          const previous = store.maxOutboundSequence();
          await client.publish(
            "job.event",
            {
              job_id: randomUUID(),
              attempt: 1,
              event_type,
              source: "harness",
              payload: { summary: "Legacy progress" },
            },
            randomUUID(),
          );
          const retained = store.outboundEvent(previous + 1);
          expect(
            JSON.parse(retained?.payload ?? "null").payload.event_type,
          ).toBe(event_type);
          const sentDeadline = Date.now() + 2000;
          while (
            !frames.some((frame) => frame.message_id === retained?.messageId)
          ) {
            if (Date.now() >= sentDeadline)
              throw new Error("legacy progress send timeout");
            await new Promise((resolve) => setImmediate(resolve));
          }
          const frame = frames.find(
            (frame) => frame.message_id === retained?.messageId,
          );
          expect(frame?.payload).toMatchObject({
            event_type: event_type.trim(),
          });
        }
        await client.publish(
          "job.event",
          {
            job_id: randomUUID(),
            attempt: 1,
            event_type: "completed",
            source: "harness",
            payload: { summary: "Legacy", status: "failed" },
          },
          randomUUID(),
        );
        // A preflight for an unowned attempt is not permission to insert after
        // the allocator callback creates its durable owner.
        const nextOffer = {
          ...offer,
          message_id: randomUUID(),
          sequence: ++sequence,
          payload: { ...offer.payload, job_id: randomUUID() },
        };
        const nextDelivered = new Promise<void>((resolve) =>
          client.onCommand(async (command) => {
            if (command.message_id === nextOffer.message_id) resolve();
          }),
        );
        for (const socket of wss.clients)
          socket.send(JSON.stringify(nextOffer));
        await nextDelivered;
        const nextDeadline = Date.now() + 2000;
        while (
          !frames.some(
            (frame) =>
              frame.type === "ack" &&
              frame.payload.sequence === nextOffer.sequence,
          )
        ) {
          if (Date.now() >= nextDeadline) throw new Error("next ACK timeout");
          await new Promise((resolve) => setImmediate(resolve));
        }
        let afterOwnership: ReturnType<typeof snapshot> | undefined;
        onUUID = () => {
          store.prepareOwnedIntent({
            offer: nextOffer,
            sessionId: randomUUID(),
            ownerGeneration: randomUUID(),
            initialMessageId: "next",
          });
          afterOwnership = snapshot();
        };
        const previous = store.maxOutboundSequence();
        await expect(
          client.publish(
            "job.event",
            {
              job_id: nextOffer.payload.job_id,
              attempt: 1,
              event_type: scenario.endsWith("raw-race")
                ? " progress.updated "
                : "completed",
              source: "harness",
              payload: { summary: "Race" },
            },
            randomUUID(),
          ),
        ).rejects.toThrow();
        onUUID = () => {};
        expect(afterOwnership).toBeDefined();
        expect(snapshot()).toEqual(afterOwnership);
        expect(store.maxOutboundSequence()).toBe(previous);
        if (!legacy) {
          // Existing coordinated generic write failures deliberately fail-stop.
          expect(client.currentEpoch()).toBeUndefined();
          await expect(
            client.publish("job.event", {}, randomUUID()),
          ).rejects.toThrow("CONNECTOR_STOPPED");
          return;
        }
        await client.publish(
          "job.event",
          {
            job_id: nextOffer.payload.job_id,
            attempt: 1,
            event_type: "progress.updated",
            source: "harness",
            payload: { summary: "Progress" },
          },
          randomUUID(),
        );
        expect(store.maxOutboundSequence()).toBe(previous + 1);
        return;
      }
      const authority = await issuer.issue({
        ...binding,
        signal: controller.signal,
      });
      if (scenario === "invalid-projection") {
        const commit = store.commitTerminal.bind(store);
        store.commitTerminal = (proposal, token, factory) =>
          commit(proposal, token, () => {
            allocations.factory++;
            return factory();
          });
        const before = snapshot();
        const counts = { ...allocations };
        const previous = store.maxOutboundSequence();
        for (const projection of [
          {},
          { summary: 1 },
          { summary: "Done", tests: { passed: -1, failed: 0 } },
          { summary: "Done", stage: "INVALID" },
        ]) {
          expect(() =>
            client.commitTerminal(binding, authority, projection),
          ).toThrow("CONNECTOR_EVENT_REJECTED");
          expect(allocations).toEqual(counts);
          expect(snapshot()).toEqual(before);
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(frames.filter((frame) => frame.type === "job.event")).toEqual(
          [],
        );
        expect(store.maxOutboundSequence()).toBe(previous);
      }
      if (scenario === "failed") {
        let reached = 0;
        db.function("terminal_failure", () => {
          reached++;
          return 1;
        });
        db.exec(
          "CREATE TRIGGER terminal_failure AFTER INSERT ON outbound_events WHEN json_extract(NEW.payload_json, '$.type') = 'job.event' BEGIN SELECT terminal_failure(); SELECT RAISE(ABORT, 'fixture'); END",
        );
        const before = snapshot();
        expect(() =>
          client.commitTerminal(binding, authority, {
            summary: "Bearer secret-fixture",
          }),
        ).toThrow();
        expect(reached).toBe(1);
        expect(snapshot()).toEqual(before);
        expect(frames.filter((frame) => frame.type === "job.event")).toEqual(
          [],
        );
        db.exec("DROP TRIGGER terminal_failure");
      }
      if (scenario === "uncertain") {
        const commit = store.commitTerminal.bind(store);
        store.commitTerminal = (...args) => {
          commit(...args);
          throw new Error("fixture after commit");
        };
        expect(() =>
          client.commitTerminal(binding, authority, {
            summary: "Bearer secret-fixture",
          }),
        ).toThrow("CONNECTOR_TERMINAL_COMMIT_UNCERTAIN");
        expect(client.currentEpoch()).toBeUndefined();
        await expect(
          client.publish("job.event", {}, randomUUID()),
        ).rejects.toThrow("CONNECTOR_STOPPED");
        const winner = store.readTerminal(record.owner);
        expect(winner?.kind).toBe("local");
        expect(frames.filter((frame) => frame.type === "job.event")).toEqual(
          [],
        );
        controller.abort();
        await running;
        store.close();
        const reopened = new SqlitePluginStore(join(directory, "store.sqlite"));
        receivingStore = reopened;
        const restartLifetime = new AbortController();
        const restart = new DurableConnectorClient({
          connectorId,
          controlPlaneUrl: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
          store: reopened,
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
        const replaying = restart
          .start(restartLifetime.signal)
          .catch((error) => error);
        try {
          expect(reopened.readTerminal(record.owner)).toEqual(winner);
          expect(
            reopened
              .pendingEvents(0)
              .some(
                (event) =>
                  winner?.kind === "local" &&
                  event.messageId === winner.outbound.messageId,
              ),
          ).toBe(true);
          const replayDeadline = Date.now() + 2000;
          while (
            !frames.some(
              (frame) =>
                winner?.kind === "local" &&
                frame.message_id === winner.outbound.messageId,
            )
          ) {
            if (Date.now() >= replayDeadline)
              throw new Error("terminal replay timeout");
            await new Promise((resolve) => setImmediate(resolve));
          }
          expect(
            frames.filter(
              (frame) =>
                winner?.kind === "local" &&
                frame.message_id === winner.outbound.messageId,
            ),
          ).toHaveLength(1);
        } finally {
          restartLifetime.abort();
          await replaying;
          reopened.close();
        }
        return;
      }
      if (scenario === "reentrant") {
        const commit = store.commitTerminal.bind(store);
        store.commitTerminal = (proposal, token, factory) =>
          commit(proposal, token, () => {
            expect(() =>
              client.commitTerminal(binding, authority, { summary: "nested" }),
            ).toThrow("CONNECTOR_ALLOCATION_REENTRANT");
            expect(() =>
              client.publishSync(
                { job_id: jobId, attempt: 1, nonce: randomUUID() },
                randomUUID(),
                () => undefined,
              ),
            ).toThrow("CONNECTOR_ALLOCATION_REENTRANT");
            return factory();
          });
      }
      const result = client.commitTerminal(binding, authority, {
        summary:
          scenario === "accessors"
            ? "synthetic-sentinel-unique"
            : "Bearer secret-fixture",
      });
      expect(result).toMatchObject({
        kind: "committed",
        winner: { payload: { payload: { summary: "[redacted]" } } },
      });
      if (result.kind !== "committed") throw new Error();
      if (scenario === "accessors")
        expect(Object.values(reads)).toEqual(Object.values(reads).map(() => 1));
      const winner = result.winner;
      const sentDeadline = Date.now() + 2000;
      while (
        !frames.some((frame) => frame.message_id === winner.outbound.messageId)
      ) {
        if (Date.now() >= sentDeadline) throw new Error("send timeout");
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(persistedAtSend).toBe(true);
      store.renewDelivery(
        winner.outbound.sequence,
        new Date(Date.now() + 120000).toISOString(),
      );
      store.acknowledgeEvent(winner.outbound.messageId);
      if (scenario === "exhausted") {
        while (store.maxOutboundSequence() < Number.MAX_SAFE_INTEGER)
          await client.publish(
            "job.event",
            {
              job_id: randomUUID(),
              attempt: 1,
              event_type: "progress",
              source: "harness",
              payload: { summary: "Progress" },
            },
            randomUUID(),
          );
        await expect(
          client.publish("job.event", {}, randomUUID()),
        ).rejects.toThrow("CONNECTOR_SEQUENCE_EXHAUSTED");
      }
      const before = store.maxOutboundSequence();
      expect(
        client.commitTerminal(binding, authority, {
          summary: "Bearer secret-fixture",
        }),
      ).toMatchObject({ kind: "existing", relation: "same" });
      expect(store.maxOutboundSequence()).toBe(before);
      expect(store.readTerminal(record.owner)).toEqual(winner);
      if (scenario === "normal") {
        const retained = store.outboundEvent(winner.outbound.sequence);
        store.close();
        const reopened = new SqlitePluginStore(join(directory, "store.sqlite"));
        receivingStore = reopened;
        try {
          // Same live original capability across a store reopen is a retry,
          // distinct from the separate stopped-client restart/replay case.
          expect(
            reopened.commitTerminal(
              {
                binding,
                type: winner.type,
                correlationId: winner.correlationId,
                payload: winner.payload,
              },
              authority,
              () => {
                throw new Error("retry allocated");
              },
            ),
          ).toMatchObject({ kind: "existing", relation: "same" });
          issuer.dispose();
          controller.abort();
          await running;
          expect(reopened.readTerminal(record.owner)).toEqual(winner);
          expect(reopened.outboundEvent(winner.outbound.sequence)).toEqual(
            retained,
          );
        } finally {
          reopened.close();
        }
      }
    } finally {
      issuer.dispose();
      states.dispose();
      controller.abort();
      await running;
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  },
);
