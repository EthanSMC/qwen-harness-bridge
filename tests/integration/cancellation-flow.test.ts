import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
} from "@qhb/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "../../apps/control-plane/node_modules/drizzle-orm";
import {
  type ConnectorIdentity,
  PostgresConnectorStore,
} from "../../apps/control-plane/src/connector/outbox.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import { createTestDatabase } from "./support/postgres.js";

const database = createTestDatabase();

const clientEnvelope = <T extends ConnectorClientMessage["type"]>(
  type: T,
  sequence: number,
  payload: Extract<ConnectorClientMessage, { type: T }>["payload"],
): Extract<ConnectorClientMessage, { type: T }> => {
  const sentAt = new Date();
  return ConnectorClientMessageSchema.parse({
    protocol_version: "1.0",
    message_id: crypto.randomUUID(),
    sequence,
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + 60_000).toISOString(),
    correlation_id: crypto.randomUUID(),
    type,
    payload,
  }) as Extract<ConnectorClientMessage, { type: T }>;
};

type RunningJob = {
  ownerId: string;
  connectorId: string;
  jobId: string;
  attempt: number;
  revision: number;
  identity: ConnectorIdentity;
  repository: JobRepository;
  store: PostgresConnectorStore;
};

const prepareRunningJob = async (): Promise<RunningJob> => {
  const ownerId = `cancellation-owner-${crypto.randomUUID()}`;
  const repositoryId = `cancellation-repository-${crypto.randomUUID()}`;
  const connectorId = crypto.randomUUID();
  const identity = { ownerId, connectorId, protocolVersion: "1.0" } as const;

  await database.query(
    "INSERT INTO owners (id, display_name) VALUES ($1, 'Cancellation owner')",
    [ownerId],
  );
  await database.query(
    `INSERT INTO repository_policies
       (id, owner_id, display_name, canonical_path, allowed_action_classes)
     VALUES ($1, $2, 'Cancellation repository', '/private/redacted', '[]'::jsonb)`,
    [repositoryId, ownerId],
  );
  await database.query(
    `INSERT INTO connectors
       (id, owner_id, credential_id, credential_hash, protocol_version)
     VALUES ($1, $2, $3, 'integration-test-hash', '1.0')`,
    [connectorId, ownerId, `credential-${crypto.randomUUID()}`],
  );

  const repository = new JobRepository(database.client);
  const store = new PostgresConnectorStore(database.client);
  const job = await repository.createIdempotent({
    ownerId,
    clientRequestId: crypto.randomUUID(),
    repositoryId,
    requestCiphertext: "ciphertext:fixture",
    requestDigest: `sha256:${"a".repeat(64)}`,
    mode: "normal",
  });
  const offer = await store.dispatchNext(identity);
  if (offer === null) throw new Error("expected a job offer");

  const claim = clientEnvelope("job.claim", 1, {
    job_id: job.jobId,
    attempt: Number(offer.payload.attempt),
    lease_id: String(offer.payload.lease_id),
  });
  await expect(
    store.acceptClientMessage(identity, claim),
  ).resolves.toMatchObject({
    response: { type: "ack", payload: { sequence: 1 } },
  });

  const running = await repository.get(ownerId, job.jobId);
  if (running === null || running.status !== "running") {
    throw new Error("expected the claimed job to be running");
  }
  return {
    ownerId,
    connectorId,
    jobId: job.jobId,
    attempt: running.attempt,
    revision: running.revision,
    identity,
    repository,
    store,
  };
};

const requestCancellation = async (fixture: RunningJob) =>
  fixture.repository.cancelAtomically({
    ownerId: fixture.ownerId,
    jobId: fixture.jobId,
    expectedRevision: fixture.revision,
  });

beforeAll(async () => {
  await database.start();
});

afterAll(async () => {
  await database.stop();
});

