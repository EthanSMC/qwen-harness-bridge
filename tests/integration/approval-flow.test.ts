import type { ConnectorClientMessage } from "@qhb/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashConnectorCredential } from "../../apps/control-plane/src/connector/auth.js";
import { JobRepository } from "../../apps/control-plane/src/db/job-repository.js";
import {
  Aes256GcmEncryptor,
  JobCoordinator,
} from "../../apps/control-plane/src/domain/job-coordinator.js";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import {
  type ConnectorCredentials,
  FakeConnector,
  LOCALHOST_TLS,
} from "./support/fake-connector.js";
import { createTestDatabase } from "./support/postgres.js";

const db = createTestDatabase();
const namespace = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const OWNER_ID = `approval-flow-owner-${namespace}`;
const REPOSITORY_ID = `approval-flow-repository-${namespace}`;
const SESSION_SIGNING_KEY = `approval-flow-session-signing-key-${namespace}`;
const FINGERPRINT_A = `sha256:${"a".repeat(64)}`;
const FINGERPRINT_B = `sha256:${"b".repeat(64)}`;

let repository: JobRepository;
let coordinator: JobCoordinator;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let primaryConnector: FakeConnector | undefined;
let primaryCredentials: ConnectorCredentials | undefined;
const activeJobIds = new Set<string>();

type ClaimedJob = {
  connector: FakeConnector;
  connectorId: string;
  jobId: string;
  attempt: number;
  runningRevision: number;
};

type ApprovalRequestedMessage = Extract<
  ConnectorClientMessage,
  { type: "approval.requested" }
>;

type RequestedApproval = {
  jobRevision: number;
  approvalId: string;
  fingerprint: string;
  expiresAt: string;
  message: ApprovalRequestedMessage;
  acknowledgementId: string;
};

const seedConnector = async (): Promise<ConnectorCredentials> => {
  const credentials: ConnectorCredentials = {
    connector_id: crypto.randomUUID(),
    credential_id: `approval-flow-credential-${crypto.randomUUID()}`,
    credential_secret: `approval-flow-secret-${crypto.randomUUID()}`,
  };
  await db.query(
    `INSERT INTO connectors (id, owner_id, credential_id, credential_hash)
     VALUES ($1, $2, $3, $4)`,
    [
      credentials.connector_id,
      OWNER_ID,
      credentials.credential_id,
      await hashConnectorCredential(credentials.credential_secret),
    ],
  );
  return credentials;
};

const connectConnector = async (): Promise<{
  connector: FakeConnector;
  credentials: ConnectorCredentials;
}> => {
  if (app === undefined) throw new Error("Approval test app is not started");
  const credentials = await seedConnector();
  const connector = await FakeConnector.connect(app, credentials);
  return { connector, credentials };
};

const claimJob = async (): Promise<ClaimedJob> => {
  if (primaryConnector === undefined || primaryCredentials === undefined) {
    throw new Error("Primary approval test Connector is not connected");
  }
  const receipt = await coordinator.submit(
    { id: OWNER_ID },
    {
      client_request_id: crypto.randomUUID(),
      repository_id: REPOSITORY_ID,
      request: "Update the dependency lockfile",
      mode: "normal",
    },
  );
  activeJobIds.add(receipt.job_id);

  const offer = await primaryConnector.next("job.offer", 5_000);
  const claim = await primaryConnector.send("job.claim", {
    job_id: offer.payload.job_id,
    attempt: offer.payload.attempt,
    lease_id: offer.payload.lease_id,
  });
  const claimAck = await primaryConnector.next("ack");
  expect(claimAck.payload.sequence).toBe(claim.sequence);

  const running = await repository.get(OWNER_ID, receipt.job_id);
  if (running === null) throw new Error("Claimed approval job was not found");
  expect(running.status).toBe("running");

  return {
    connector: primaryConnector,
    connectorId: primaryCredentials.connector_id,
    jobId: receipt.job_id,
    attempt: running.attempt,
    runningRevision: running.revision,
  };
};

const reconnectPrimaryConnector = async (): Promise<void> => {
  if (
    app === undefined ||
    primaryConnector === undefined ||
    primaryCredentials === undefined
  ) {
    throw new Error("Primary approval test Connector is not connected");
  }
  await primaryConnector.waitForClose();
  primaryConnector = await FakeConnector.connect(app, primaryCredentials);
};

