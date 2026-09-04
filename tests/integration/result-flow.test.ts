import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import {
  Aes256GcmEncryptor,
  JobCoordinator,
} from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import { FakeConnector } from "./support/fake-connector.js";
import { createTestDatabase } from "./support/postgres.js";
import { LOCALHOST_TLS } from "./support/tls.js";

const db = createTestDatabase();

type ProductionMcpConnection = {
  client: Client;
  server: ReturnType<typeof createMcpServer>;
};

type ResultFixture = {
  app: Awaited<ReturnType<typeof createApp>>;
  connector: FakeConnector;
  coordinator: JobCoordinator;
  mcp: ProductionMcpConnection;
  ownerId: string;
  repositoryId: string;
};

const connectProductionMcp = async (
  coordinator: JobCoordinator,
  ownerId: string,
): Promise<ProductionMcpConnection> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ coordinator, ownerId });
  const client = new Client({
    name: "qhb-result-integration-client",
    version: "1.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const closeProductionMcp = async (
  connection: ProductionMcpConnection,
): Promise<void> => {
  await Promise.allSettled([
    connection.client.close(),
    connection.server.close(),
  ]);
};

const startResultFixture = async (): Promise<ResultFixture> => {
  const ownerId = `result-owner-${crypto.randomUUID()}`;
  const repositoryId = `result-repo-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const connectorId = crypto.randomUUID();
  const credentialId = `result-credential-${crypto.randomUUID()}`;
  const credentialSecret = `result-connector-secret-${crypto.randomUUID()}`;
  await db.query(
    "INSERT INTO owners (id, display_name) VALUES ($1, 'result integration owner')",
    [ownerId],
  );
  await db.query(
    `
      INSERT INTO repository_policies
        (id, owner_id, display_name, canonical_path, allowed_action_classes)
      VALUES ($1, $2, 'Result integration repository',
        '/tmp/qhb-integration-repository',
        '["automatic", "approval_required"]'::jsonb)
    `,
    [repositoryId, ownerId],
  );
  await db.query(
    `
      INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
      VALUES ($1, $2, $3, $4)
    `,
    [
      connectorId,
      ownerId,
      credentialId,
      await hashConnectorCredential(credentialSecret),
    ],
  );

  const repository = new JobRepository(db.client);
  const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(7));
  const coordinator = new JobCoordinator({
    repository,
    encryptor: cipher,
    now: () => new Date(),
  });
  const app = await createApp({
    coordinator,
    ownerId,
    mcpBearerToken: "result-mcp-bearer-fixture-only",
    https: LOCALHOST_TLS,
    connectorGateway: {
      database: db.client,
      sessionSigningKey: "result-connector-session-signing-key-with-32-bytes",
      requestDecryptor: cipher,
      dispatchIntervalMs: 10,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const connector = await FakeConnector.connect(app, {
    connector_id: connectorId,
    credential_id: credentialId,
    credential_secret: credentialSecret,
  });
  const mcp = await connectProductionMcp(coordinator, ownerId);
  return { app, connector, coordinator, mcp, ownerId, repositoryId };
};

const closeResultFixture = async (fixture: ResultFixture): Promise<void> => {
  await Promise.allSettled([
    closeProductionMcp(fixture.mcp),
    fixture.connector.close(),
  ]);
  await fixture.app.close();
};

const nextAckFor = async (connector: FakeConnector, clientSequence: number) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ack = await connector.next("ack");
    if (ack.payload.sequence === clientSequence) return ack;
  }
  throw new Error(
    `Timed out waiting for ACK of client sequence ${clientSequence}`,
  );
};

const waitForCondition = async <T>(
  read: () => T | undefined,
  description: string,
): Promise<T> => {
  const timeoutMs = 3_000;
  const intervalMs = 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
};

const waitForWireOccurrences = async (
  connector: FakeConnector,
  messageId: string,
  expected: number,
): Promise<void> => {
  await waitForCondition(
    () =>
      connector.wireReceived.filter(
        (message) => message.message_id === messageId,
      ).length >= expected || undefined,
    `${expected} wire deliveries`,
  );
};

const submitAndClaim = async (fixture: ResultFixture) => {
  const receipt = await fixture.mcp.client.callTool({
    name: "submit_task",
    arguments: {
      client_request_id: crypto.randomUUID(),
      repository_id: fixture.repositoryId,
      request: "Run the terminal result integration flow",
      mode: "normal",
    },
  });
  expect(receipt.isError).not.toBe(true);
  const content = receipt.structuredContent as {
    job_id: string;
    short_id: string;
  };
  const offer = await fixture.connector.next("job.offer");
  expect(offer.payload.job_id).toBe(content.job_id);
  expect(offer.payload.request).toBe(
    "Run the terminal result integration flow",
  );

  const claim = await fixture.connector.send("job.claim", {
    job_id: content.job_id,
    attempt: offer.payload.attempt,
    lease_id: offer.payload.lease_id,
  });
  const claimAck = await nextAckFor(fixture.connector, claim.sequence);
  expect(claimAck.payload.sequence).toBe(claim.sequence);
  return { ...content, offer };
};

const sendTerminalResult = async (
  fixture: ResultFixture,
  job: Awaited<ReturnType<typeof submitAndClaim>>,
  payload: Record<string, unknown>,
) => {
  const event = await fixture.connector.send("job.event", {
    job_id: job.job_id,
    attempt: job.offer.payload.attempt,
    event_type: "job.succeeded",
    payload,
    source: "fake-connector",
  });
  const ack = await nextAckFor(fixture.connector, event.sequence);
  expect(ack.payload.sequence).toBe(event.sequence);
  return { event, ack };
};

const submitTerminalResult = async (
  fixture: ResultFixture,
  payload: Record<string, unknown>,
) => {
  const job = await submitAndClaim(fixture);
  const terminal = await sendTerminalResult(fixture, job, payload);
  return { job, terminal };
};

const resultPayload = (): Record<string, unknown> => ({
  status: "succeeded",
  summary: "const result = 'completed without exposing source';",
  changed_files: [
    "src/index.ts",
    "src/worker.ts",
    "src/result.ts",
    "README.md",
    "package.json",
    "src/ignored-sixth.ts",
  ],
  tests: {
    passed: 8,
    failed: 0,
    summary: "8 passed; const report = 'private';",
  },
  artifacts: [
    {
      name: "Public report",
      media_type: "text/html",
      url: "https://example.test/result-report",
    },
  ],
});

beforeAll(async () => {
  await db.start();
});

afterAll(async () => {
  await db.stop();
});

describe("authenticated Connector terminal results through production MCP", () => {
  it("waits for a condition beyond 200 event-loop turns", async () => {
    let turns = 0;
    let ready = false;
    const producer = (async () => {
      while (turns < 250) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        turns += 1;
      }
      ready = true;
    })();
    try {
      await expect(
        waitForCondition(
          () => (ready ? turns : undefined),
          "delayed condition",
        ),
      ).resolves.toBe(250);
    } finally {
      await producer;
    }
  });

  it("returns a bounded and redacted terminal result with changed files and artifacts", async () => {
    const fixture = await startResultFixture();
    try {
      const { job } = await submitTerminalResult(fixture, resultPayload());
      const result = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        job_id: job.job_id,
        summary: "[redacted structured content]",
        changed_files: [
          "src/index.ts",
          "src/worker.ts",
          "src/result.ts",
          "README.md",
          "package.json",
        ],
        tests: {
          passed: 8,
          failed: 0,
          summary: "[redacted structured content]",
        },
        artifacts: [
          {
            name: "Public report",
            media_type: "text/html",
            url: "https://example.test/result-report",
          },
        ],
        acknowledged_at: expect.any(String),
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "const result",
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "const report",
      );
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("omits negative and fractional Connector test counts from the public result", async () => {
    const fixture = await startResultFixture();
    try {
      const { job } = await submitTerminalResult(fixture, {
        ...resultPayload(),
        tests: {
          passed: -1,
          failed: 0.5,
          summary: "invalid Connector counts",
        },
      });
      const result = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        job_id: job.job_id,
        tests: {
          passed: 0,
          failed: 0,
          summary: "invalid Connector counts",
        },
      });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("deduplicates an exact terminal event and rejects a modified same-ID replay without mutation", async () => {
    const fixture = await startResultFixture();
    try {
      const { job, terminal } = await submitTerminalResult(
        fixture,
        resultPayload(),
      );
      const event = terminal.event;
      if (event.type !== "job.event") {
        throw new Error("expected a terminal job.event");
      }

      const readReplayState = async () => {
        const snapshot = await db.query<{
          current_stage: string;
          original_terminal_event_count: string;
          revision: number;
          status: string;
          summary: Record<string, unknown> | null;
          terminal_at: Date | null;
        }>(
          `
            SELECT j.current_stage, j.revision, j.status, j.summary,
                   j.terminal_at,
                   (SELECT count(*)::text
                      FROM job_events AS je
                     WHERE je.job_id = j.id AND je.message_id = $2)
                     AS original_terminal_event_count
              FROM jobs AS j
             WHERE j.id = $1
          `,
          [job.job_id, event.message_id],
        );
        const row = snapshot.rows[0];
        if (row === undefined) throw new Error("expected terminal job state");
        return row;
      };
      const beforeDuplicate = await readReplayState();
      expect(beforeDuplicate).toMatchObject({
        original_terminal_event_count: "1",
        status: "succeeded",
      });

      await fixture.connector.send("job.event", event.payload, {
        message_id: event.message_id,
        sequence: event.sequence,
        correlation_id: event.correlation_id,
        sent_at: event.sent_at,
        expires_at: event.expires_at,
      });
      await waitForWireOccurrences(
        fixture.connector,
        terminal.ack.message_id,
        2,
      );
      expect(await readReplayState()).toEqual(beforeDuplicate);

      await fixture.connector.send(
        "job.event",
        {
          ...event.payload,
          payload: {
            ...event.payload.payload,
            summary: "MUTATED terminal summary",
          },
        },
        {
          message_id: event.message_id,
          sequence: event.sequence,
          correlation_id: event.correlation_id,
          sent_at: event.sent_at,
          expires_at: event.expires_at,
        },
      );
      await expect(
        fixture.connector.next("protocol.error"),
      ).resolves.toMatchObject({
        payload: { code: "CLIENT_REPLAY_MISMATCH" },
      });

      const afterReplay = await readReplayState();
      expect(afterReplay).toEqual(beforeDuplicate);
      expect(JSON.stringify(afterReplay.summary)).not.toContain("MUTATED");

      const result = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        job_id: job.job_id,
        summary: "[redacted structured content]",
      });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("audits and ignores a fresh later terminal event without replacing the committed result", async () => {
    const fixture = await startResultFixture();
    try {
      const { job, terminal } = await submitTerminalResult(
        fixture,
        resultPayload(),
      );
      const committedResult = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(committedResult.isError).not.toBe(true);
      await db.query(
        `UPDATE jobs
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [job.job_id],
      );

      const beforeLaterEvent = await db.query<{
        acknowledged_at: Date | null;
        current_stage: string;
        revision: number;
        status: string;
        summary: Record<string, unknown> | null;
        terminal_at: Date | null;
        unread_terminal: boolean;
      }>(
        `SELECT acknowledged_at, current_stage, revision, status, summary,
                terminal_at, unread_terminal
           FROM jobs
          WHERE id = $1`,
        [job.job_id],
      );
      expect(beforeLaterEvent.rows).toHaveLength(1);

      const responseStart = fixture.connector.wireReceived.length;
      const laterEvent = await fixture.connector.send("job.event", {
        job_id: job.job_id,
        attempt: job.offer.payload.attempt,
        event_type: "job.failed",
        payload: {
          status: "failed",
          stage: "must-not-replace-terminal-stage",
          summary: "later terminal result must remain audit-only",
        },
        source: "fake-connector",
      });
      expect(laterEvent.message_id).not.toBe(terminal.event.message_id);

      const laterResponse = await waitForCondition(
        () =>
          fixture.connector.wireReceived
            .slice(responseStart)
            .find(
              (message) =>
                (message.type === "ack" &&
                  message.payload.sequence === laterEvent.sequence) ||
                message.type === "protocol.error",
            ),
        "the later terminal response",
      );
      expect(laterResponse).toMatchObject({
        type: "ack",
        payload: { sequence: laterEvent.sequence },
      });
      await fixture.connector.send("job.event", laterEvent.payload, {
        message_id: laterEvent.message_id,
        sequence: laterEvent.sequence,
        correlation_id: laterEvent.correlation_id,
        sent_at: laterEvent.sent_at,
        expires_at: laterEvent.expires_at,
      });
      await expect
        .poll(
          () =>
            fixture.connector.wireReceived.filter(
              (message) => message.message_id === laterResponse.message_id,
            ).length,
        )
        .toBe(2);

      const laterAudit = await db.query<{
        event_type: string;
        message_id: string;
        payload: Record<string, unknown>;
        source: string;
      }>(
        `SELECT event_type, message_id, payload, source
           FROM job_events
          WHERE job_id = $1 AND message_id = $2`,
        [job.job_id, laterEvent.message_id],
      );
      expect(laterAudit.rows).toEqual([
        {
          event_type: "job.failed",
          message_id: laterEvent.message_id,
          payload: {
            status: "failed",
            stage: "must-not-replace-terminal-stage",
            summary: "later terminal result must remain audit-only",
          },
          source: "fake-connector",
        },
      ]);

      const afterLaterEvent = await db.query<{
        acknowledged_at: Date | null;
        current_stage: string;
        revision: number;
        status: string;
        summary: Record<string, unknown> | null;
        terminal_at: Date | null;
        unread_terminal: boolean;
      }>(
        `SELECT acknowledged_at, current_stage, revision, status, summary,
                terminal_at, unread_terminal
           FROM jobs
          WHERE id = $1`,
        [job.job_id],
      );
      expect(afterLaterEvent.rows).toEqual(beforeLaterEvent.rows);

      const resultAfterLaterEvent = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(resultAfterLaterEvent.isError).not.toBe(true);
      expect(resultAfterLaterEvent.structuredContent).toEqual(
        committedResult.structuredContent,
      );
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("rejects a fresh nonterminal event after a terminal winner without acknowledgement or mutation", async () => {
    const fixture = await startResultFixture();
    try {
      const { job } = await submitTerminalResult(fixture, resultPayload());
      const before = await db.query<{
        acknowledged_at: Date | null;
        current_stage: string;
        last_client_sequence: number;
        revision: number;
        status: string;
        summary: Record<string, unknown> | null;
        terminal_at: Date | null;
        unread_terminal: boolean;
      }>(
        `SELECT j.acknowledged_at, j.current_stage, c.last_client_sequence,
                j.revision, j.status, j.summary, j.terminal_at,
                j.unread_terminal
           FROM jobs j
           JOIN connectors c ON c.id = j.connector_id
          WHERE j.id = $1`,
        [job.job_id],
      );
      expect(before.rows).toHaveLength(1);

      const responseStart = fixture.connector.wireReceived.length;
      const progress = await fixture.connector.send("job.event", {
        job_id: job.job_id,
        attempt: job.offer.payload.attempt,
        event_type: "progress",
        payload: { stage: "must-not-run-after-terminal" },
        source: "fake-connector",
      });
      const response = await waitForCondition(
        () =>
          fixture.connector.wireReceived
            .slice(responseStart)
            .find(
              (message) =>
                (message.type === "ack" &&
                  message.payload.sequence === progress.sequence) ||
                message.type === "protocol.error",
            ),
        "the late progress response",
      );

      expect(response).toMatchObject({
        type: "protocol.error",
        payload: { code: "EVENT_REJECTED" },
      });
      expect(
        fixture.connector.wireReceived
          .slice(responseStart)
          .some(
            (message) =>
              message.type === "ack" &&
              message.payload.sequence === progress.sequence,
          ),
      ).toBe(false);

      const after = await db.query<{
        acknowledged_at: Date | null;
        current_stage: string;
        last_client_sequence: number;
        revision: number;
        status: string;
        summary: Record<string, unknown> | null;
        terminal_at: Date | null;
        unread_terminal: boolean;
      }>(
        `SELECT j.acknowledged_at, j.current_stage, c.last_client_sequence,
                j.revision, j.status, j.summary, j.terminal_at,
                j.unread_terminal
           FROM jobs j
           JOIN connectors c ON c.id = j.connector_id
          WHERE j.id = $1`,
        [job.job_id],
      );
      expect(after.rows).toEqual(before.rows);
      await expect(
        db.query<{ count: string }>(
          `SELECT (
             SELECT count(*) FROM connector_messages WHERE message_id = $1
           ) + (
             SELECT count(*) FROM job_events WHERE message_id = $1
           ) AS count`,
          [progress.message_id],
        ),
      ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("lists a terminal result as unread until the first result acknowledgement", async () => {
    const fixture = await startResultFixture();
    try {
      const { job } = await submitTerminalResult(fixture, resultPayload());
      const before = await fixture.mcp.client.callTool({
        name: "list_tasks",
        arguments: { limit: 5, unread_only: true },
      });
      expect(before.isError).not.toBe(true);
      expect(before.structuredContent).toMatchObject({
        tasks: [
          expect.objectContaining({
            short_id: job.short_id,
            status: "succeeded",
            unread_terminal: true,
          }),
        ],
      });

      const acknowledged = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(acknowledged.isError).not.toBe(true);

      const after = await fixture.mcp.client.callTool({
        name: "list_tasks",
        arguments: { limit: 5, unread_only: true },
      });
      expect(after.isError).not.toBe(true);
      expect(after.structuredContent).toEqual({ tasks: [] });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("returns one database acknowledgement timestamp for concurrent and repeated reads", async () => {
    const fixture = await startResultFixture();
    const extraConnections: ProductionMcpConnection[] = [];
    try {
      const { job } = await submitTerminalResult(fixture, resultPayload());
      extraConnections.push(
        ...(await Promise.all([
          connectProductionMcp(fixture.coordinator, fixture.ownerId),
          connectProductionMcp(fixture.coordinator, fixture.ownerId),
        ])),
      );
      const connections = [fixture.mcp, ...extraConnections];
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, (_, index) => {
          const connection = connections[index % connections.length];
          if (connection === undefined) {
            throw new Error("expected a production MCP connection");
          }
          return connection.client.callTool({
            name: "get_task_result",
            arguments: { job_id: job.job_id },
          });
        }),
      );
      const repeated = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      const results = [...concurrent, repeated];
      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(
        results.every(
          (result) =>
            JSON.stringify(result.structuredContent) ===
            JSON.stringify(results[0]?.structuredContent),
        ),
      ).toBe(true);
      const acknowledgedAt = results.map(
        (result) =>
          (result.structuredContent as { acknowledged_at: string })
            .acknowledged_at,
      );
      expect(new Set(acknowledgedAt)).toEqual(new Set([acknowledgedAt[0]]));
      expect(acknowledgedAt[0]).toBeTruthy();

      const stored = await db.query<{ acknowledged_at_ms: string | null }>(
        "SELECT floor(extract(epoch FROM acknowledged_at) * 1000)::bigint::text AS acknowledged_at_ms FROM jobs WHERE id = $1",
        [job.job_id],
      );
      expect(stored.rows[0]?.acknowledged_at_ms).toBeTruthy();
      expect(
        new Date(Number(stored.rows[0]?.acknowledged_at_ms)).toISOString(),
      ).toBe(acknowledgedAt[0]);
    } finally {
      await Promise.all(extraConnections.map(closeProductionMcp));
      await closeResultFixture(fixture);
    }
  });

  it("isolates terminal results by authenticated owner", async () => {
    const fixture = await startResultFixture();
    let otherOwner: ProductionMcpConnection | undefined;
    try {
      const { job } = await submitTerminalResult(fixture, resultPayload());
      otherOwner = await connectProductionMcp(
        fixture.coordinator,
        `result-owner-${crypto.randomUUID()}`,
      );
      const foreign = await otherOwner.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(foreign.isError).toBe(true);
      expect(foreign.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_FOUND" },
      });

      const own = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(own.isError).not.toBe(true);
      expect(own.structuredContent).toMatchObject({ job_id: job.job_id });
    } finally {
      if (otherOwner !== undefined) await closeProductionMcp(otherOwner);
      await closeResultFixture(fixture);
    }
  });

  it("rejects a nonterminal result without acknowledging it", async () => {
    const fixture = await startResultFixture();
    try {
      const job = await submitAndClaim(fixture);
      const result = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_MUTABLE" },
      });

      const stored = await db.query<{
        acknowledged_at: Date | null;
        unread_terminal: boolean;
      }>("SELECT acknowledged_at, unread_terminal FROM jobs WHERE id = $1", [
        job.job_id,
      ]);
      expect(stored.rows[0]).toEqual({
        acknowledged_at: null,
        unread_terminal: false,
      });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it("rejects a terminal event without a result summary and leaves it unread", async () => {
    const fixture = await startResultFixture();
    try {
      const { job } = await submitTerminalResult(fixture, {
        status: "succeeded",
      });
      const result = await fixture.mcp.client.callTool({
        name: "get_task_result",
        arguments: { job_id: job.job_id },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_FOUND" },
      });

      const stored = await db.query<{
        acknowledged_at: Date | null;
        unread_terminal: boolean;
      }>("SELECT acknowledged_at, unread_terminal FROM jobs WHERE id = $1", [
        job.job_id,
      ]);
      expect(stored.rows[0]).toEqual({
        acknowledged_at: null,
        unread_terminal: true,
      });
    } finally {
      await closeResultFixture(fixture);
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   \t  "],
  ] as const)(
    "does not acknowledge or expose a blank terminal summary (%s)",
    async (_case, summary) => {
      const fixture = await startResultFixture();
      try {
        const { job, terminal } = await submitTerminalResult(fixture, {
          status: "succeeded",
          summary,
        });
        const result = await fixture.mcp.client.callTool({
          name: "get_task_result",
          arguments: { job_id: job.job_id },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: "JOB_NOT_FOUND" },
        });

        const stored = await db.query<{
          acknowledged_at: Date | null;
          client_summary: string | null;
          event_count: string;
          event_summary: string | null;
          job_summary: Record<string, unknown> | null;
          status: string;
          unread_terminal: boolean;
        }>(
          `SELECT j.status, j.summary AS job_summary, j.acknowledged_at,
                  j.unread_terminal,
                  (SELECT count(*)::text
                     FROM job_events
                    WHERE job_id = j.id AND message_id = $2) AS event_count,
                  (SELECT payload->>'summary'
                     FROM job_events
                    WHERE job_id = j.id AND message_id = $2) AS event_summary,
                  (SELECT payload #>> '{payload,payload,summary}'
                     FROM connector_messages
                    WHERE direction = 'client' AND message_id = $2)
                    AS client_summary
             FROM jobs j
            WHERE j.id = $1`,
          [job.job_id, terminal.event.message_id],
        );
        const state = stored.rows[0];
        expect(state).toMatchObject({
          acknowledged_at: null,
          event_count: "1",
          job_summary: null,
          status: "succeeded",
          unread_terminal: true,
        });
        expect(state?.event_summary?.trim() ?? "").toBe("");
        expect(state?.client_summary?.trim() ?? "").toBe("");
        expect(state?.event_summary).not.toBe("[redacted]");
        expect(state?.client_summary).not.toBe("[redacted]");
      } finally {
        await closeResultFixture(fixture);
      }
    },
  );
});