describe("PostgreSQL cancellation flow", () => {
  it("moves running work to cancelling and emits exactly one job.cancel", async () => {
    const fixture = await prepareRunningJob();
    const cancelling = await requestCancellation(fixture);

    expect(cancelling).toMatchObject({
      status: "cancelling",
      revision: fixture.revision + 1,
    });
    const commands = await database.query<{
      type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT type, payload
         FROM connector_messages
        WHERE connector_id = $1 AND direction = 'server'
          AND type = 'job.cancel'
          AND payload->>'job_id' = $2`,
      [fixture.connectorId, fixture.jobId],
    );
    expect(commands.rows).toHaveLength(1);
    expect(commands.rows[0]).toMatchObject({
      type: "job.cancel",
      payload: {
        job_id: fixture.jobId,
        attempt: fixture.attempt,
        job_revision: fixture.revision + 1,
      },
    });
  });

  it.each(["succeeded", "failed"] as const)(
    "%s terminal event wins before a late job.cancelled and audits the late acknowledgement",
    async (status) => {
      const fixture = await prepareRunningJob();
      const cancelling = await requestCancellation(fixture);
      const terminal = clientEnvelope("job.event", 2, {
        job_id: fixture.jobId,
        attempt: fixture.attempt,
        event_type: status,
        payload: {
          status,
          stage: status,
          summary: `${status} before cancellation acknowledgement`,
        },
        source: "connector",
      });
      await expect(
        fixture.store.acceptClientMessage(fixture.identity, terminal),
      ).resolves.toMatchObject({
        response: { type: "ack", payload: { sequence: 2 } },
      });
      const winner = await fixture.repository.get(
        fixture.ownerId,
        fixture.jobId,
      );
      if (winner === null) throw new Error("expected a terminal winner");
      await database.query(
        `UPDATE jobs
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [fixture.jobId],
      );

      const lateCancellation = clientEnvelope("job.cancelled", 3, {
        job_id: fixture.jobId,
        attempt: fixture.attempt,
        reason: "late cancellation acknowledgement",
      });
      const first = await fixture.store.acceptClientMessage(
        fixture.identity,
        lateCancellation,
      );
      expect(first).toMatchObject({
        response: { type: "ack", payload: { sequence: 3 } },
      });
      await expect(
        fixture.store.acceptClientMessage(fixture.identity, lateCancellation),
      ).resolves.toMatchObject({
        duplicate: true,
        response: {
          messageId: first.response?.messageId,
          type: "ack",
          payload: { sequence: 3 },
        },
      });

      const afterArbitration = await fixture.repository.get(
        fixture.ownerId,
        fixture.jobId,
      );
      expect(winner).toMatchObject({
        status,
        revision: cancelling.revision + 1,
        summary: {
          status,
          summary: `${status} before cancellation acknowledgement`,
        },
      });
      expect(afterArbitration).toMatchObject({
        status: winner.status,
        revision: winner.revision,
        summary: winner.summary,
        terminalAt: winner.terminalAt,
      });
      const commands = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM connector_messages
          WHERE connector_id = $1 AND direction = 'server'
            AND type = 'job.cancel'
            AND payload->>'job_id' = $2`,
        [fixture.connectorId, fixture.jobId],
      );
      expect(commands.rows[0]?.count).toBe("1");
      const audit = await database.query<{
        sequence: number;
        event_type: string;
        message_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT sequence, event_type, message_id, payload
           FROM job_events
          WHERE job_id = $1 AND message_id = ANY($2::uuid[])
          ORDER BY sequence`,
        [fixture.jobId, [terminal.message_id, lateCancellation.message_id]],
      );
      expect(audit.rows).toHaveLength(2);
      const winningEvent = audit.rows.find(
        (event) => event.message_id === terminal.message_id,
      );
      const lateAudit = audit.rows.find(
        (event) => event.message_id === lateCancellation.message_id,
      );
      expect(winningEvent).toMatchObject({
        event_type: status,
        message_id: terminal.message_id,
      });
      expect(lateAudit).toMatchObject({
        event_type: "job.cancelled",
        message_id: lateCancellation.message_id,
        payload: {
          job_id: fixture.jobId,
          attempt: fixture.attempt,
          reason: "late cancellation acknowledgement",
        },
      });
      expect(Number(lateAudit?.sequence)).toBeGreaterThan(
        Number(winningEvent?.sequence),
      );
    },
  );

  it("replays an exact job.cancelled once and rejects a modified same-message-ID replay", async () => {
    const fixture = await prepareRunningJob();
    const cancelling = await requestCancellation(fixture);
    const cancellation = clientEnvelope("job.cancelled", 2, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      reason: "connector stopped the job",
    });

    const first = await fixture.store.acceptClientMessage(
      fixture.identity,
      cancellation,
    );
    expect(first).toMatchObject({
      duplicate: false,
      response: { type: "ack", payload: { sequence: 2 } },
    });
    const afterFirst = await fixture.repository.get(
      fixture.ownerId,
      fixture.jobId,
    );

    const duplicate = await fixture.store.acceptClientMessage(
      fixture.identity,
      cancellation,
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      response: {
        messageId: first.response?.messageId,
        sequence: first.response?.sequence,
        type: "ack",
        payload: { sequence: 2 },
      },
    });
    const modified = ConnectorClientMessageSchema.parse({
      ...cancellation,
      payload: {
        ...cancellation.payload,
        reason: "modified cancellation acknowledgement",
      },
    });
    await expect(
      fixture.store.acceptClientMessage(fixture.identity, modified),
    ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });

    const afterReplays = await fixture.repository.get(
      fixture.ownerId,
      fixture.jobId,
    );
    expect(afterFirst).toMatchObject({
      status: "cancelled",
      revision: cancelling.revision + 1,
      terminalAt: expect.any(Date),
    });
    expect(afterReplays).toMatchObject({
      status: afterFirst?.status,
      revision: afterFirst?.revision,
      summary: afterFirst?.summary,
      terminalAt: afterFirst?.terminalAt,
    });
    const audit = await database.query<{
      event_type: string;
      message_id: string;
    }>(
      `SELECT event_type, message_id
         FROM job_events
        WHERE job_id = $1 AND message_id = $2`,
      [fixture.jobId, cancellation.message_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toEqual({
      event_type: "job.cancelled",
      message_id: cancellation.message_id,
    });
  });

  it("replays an exact terminal job.event once and rejects a modified same-message-ID replay", async () => {
    const fixture = await prepareRunningJob();
    const cancelling = await requestCancellation(fixture);
    const terminal = clientEnvelope("job.event", 2, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      event_type: "succeeded",
      payload: {
        status: "succeeded",
        stage: "completed",
        summary: "original terminal summary",
      },
      source: "connector",
    });

    const first = await fixture.store.acceptClientMessage(
      fixture.identity,
      terminal,
    );
    expect(first).toMatchObject({
      duplicate: false,
      response: { type: "ack", payload: { sequence: 2 } },
    });
    const afterFirst = await fixture.repository.get(
      fixture.ownerId,
      fixture.jobId,
    );

    const duplicate = await fixture.store.acceptClientMessage(
      fixture.identity,
      terminal,
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      response: {
        messageId: first.response?.messageId,
        sequence: first.response?.sequence,
        type: "ack",
        payload: { sequence: 2 },
      },
    });
    const modified = ConnectorClientMessageSchema.parse({
      ...terminal,
      payload: {
        ...terminal.payload,
        payload: {
          ...terminal.payload.payload,
          summary: "modified terminal summary",
        },
      },
    });
    await expect(
      fixture.store.acceptClientMessage(fixture.identity, modified),
    ).rejects.toMatchObject({ code: "CLIENT_REPLAY_MISMATCH" });

    const afterReplays = await fixture.repository.get(
      fixture.ownerId,
      fixture.jobId,
    );
    expect(afterFirst).toMatchObject({
      status: "succeeded",
      revision: cancelling.revision + 1,
      summary: {
        status: "succeeded",
        summary: "original terminal summary",
      },
    });
    expect(afterReplays).toMatchObject({
      status: afterFirst?.status,
      revision: afterFirst?.revision,
      summary: afterFirst?.summary,
      terminalAt: afterFirst?.terminalAt,
    });
    const audit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM job_events
        WHERE job_id = $1 AND message_id = $2`,
      [fixture.jobId, terminal.message_id],
    );
    expect(audit.rows[0]?.count).toBe("1");
    const commands = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM connector_messages
        WHERE connector_id = $1 AND direction = 'server'
          AND type = 'job.cancel'
          AND payload->>'job_id' = $2`,
      [fixture.connectorId, fixture.jobId],
    );
    expect(commands.rows[0]?.count).toBe("1");
  });

  it("keeps job.cancelled as the winner when an incompatible terminal event arrives later", async () => {
    const fixture = await prepareRunningJob();
    const cancelling = await requestCancellation(fixture);
    const cancellation = clientEnvelope("job.cancelled", 2, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      reason: "connector stopped the job",
    });
    await expect(
      fixture.store.acceptClientMessage(fixture.identity, cancellation),
    ).resolves.toMatchObject({
      response: { type: "ack", payload: { sequence: 2 } },
    });
    const winner = await fixture.repository.get(fixture.ownerId, fixture.jobId);

    const incompatible = clientEnvelope("job.event", 3, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      event_type: "failed",
      payload: {
        status: "failed",
        stage: "failed",
        summary: "must not replace the cancellation winner",
      },
      source: "connector",
    });
    await expect(
      fixture.store.acceptClientMessage(fixture.identity, incompatible),
    ).resolves.toMatchObject({
      response: { type: "ack", payload: { sequence: 3 } },
    });

    const afterArbitration = await fixture.repository.get(
      fixture.ownerId,
      fixture.jobId,
    );
    expect(winner).toMatchObject({
      status: "cancelled",
      revision: cancelling.revision + 1,
      summary: null,
      terminalAt: expect.any(Date),
    });
    expect(afterArbitration).toMatchObject({
      status: winner?.status,
      revision: winner?.revision,
      summary: winner?.summary,
      terminalAt: winner?.terminalAt,
    });
    const audit = await database.query<{
      event_type: string;
      message_id: string;
    }>(
      `SELECT event_type, message_id
         FROM job_events
        WHERE job_id = $1 AND message_id = ANY($2::uuid[])
        ORDER BY sequence`,
      [fixture.jobId, [cancellation.message_id, incompatible.message_id]],
    );
    expect(audit.rows).toEqual([
      {
        event_type: "job.cancelled",
        message_id: cancellation.message_id,
      },
      { event_type: "failed", message_id: incompatible.message_id },
    ]);
    const commands = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM connector_messages
        WHERE connector_id = $1 AND direction = 'server'
          AND type = 'job.cancel'
          AND payload->>'job_id' = $2`,
      [fixture.connectorId, fixture.jobId],
    );
    expect(commands.rows[0]?.count).toBe("1");
  });

  it("arbitrates concurrent job.cancelled and terminal job.event with one immutable winner", async () => {
    const fixture = await prepareRunningJob();
    const cancelling = await requestCancellation(fixture);
    const cancellation = clientEnvelope("job.cancelled", 2, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      reason: "concurrent cancellation winner",
    });
    const terminal = clientEnvelope("job.event", 3, {
      job_id: fixture.jobId,
      attempt: fixture.attempt,
      event_type: "succeeded",
      payload: {
        status: "succeeded",
        stage: "completed",
        summary: "concurrent terminal loser",
      },
      source: "connector",
    });

    let signalHolderReady!: (backendPid: number) => void;
    let releaseHolder!: () => void;
    const holderReady = new Promise<number>((resolve) => {
      signalHolderReady = resolve;
    });
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = database.client.transaction(async (tx) => {
      const backend = await tx.execute(
        drizzleSql`SELECT pg_backend_pid() AS "backendPid"`,
      );
      const holderBackendPid = Number(
        (backend[0] as { backendPid?: number | string } | undefined)
          ?.backendPid,
      );
      if (!Number.isSafeInteger(holderBackendPid) || holderBackendPid < 1) {
        throw new Error("holder PostgreSQL backend PID is invalid");
      }
      await tx.execute(
        drizzleSql`SELECT id FROM jobs WHERE id = ${fixture.jobId} FOR UPDATE`,
      );
      signalHolderReady(holderBackendPid);
      await holderReleased;
    });
    const holderBackendPid = await holderReady;

    let cancellationSettled = false;
    const cancellationAcceptance = fixture.store
      .acceptClientMessage(fixture.identity, cancellation)
      .finally(() => {
        cancellationSettled = true;
      });
    try {
      let cancellationReady = false;
      let cancellationWaiterPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiters = await database.query<{ pid: number }>(
          `SELECT pid
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND $1::integer = ANY(pg_blocking_pids(pid))
            ORDER BY pid`,
          [holderBackendPid],
        );
        const waiterPid = Number(waiters.rows[0]?.pid);
        if (Number.isSafeInteger(waiterPid) && waiterPid > 0) {
          cancellationWaiterPid = waiterPid;
        }
        if (cancellationSettled || cancellationWaiterPid !== undefined) {
          cancellationReady = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!cancellationReady) {
        throw new Error("cancellation did not reach PostgreSQL arbitration");
      }

      const terminalAcceptance = fixture.store.acceptClientMessage(
        fixture.identity,
        terminal,
      );
      let terminalReady = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiters = await database.query<{ pid: number }>(
          `SELECT pid
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> $1::integer
              AND (
                $1::integer = ANY(pg_blocking_pids(pid))
                OR (
                  $2::integer IS NOT NULL
                  AND $2::integer = ANY(pg_blocking_pids(pid))
                )
              )
            ORDER BY pid`,
          [holderBackendPid, cancellationWaiterPid ?? null],
        );
        const distinctTerminalWaiter = waiters.rows.some(
          (waiter) => Number(waiter.pid) !== cancellationWaiterPid,
        );
        if (distinctTerminalWaiter) {
          terminalReady = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!terminalReady) {
        throw new Error("terminal event did not reach PostgreSQL arbitration");
      }

      releaseHolder();
      await expect(
        Promise.all([cancellationAcceptance, terminalAcceptance]),
      ).resolves.toMatchObject([
        { response: { type: "ack", payload: { sequence: 2 } } },
        { response: { type: "ack", payload: { sequence: 3 } } },
      ]);
    } finally {
      releaseHolder();
      await holder;
    }

    await expect(
      fixture.repository.get(fixture.ownerId, fixture.jobId),
    ).resolves.toMatchObject({
      status: "cancelled",
      revision: cancelling.revision + 1,
      summary: null,
      terminalAt: expect.any(Date),
    });
    const audit = await database.query<{
      event_type: string;
      message_id: string;
    }>(
      `SELECT event_type, message_id
         FROM job_events
        WHERE job_id = $1 AND message_id = ANY($2::uuid[])
        ORDER BY sequence`,
      [fixture.jobId, [cancellation.message_id, terminal.message_id]],
    );
    expect(audit.rows).toEqual([
      {
        event_type: "job.cancelled",
        message_id: cancellation.message_id,
      },
      { event_type: "succeeded", message_id: terminal.message_id },
    ]);
    const commands = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM connector_messages
        WHERE connector_id = $1 AND direction = 'server'
          AND type = 'job.cancel'
          AND payload->>'job_id' = $2`,
      [fixture.connectorId, fixture.jobId],
    );
    expect(commands.rows[0]?.count).toBe("1");
  });

  it.each([
    ["job.cancelled", "owner"],
    ["job.cancelled", "connector"],
    ["job.cancelled", "attempt"],
    ["job.event", "owner"],
    ["job.event", "connector"],
    ["job.event", "attempt"],
  ] as const)(
    "rejects %s with a mismatched %s binding without durable writes",
    async (messageType, binding) => {
      const fixture = await prepareRunningJob();
      const cancelling = await requestCancellation(fixture);
      let invalidIdentity = fixture.identity;
      let sequence = 2;

      if (binding === "owner") {
        const ownerId = `other-owner-${crypto.randomUUID()}`;
        const connectorId = crypto.randomUUID();
        await database.query(
          "INSERT INTO owners (id, display_name) VALUES ($1, 'Other owner')",
          [ownerId],
        );
        await database.query(
          `INSERT INTO connectors
             (id, owner_id, credential_id, credential_hash, protocol_version)
           VALUES ($1, $2, $3, 'integration-test-hash', '1.0')`,
          [connectorId, ownerId, `credential-${crypto.randomUUID()}`],
        );
        invalidIdentity = {
          ownerId,
          connectorId,
          protocolVersion: "1.0",
        };
        sequence = 1;
      } else if (binding === "connector") {
        const connectorId = crypto.randomUUID();
        await database.query(
          `INSERT INTO connectors
             (id, owner_id, credential_id, credential_hash, protocol_version)
           VALUES ($1, $2, $3, 'integration-test-hash', '1.0')`,
          [connectorId, fixture.ownerId, `credential-${crypto.randomUUID()}`],
        );
        invalidIdentity = {
          ownerId: fixture.ownerId,
          connectorId,
          protocolVersion: "1.0",
        };
        sequence = 1;
      }

      const message =
        messageType === "job.cancelled"
          ? clientEnvelope("job.cancelled", sequence, {
              job_id: fixture.jobId,
              attempt:
                binding === "attempt" ? fixture.attempt + 1 : fixture.attempt,
              reason: "invalid cancellation binding",
            })
          : clientEnvelope("job.event", sequence, {
              job_id: fixture.jobId,
              attempt:
                binding === "attempt" ? fixture.attempt + 1 : fixture.attempt,
              event_type: "succeeded",
              payload: {
                status: "succeeded",
                summary: "invalid terminal binding",
              },
              source: "connector",
            });
      const before = await fixture.repository.get(
        fixture.ownerId,
        fixture.jobId,
      );

      await expect(
        fixture.store.acceptClientMessage(invalidIdentity, message),
      ).rejects.toMatchObject({ code: "EVENT_REJECTED" });

      const after = await fixture.repository.get(
        fixture.ownerId,
        fixture.jobId,
      );
      expect(before).toMatchObject({
        status: "cancelling",
        revision: cancelling.revision,
      });
      expect(after).toMatchObject({
        status: before?.status,
        revision: before?.revision,
        summary: before?.summary,
        terminalAt: before?.terminalAt,
      });
      const durableWrites = await database.query<{ count: string }>(
        `SELECT (
           SELECT count(*) FROM connector_messages WHERE message_id = $1
         ) + (
           SELECT count(*) FROM job_events WHERE message_id = $1
         ) AS count`,
        [message.message_id],
      );
      expect(Number(durableWrites.rows[0]?.count ?? 0)).toBe(0);
    },
  );
});