const requestApproval = async (
  job: ClaimedJob,
  input: {
    jobRevision: number;
    fingerprint: string;
    actionSummary?: string;
    approvalId?: string;
    expiresAt?: string;
  },
): Promise<RequestedApproval> => {
  const approvalId = input.approvalId ?? crypto.randomUUID();
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + 120_000).toISOString();
  const requested = (await job.connector.send("approval.requested", {
    approval_id: approvalId,
    job_id: job.jobId,
    attempt: job.attempt,
    job_revision: input.jobRevision,
    action_summary: input.actionSummary ?? "Install the approved dependency",
    impact_summary: "Updates the repository lockfile",
    risk_class: "approval_required",
    action_fingerprint: input.fingerprint,
    expires_at: expiresAt,
  })) as ApprovalRequestedMessage;
  const requestedAck = await job.connector.next("ack");
  expect(requestedAck.payload.sequence).toBe(requested.sequence);

  return {
    jobRevision: input.jobRevision,
    approvalId,
    fingerprint: input.fingerprint,
    expiresAt,
    message: requested,
    acknowledgementId: requestedAck.message_id,
  };
};

const readDecisionEffects = async (
  approvalId: string,
): Promise<{ decision: string | null; command_count: string }> => {
  const result = await db.query<{
    decision: string | null;
    command_count: string;
  }>(
    `SELECT
       (SELECT decision::text FROM approvals WHERE id = $1) AS decision,
       (SELECT count(*)::text
          FROM connector_messages
         WHERE direction = 'server'
           AND type = 'approval.decision'
           AND payload->>'approval_id' = $1::text) AS command_count`,
    [approvalId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Decision effects query returned no row");
  }
  return row;
};

beforeAll(async () => {
  await db.start();
  await db.query(
    `INSERT INTO owners (id, display_name)
     VALUES ($1, 'approval flow integration owner')`,
    [OWNER_ID],
  );
  await db.query(
    `INSERT INTO repository_policies
       (id, owner_id, display_name, canonical_path, allowed_action_classes, max_concurrency)
     VALUES ($1, $2, 'Approval flow repository', '/private/redacted',
       '["automatic", "approval_required"]'::jsonb, 20)`,
    [REPOSITORY_ID, OWNER_ID],
  );

  repository = new JobRepository(db.client);
  const encryptor = new Aes256GcmEncryptor(new Uint8Array(32).fill(23));
  coordinator = new JobCoordinator({
    repository,
    encryptor,
    now: () => new Date(),
  });
  app = await createApp({
    coordinator,
    ownerId: OWNER_ID,
    mcpBearerToken: `approval-flow-mcp-token-${namespace}`,
    https: LOCALHOST_TLS,
    connectorGateway: {
      database: db.client,
      sessionSigningKey: SESSION_SIGNING_KEY,
      requestDecryptor: encryptor,
      dispatchIntervalMs: 25,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const primary = await connectConnector();
  primaryConnector = primary.connector;
  primaryCredentials = primary.credentials;
});

afterEach(async () => {
  const jobIds = [...activeJobIds];
  activeJobIds.clear();
  await Promise.all(
    jobIds.map((jobId) => db.query("DELETE FROM jobs WHERE id = $1", [jobId])),
  );
});

afterAll(async () => {
  if (primaryConnector !== undefined) await primaryConnector.close();
  if (app !== undefined) await app.close();
  await db.stop();
});

describe("approval flow", () => {
  it("persists authenticated approval.requested with its opaque fingerprint and revision binding", async () => {
    const job = await claimJob();
    const approval = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
    });

    const stored = await db.query<{
      job_id: string;
      attempt: number;
      job_revision: number;
      action_fingerprint: string;
      decision: string | null;
    }>(
      `SELECT job_id, attempt, job_revision, action_fingerprint, decision
         FROM approvals
        WHERE id = $1`,
      [approval.approvalId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toEqual({
      job_id: job.jobId,
      attempt: job.attempt,
      job_revision: approval.jobRevision,
      action_fingerprint: FINGERPRINT_A,
      decision: null,
    });

    await expect(repository.get(OWNER_ID, job.jobId)).resolves.toMatchObject({
      status: "waiting_approval",
      revision: approval.jobRevision,
      attempt: job.attempt,
    });
    await expect(
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM job_events
          WHERE job_id = $1 AND event_type = 'approval.requested'`,
        [job.jobId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("uses PostgreSQL time for expiry and emits one automatic reject command", async () => {
    const job = await claimJob();
    const approval = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
    });
    await db.query(
      `UPDATE approvals
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [approval.approvalId],
    );
    const expired = await db.query<{ expired: boolean }>(
      `SELECT expires_at <= clock_timestamp() AS expired
         FROM approvals
        WHERE id = $1`,
      [approval.approvalId],
    );
    expect(expired.rows[0]?.expired).toBe(true);

    await expect(
      repository.recordApprovalDecision({
        ownerId: OWNER_ID,
        approvalId: approval.approvalId,
        decision: "approve",
        expectedJobRevision: approval.jobRevision,
        expectedAttempt: job.attempt,
        actionFingerprint: FINGERPRINT_A,
        now: new Date(0),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });

    const stored = await db.query<{ decision: string | null }>(
      "SELECT decision FROM approvals WHERE id = $1",
      [approval.approvalId],
    );
    expect(stored.rows[0]?.decision).toBe("reject");
    const commands = await db.query<{
      connector_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT connector_id, payload
         FROM connector_messages
        WHERE direction = 'server'
          AND type = 'approval.decision'
          AND payload->>'approval_id' = $1
        ORDER BY sequence`,
      [approval.approvalId],
    );
    expect(commands.rows).toEqual([
      {
        connector_id: job.connectorId,
        payload: {
          approval_id: approval.approvalId,
          job_id: job.jobId,
          attempt: job.attempt,
          job_revision: approval.jobRevision,
          action_fingerprint: FINGERPRINT_A,
          decision: "reject",
        },
      },
    ]);
    const command = await job.connector.next("approval.decision");
    await job.connector.ack(command);
  });

  it("supersedes an older binding and makes the first decision for the newer approval idempotent", async () => {
    const job = await claimJob();
    const approvalA = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
      actionSummary: "Install dependency version A",
    });
    const approvalB = await requestApproval(job, {
      jobRevision: approvalA.jobRevision + 1,
      fingerprint: FINGERPRINT_B,
      actionSummary: "Install dependency version B",
    });

    await expect(
      coordinator.decideApproval(
        { id: OWNER_ID },
        {
          approval_id: approvalA.approvalId,
          decision: "approve",
          expected_job_revision: approvalA.jobRevision,
        },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });

    const input = {
      approval_id: approvalB.approvalId,
      decision: "approve" as const,
      expected_job_revision: approvalB.jobRevision,
    };
    const first = await coordinator.decideApproval({ id: OWNER_ID }, input);
    const repeated = await coordinator.decideApproval({ id: OWNER_ID }, input);
    expect(first).toEqual({
      approval_id: approvalB.approvalId,
      job_id: job.jobId,
      decision: "approve",
      revision: approvalB.jobRevision,
    });
    expect(repeated).toEqual(first);
    await expect(
      coordinator.decideApproval(
        { id: OWNER_ID },
        { ...input, decision: "reject" },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });

    const command = await job.connector.next("approval.decision");
    expect(command.payload).toEqual({
      approval_id: approvalB.approvalId,
      job_id: job.jobId,
      attempt: job.attempt,
      job_revision: approvalB.jobRevision,
      action_fingerprint: FINGERPRINT_B,
      decision: "approve",
    });
    await job.connector.ack(command);
    const commandRows = await db.query<{
      connector_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT connector_id, payload
         FROM connector_messages
        WHERE direction = 'server'
          AND type = 'approval.decision'
          AND payload->>'approval_id' = $1`,
      [approvalB.approvalId],
    );
    expect(commandRows.rows).toEqual([
      { connector_id: job.connectorId, payload: command.payload },
    ]);
  });

  it("rejects owner, attempt, revision, and fingerprint mismatches without decision effects", async () => {
    const job = await claimJob();
    const approval = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
    });
    const noEffects = { decision: null, command_count: "0" };

    await expect(
      coordinator.decideApproval(
        { id: `other-owner-${namespace}` },
        {
          approval_id: approval.approvalId,
          decision: "approve",
          expected_job_revision: approval.jobRevision,
        },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await expect(readDecisionEffects(approval.approvalId)).resolves.toEqual(
      noEffects,
    );

    await expect(
      repository.recordApprovalDecision({
        ownerId: OWNER_ID,
        approvalId: approval.approvalId,
        decision: "approve",
        expectedJobRevision: approval.jobRevision,
        expectedAttempt: job.attempt + 1,
        actionFingerprint: FINGERPRINT_A,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await expect(readDecisionEffects(approval.approvalId)).resolves.toEqual(
      noEffects,
    );

    await expect(
      coordinator.decideApproval(
        { id: OWNER_ID },
        {
          approval_id: approval.approvalId,
          decision: "approve",
          expected_job_revision: approval.jobRevision + 1,
        },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await expect(readDecisionEffects(approval.approvalId)).resolves.toEqual(
      noEffects,
    );

    await expect(
      repository.recordApprovalDecision({
        ownerId: OWNER_ID,
        approvalId: approval.approvalId,
        decision: "approve",
        expectedJobRevision: approval.jobRevision,
        expectedAttempt: job.attempt,
        actionFingerprint: FINGERPRINT_B,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await expect(readDecisionEffects(approval.approvalId)).resolves.toEqual(
      noEffects,
    );
  });

  it("deduplicates an exact approval request and rejects a modified same-message replay", async () => {
    const job = await claimJob();
    const approval = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
    });
    const message = approval.message;
    const replayOverrides = {
      message_id: message.message_id,
      sequence: message.sequence,
      correlation_id: message.correlation_id,
      sent_at: message.sent_at,
      expires_at: message.expires_at,
    };

    await job.connector.send(
      "approval.requested",
      message.payload,
      replayOverrides,
    );
    await expect
      .poll(
        () =>
          job.connector.wireReceived.filter(
            (received) => received.message_id === approval.acknowledgementId,
          ).length,
      )
      .toBe(2);

    await job.connector.send(
      "approval.requested",
      { ...message.payload, action_fingerprint: FINGERPRINT_B },
      replayOverrides,
    );
    const replayError = await job.connector.next("protocol.error");
    expect(replayError.payload.code).toBe("CLIENT_REPLAY_MISMATCH");
    await reconnectPrimaryConnector();

    const counts = await db.query<{
      approvals: string;
      events: string;
      client_messages: string;
      decision_commands: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM approvals WHERE id = $1) AS approvals,
         (SELECT count(*)::text
            FROM job_events
           WHERE job_id = $2 AND event_type = 'approval.requested') AS events,
         (SELECT count(*)::text
            FROM connector_messages
           WHERE direction = 'client' AND message_id = $3) AS client_messages,
         (SELECT count(*)::text
           FROM connector_messages
           WHERE direction = 'server'
             AND type = 'approval.decision'
             AND payload->>'approval_id' = $1::text) AS decision_commands`,
      [approval.approvalId, job.jobId, message.message_id],
    );
    expect(counts.rows[0]).toEqual({
      approvals: "1",
      events: "1",
      client_messages: "1",
      decision_commands: "0",
    });
  });

  it("rejects approval.requested from a different authenticated connector without side effects", async () => {
    const job = await claimJob();
    const approval = await requestApproval(job, {
      jobRevision: job.runningRevision + 1,
      fingerprint: FINGERPRINT_A,
    });
    const other = await connectConnector();
    try {
      const otherApprovalId = crypto.randomUUID();
      const receivedBeforeRequest = other.connector.wireReceived.length;
      await other.connector.send("approval.requested", {
        approval_id: otherApprovalId,
        job_id: job.jobId,
        attempt: job.attempt,
        job_revision: approval.jobRevision + 1,
        action_summary: "Request from the wrong Connector",
        impact_summary: "Must not change approval state",
        risk_class: "approval_required",
        action_fingerprint: FINGERPRINT_B,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      });
      await expect
        .poll(() => other.connector.wireReceived.length)
        .toBeGreaterThan(receivedBeforeRequest);

      await expect(readDecisionEffects(otherApprovalId)).resolves.toEqual({
        decision: null,
        command_count: "0",
      });
      await expect(readDecisionEffects(approval.approvalId)).resolves.toEqual({
        decision: null,
        command_count: "0",
      });
      expect(other.connector.wireReceived.at(-1)?.type).toBe("protocol.error");
    } finally {
      await other.connector.close();
    }
  });
});
