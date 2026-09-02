import crypto from "node:crypto";
import type {
  ConnectorClientMessage,
  ConnectorServerMessage,
  JobStatus,
} from "@qhb/protocol";
import { ConnectorServerMessageSchema, rfc3339InstantKey } from "@qhb/protocol";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  connectorMessages,
  connectors,
  jobEvents,
  jobs,
  repositoryPolicies,
} from "../db/schema.js";
import type { RequestDecryptor } from "../domain/job-coordinator.js";
import { assertTransition, TERMINAL_JOB_STATES } from "../domain/job-state.js";
import { sanitizePublicText } from "../domain/presenters.js";
import type {
  ConnectorCredentialRecord,
  ConnectorCredentialStore,
} from "./auth.js";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const CONNECTOR_STALE_AFTER_MS = 20_000;
export const CONNECTOR_OFFLINE_AFTER_MS = 30_000;
export const OFFER_LEASE_MS = 30_000;
export const SERVER_REPLAY_BATCH_SIZE = 100;
const REPLAY_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryDatabase = Database | Transaction;
type ConnectorRow = typeof connectors.$inferSelect;
type ConnectorMessageRow = typeof connectorMessages.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

export type ConnectorIdentity = Readonly<{
  ownerId: string;
  connectorId: string;
  protocolVersion: string;
}>;

export type StoredServerMessage = Readonly<{
  connectorId: string;
  sequence: number;
  messageId: string;
  type: ConnectorServerMessage["type"];
  payload: Record<string, unknown>;
  correlationId: string;
  expiresAt: Date;
  createdAt: Date;
}>;

export type ClientMessageAcceptance = Readonly<{
  duplicate: boolean;
  replay: readonly StoredServerMessage[];
  response: StoredServerMessage | null;
}>;

export type ConnectorStoreErrorCode =
  | "AUTHORIZATION_FAILED"
  | "CLIENT_SEQUENCE_GAP"
  | "CLIENT_REPLAY_MISMATCH"
  | "CLAIM_REJECTED"
  | "EVENT_REJECTED"
  | "INTERNAL";

export class ConnectorStoreError extends Error {
  readonly code: ConnectorStoreErrorCode;

  constructor(code: ConnectorStoreErrorCode, message: string = code) {
    super(message);
    this.name = "ConnectorStoreError";
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const PUBLIC_EVENT_PAYLOAD_KEYS = new Set([
  "action",
  "artifacts",
  "changed_files",
  "count",
  "current_stage",
  "detail",
  "failed",
  "impact",
  "label",
  "media_type",
  "message",
  "name",
  "outcome",
  "passed",
  "reason",
  "result",
  "results",
  "stage",
  "status",
  "summary",
  "tests",
  "title",
  "total",
  "type",
  "url",
]);
const SOURCE_LIKE_EVENT_TEXT =
  /\b(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|function\s+[A-Za-z_$][\w$]*\s*\(|class\s+[A-Za-z_$][\w$]*\s*[{<]|def\s+[A-Za-z_]\w*\s*\(|(?:import|export)\s+(?:[\w*{]|from\b))/u;
const SECRET_LIKE_CONNECTOR_TEXT =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/giu;

const sanitizeEventValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    const sanitized = sanitizePublicText(value, 500, 500, 500);
    if (SOURCE_LIKE_EVENT_TEXT.test(sanitized)) {
      return "[redacted source content]";
    }
    return sanitized || "[redacted]";
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeEventValue);
  const record = asRecord(value);
  if (record === null) return "[redacted]";
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => PUBLIC_EVENT_PAYLOAD_KEYS.has(key))
      .map(([key, item]) => [key, sanitizeEventValue(item)]),
  );
};

const sanitizeConnectorEventPayload = (
  payload: Record<string, unknown>,
): Record<string, unknown> =>
  sanitizeEventValue(payload) as Record<string, unknown>;

const sanitizeConnectorText = (value: string, maxLength = 800): string => {
  const sanitized = sanitizePublicText(
    value.replace(SECRET_LIKE_CONNECTOR_TEXT, "[redacted]"),
    maxLength,
    maxLength,
    maxLength,
  );
  if (SOURCE_LIKE_EVENT_TEXT.test(sanitized)) {
    return "[redacted source content]";
  }
  return sanitized || "[redacted]";
};

const sanitizeDurableClientValue = (value: unknown): unknown => {
  if (typeof value === "string") return sanitizeConnectorText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeDurableClientValue);
  const record = asRecord(value);
  if (record === null) return "[redacted]";
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      sanitizeDurableClientValue(item),
    ]),
  );
};

const storedClientPayload = (
  message: ConnectorClientMessage,
): Record<string, unknown> => {
  const payload =
    message.type === "job.event"
      ? {
          ...message.payload,
          event_type: sanitizeConnectorText(message.payload.event_type, 64),
          payload: sanitizeConnectorEventPayload(message.payload.payload),
          source: sanitizeConnectorText(message.payload.source, 32),
        }
      : sanitizeDurableClientValue(message.payload);
  const sentAt = rfc3339InstantKey(message.sent_at);
  const expiresAt = rfc3339InstantKey(message.expires_at);
  if (sentAt === null || expiresAt === null) {
    throw new ConnectorStoreError("INTERNAL", "Invalid Connector timestamp");
  }
  return {
    payload,
    payload_digest: `sha256:${crypto
      .createHash("sha256")
      .update(canonicalJson(message.payload))
      .digest("hex")}`,
    sent_at_instant: sentAt,
    expires_at_instant: expiresAt,
  };
};

const isExactDuplicate = (
  row: ConnectorMessageRow,
  message: ConnectorClientMessage,
): boolean =>
  row.direction === "client" &&
  row.sequence === message.sequence &&
  row.type === message.type &&
  row.correlationId === message.correlation_id &&
  row.expiresAt.getTime() === Date.parse(message.expires_at) &&
  canonicalJson(row.payload) === canonicalJson(storedClientPayload(message));

const findOriginalResponse = async (
  database: QueryDatabase,
  connectorId: string,
  message: ConnectorClientMessage,
): Promise<StoredServerMessage | null> => {
  if (message.type === "ack") return null;
  const expectedType =
    message.type === "connector.hello" ? "connector.welcome" : "ack";
  const rows = await database
    .select()
    .from(connectorMessages)
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "server"),
        eq(connectorMessages.correlationId, message.correlation_id),
        eq(connectorMessages.type, expectedType),
      ),
    )
    .orderBy(asc(connectorMessages.sequence));
  const row = rows.find((candidate) => {
    if (expectedType === "connector.welcome") return true;
    return candidate.payload.sequence === message.sequence;
  });
  if (row === undefined) {
    throw new ConnectorStoreError("INTERNAL", "Original response is missing");
  }
  return toStoredServerMessage(row);
};

const assertSafeSequence = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectorStoreError("INTERNAL", "Invalid Connector sequence");
  }
};

const toStoredServerMessage = (
  row: ConnectorMessageRow,
): StoredServerMessage => {
  assertSafeSequence(row.sequence);
  return {
    connectorId: row.connectorId,
    sequence: row.sequence,
    messageId: row.messageId,
    type: row.type as ConnectorServerMessage["type"],
    payload: row.payload,
    correlationId: row.correlationId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
};

const tombstoneExpiredOffers = async (
  database: QueryDatabase,
  connectorId: string,
  afterSequence: number,
  now: Date,
): Promise<void> => {
  const expiredOffers = await database
    .select()
    .from(connectorMessages)
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "server"),
        eq(connectorMessages.type, "job.offer"),
        gt(connectorMessages.sequence, afterSequence),
        lte(connectorMessages.expiresAt, now),
      ),
    )
    .orderBy(asc(connectorMessages.sequence))
    .limit(SERVER_REPLAY_BATCH_SIZE)
    .for("update");

  const tombstoneExpiresAt = new Date(
    now.getTime() + REPLAY_TOMBSTONE_RETENTION_MS,
  );
  for (const offer of expiredOffers) {
    await database
      .update(connectorMessages)
      .set({
        messageId: crypto.randomUUID(),
        type: "protocol.error",
        payload: {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
        expiresAt: tombstoneExpiresAt,
      })
      .where(
        and(
          eq(connectorMessages.id, offer.id),
          eq(connectorMessages.messageId, offer.messageId),
          eq(connectorMessages.type, "job.offer"),
          lte(connectorMessages.expiresAt, now),
        ),
      );
  }
};

const lockConnector = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
): Promise<ConnectorRow> => {
  const rows = await database
    .select()
    .from(connectors)
    .where(eq(connectors.id, identity.connectorId))
    .for("update");
  const row = rows[0];
  if (
    row === undefined ||
    row.ownerId !== identity.ownerId ||
    row.protocolVersion !== identity.protocolVersion ||
    identity.protocolVersion !== "1.0"
  ) {
    throw new ConnectorStoreError("AUTHORIZATION_FAILED");
  }
  assertSafeSequence(row.lastClientSequence);
  assertSafeSequence(row.lastServerSequence);
  return row;
};

const enqueueServerMessage = async (
  database: QueryDatabase,
  connector: ConnectorRow,
  type: ConnectorServerMessage["type"],
  payload: Record<string, unknown>,
  expiresAt: Date,
  correlationId: string = crypto.randomUUID(),
): Promise<StoredServerMessage> => {
  const sequence = connector.lastServerSequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ConnectorStoreError("INTERNAL", "Server sequence exhausted");
  }
  const updated = await database
    .update(connectors)
    .set({ lastServerSequence: sequence, updatedAt: sql`now()` })
    .where(
      and(
        eq(connectors.id, connector.id),
        eq(connectors.lastServerSequence, connector.lastServerSequence),
      ),
    )
    .returning({ sequence: connectors.lastServerSequence });
  if (updated[0]?.sequence !== sequence) {
    throw new ConnectorStoreError("INTERNAL", "Server sequence conflict");
  }
  connector.lastServerSequence = sequence;
  const inserted = await database
    .insert(connectorMessages)
    .values({
      connectorId: connector.id,
      direction: "server",
      sequence,
      type,
      payload,
      correlationId,
      expiresAt,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ConnectorStoreError("INTERNAL");
  return toStoredServerMessage(row);
};

const nextJobEventSequence = async (
  database: QueryDatabase,
  jobId: string,
): Promise<number> => {
  const rows = await database
    .select({
      sequence: sql<number>`coalesce(max(${jobEvents.sequence}), 0)`.as(
        "sequence",
      ),
    })
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId));
  const current = Number(rows[0]?.sequence ?? 0);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new ConnectorStoreError("INTERNAL", "Invalid job event sequence");
  }
  return current + 1;
};

const appendJobEvent = async (
  database: QueryDatabase,
  jobId: string,
  input: {
    type: string;
    payload: Record<string, unknown>;
    source: string;
    messageId?: string;
    correlationId?: string;
  },
): Promise<void> => {
  await database.insert(jobEvents).values({
    jobId,
    sequence: await nextJobEventSequence(database, jobId),
    eventType: input.type,
    payload: input.payload,
    source: input.source,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  });
};

const claimOfferedJob = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
  message: Extract<ConnectorClientMessage, { type: "job.claim" }>,
  now: Date,
): Promise<void> => {
  const rows = await database
    .select()
    .from(jobs)
    .where(eq(jobs.id, message.payload.job_id))
    .for("update");
  const job = rows[0];
  if (
    job === undefined ||
    job.ownerId !== identity.ownerId ||
    job.connectorId !== identity.connectorId ||
    job.status !== "dispatched" ||
    job.leaseId !== message.payload.lease_id ||
    job.leaseExpiresAt === null ||
    job.leaseExpiresAt.getTime() <= now.getTime() ||
    message.payload.attempt !== job.attempt + 1
  ) {
    throw new ConnectorStoreError("CLAIM_REJECTED");
  }
  const updated = await database
    .update(jobs)
    .set({
      status: "running",
      currentStage: "running",
      attempt: message.payload.attempt,
      revision: sql`${jobs.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "dispatched"),
        eq(jobs.revision, job.revision),
        eq(jobs.leaseId, message.payload.lease_id),
      ),
    )
    .returning({ id: jobs.id });
  if (updated.length !== 1) throw new ConnectorStoreError("CLAIM_REJECTED");
  await appendJobEvent(database, job.id, {
    type: "job.claimed",
    payload: {
      connector_id: identity.connectorId,
      attempt: message.payload.attempt,
    },
    source: "connector",
    messageId: message.message_id,
    correlationId: message.correlation_id,
  });
};

const statusForEvent = (
  current: JobStatus,
  eventType: string,
  payload: Record<string, unknown>,
): JobStatus => {
  const explicit = payload.status;
  const candidate =
    typeof explicit === "string" ? explicit : eventType.toLowerCase();
  if (
    ["succeeded", "success", "completed", "job.succeeded"].includes(candidate)
  )
    return "succeeded";
  if (["failed", "failure", "job.failed"].includes(candidate)) return "failed";
  if (["cancelled", "canceled", "job.cancelled"].includes(candidate))
    return "cancelled";
  if (candidate === "waiting_approval") return "waiting_approval";
  if (candidate === "running" || candidate === "resumed") return "running";
  return current;
};

const ingestJobEvent = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
  message: Extract<ConnectorClientMessage, { type: "job.event" }>,
  now: Date,
): Promise<void> => {
  const rows = await database
    .select()
    .from(jobs)
    .where(eq(jobs.id, message.payload.job_id))
    .for("update");
  const job = rows[0];
  if (
    job === undefined ||
    job.ownerId !== identity.ownerId ||
    job.connectorId !== identity.connectorId ||
    job.attempt !== message.payload.attempt ||
    TERMINAL_JOB_STATES.has(job.status)
  ) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }
  const sanitizedPayload = sanitizeConnectorEventPayload(
    message.payload.payload,
  );
  const sanitizedEventType = sanitizeConnectorText(
    message.payload.event_type,
    64,
  );
  const sanitizedSource = sanitizeConnectorText(message.payload.source, 32);
  const nextStatus = statusForEvent(
    job.status,
    sanitizedEventType,
    sanitizedPayload,
  );
  if (nextStatus !== job.status) {
    try {
      assertTransition(job.status, nextStatus);
    } catch {
      throw new ConnectorStoreError("EVENT_REJECTED");
    }
  }
  const stage = sanitizedPayload.stage;
  const currentStage =
    typeof stage === "string" && stage.length <= 128
      ? stage
      : sanitizedEventType;
  const terminal = TERMINAL_JOB_STATES.has(nextStatus);
  const updated = await database
    .update(jobs)
    .set({
      status: nextStatus,
      currentStage,
      revision: sql`${jobs.revision} + 1`,
      updatedAt: now,
      ...(terminal
        ? {
            terminalAt: now,
            requestDeleteAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            unreadTerminal: true,
            summary: sanitizedPayload,
          }
        : {}),
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.revision, job.revision)))
    .returning({ id: jobs.id });
  if (updated.length !== 1) throw new ConnectorStoreError("EVENT_REJECTED");
  await appendJobEvent(database, job.id, {
    type: sanitizedEventType,
    payload: sanitizedPayload,
    source: sanitizedSource,
    messageId: message.message_id,
    correlationId: message.correlation_id,
  });
};

export class PostgresConnectorStore implements ConnectorCredentialStore {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async findByCredentialId(
    credentialId: string,
  ): Promise<ConnectorCredentialRecord | null> {
    const rows = await this.#db
      .select()
      .from(connectors)
      .where(eq(connectors.credentialId, credentialId))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          credentialId: row.credentialId,
          credentialHash: row.credentialHash,
          ownerId: row.ownerId,
          connectorId: row.id,
          protocolVersion: row.protocolVersion,
        };
  }

  async acceptClientMessage(
    identity: ConnectorIdentity,
    message: ConnectorClientMessage,
    now = new Date(),
  ): Promise<ClientMessageAcceptance> {
    if (Date.parse(message.expires_at) <= now.getTime()) {
      throw new ConnectorStoreError(
        "CLIENT_REPLAY_MISMATCH",
        "Expired message",
      );
    }
    return this.#db.transaction(async (tx) => {
      const connector = await lockConnector(tx, identity);
      const existingRows = await tx
        .select()
        .from(connectorMessages)
        .where(
          and(
            eq(connectorMessages.connectorId, connector.id),
            eq(connectorMessages.messageId, message.message_id),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (!isExactDuplicate(existing, message)) {
          throw new ConnectorStoreError("CLIENT_REPLAY_MISMATCH");
        }
        const response = await findOriginalResponse(tx, connector.id, message);
        return { duplicate: true, replay: [], response };
      }

      const expectedSequence = connector.lastClientSequence + 1;
      if (message.sequence !== expectedSequence) {
        throw new ConnectorStoreError(
          message.sequence > expectedSequence
            ? "CLIENT_SEQUENCE_GAP"
            : "CLIENT_REPLAY_MISMATCH",
        );
      }
      if (
        message.type === "connector.hello" &&
        (message.payload.connector_id !== connector.id ||
          (message.payload.last_client_sequence ??
            connector.lastClientSequence) !== connector.lastClientSequence ||
          message.payload.last_server_sequence > connector.lastServerSequence)
      ) {
        throw new ConnectorStoreError("CLIENT_REPLAY_MISMATCH");
      }

      await tx.insert(connectorMessages).values({
        connectorId: connector.id,
        direction: "client",
        sequence: message.sequence,
        messageId: message.message_id,
        type: message.type,
        payload: storedClientPayload(message),
        correlationId: message.correlation_id,
        expiresAt: new Date(message.expires_at),
      });

      if (message.type === "job.claim") {
        await claimOfferedJob(tx, identity, message, now);
      } else if (message.type === "job.event") {
        await ingestJobEvent(tx, identity, message, now);
      } else if (message.type === "ack") {
        await tx
          .update(connectorMessages)
          .set({ acknowledgedAt: now })
          .where(
            and(
              eq(connectorMessages.connectorId, connector.id),
              eq(connectorMessages.direction, "server"),
              eq(connectorMessages.sequence, message.payload.sequence),
            ),
          );
      }

      const capabilities =
        message.type === "connector.hello"
          ? (message.payload.capabilities?.map((capability: string) =>
              sanitizeConnectorText(capability, 64),
            ) ?? connector.capabilities)
          : connector.capabilities;
      await tx
        .update(connectors)
        .set({
          lastClientSequence: message.sequence,
          lastHeartbeatAt: now,
          health: "fresh",
          capabilities,
          updatedAt: now,
        })
        .where(
          and(
            eq(connectors.id, connector.id),
            eq(connectors.lastClientSequence, connector.lastClientSequence),
          ),
        );
      connector.lastClientSequence = message.sequence;
      connector.lastHeartbeatAt = now;
      connector.health = "fresh";

      if (message.type === "connector.hello") {
        await tx
          .update(connectorMessages)
          .set({ acknowledgedAt: now })
          .where(
            and(
              eq(connectorMessages.connectorId, connector.id),
              eq(connectorMessages.direction, "server"),
              lte(
                connectorMessages.sequence,
                message.payload.last_server_sequence,
              ),
            ),
          );
        await tombstoneExpiredOffers(
          tx,
          connector.id,
          message.payload.last_server_sequence,
          now,
        );
        const replayRows = await tx
          .select()
          .from(connectorMessages)
          .where(
            and(
              eq(connectorMessages.connectorId, connector.id),
              eq(connectorMessages.direction, "server"),
              gt(
                connectorMessages.sequence,
                message.payload.last_server_sequence,
              ),
            ),
          )
          .orderBy(asc(connectorMessages.sequence))
          .limit(SERVER_REPLAY_BATCH_SIZE);
        const welcome = await enqueueServerMessage(
          tx,
          connector,
          "connector.welcome",
          {
            connector_id: connector.id,
            server_sequence: connector.lastServerSequence + 1,
            replay_from: message.payload.last_server_sequence + 1,
          },
          new Date(now.getTime() + 60_000),
          message.correlation_id,
        );
        return {
          duplicate: false,
          replay: replayRows.map(toStoredServerMessage),
          response: welcome,
        };
      }

      const response =
        message.type === "ack"
          ? null
          : await enqueueServerMessage(
              tx,
              connector,
              "ack",
              { sequence: message.sequence },
              new Date(now.getTime() + 60_000),
              message.correlation_id,
            );
      return { duplicate: false, replay: [], response };
    });
  }

  async dispatchNext(
    identity: ConnectorIdentity,
    now = new Date(),
  ): Promise<StoredServerMessage | null> {
    return this.#db.transaction(async (tx) => {
      const connector = await lockConnector(tx, identity);
      const policies = await tx
        .select({
          id: repositoryPolicies.id,
          maxConcurrency: repositoryPolicies.maxConcurrency,
        })
        .from(repositoryPolicies)
        .where(
          and(
            eq(repositoryPolicies.ownerId, identity.ownerId),
            eq(repositoryPolicies.enabled, true),
          ),
        )
        .orderBy(asc(repositoryPolicies.id))
        .for("update");
      if (policies.length === 0) return null;

      const activeRows = await tx
        .select({
          repositoryId: jobs.repositoryId,
          count: sql<number>`count(*)::integer`.as("count"),
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.ownerId, identity.ownerId),
            or(
              inArray(jobs.status, [
                "running",
                "waiting_approval",
                "cancelling",
              ]),
              and(eq(jobs.status, "dispatched"), gt(jobs.leaseExpiresAt, now)),
            ),
          ),
        )
        .groupBy(jobs.repositoryId);
      const activeByRepository = new Map(
        activeRows.map((row) => [row.repositoryId, Number(row.count)]),
      );
      const eligibleRepositoryIds = policies
        .filter(
          (policy) =>
            (activeByRepository.get(policy.id) ?? 0) < policy.maxConcurrency,
        )
        .map((policy) => policy.id);
      if (eligibleRepositoryIds.length === 0) return null;

      const jobRows = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.ownerId, identity.ownerId),
            inArray(jobs.repositoryId, eligibleRepositoryIds),
            or(
              eq(jobs.status, "queued"),
              and(eq(jobs.status, "dispatched"), lte(jobs.leaseExpiresAt, now)),
            ),
            gt(jobs.expiresAt, now),
          ),
        )
        .orderBy(asc(jobs.acceptedAt), asc(jobs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      const job = jobRows[0];
      if (job === undefined) return null;
      if (job.requestCiphertext === null) {
        throw new ConnectorStoreError("INTERNAL", "Queued request is missing");
      }
      const redispatch = job.status === "dispatched";
      if (
        redispatch &&
        (job.leaseId === null ||
          job.leaseExpiresAt === null ||
          job.leaseExpiresAt.getTime() > now.getTime())
      ) {
        throw new ConnectorStoreError("INTERNAL", "Offer lease is invalid");
      }
      const leaseId = crypto.randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + OFFER_LEASE_MS);
      const attempt = job.attempt + 1;
      const updated = await tx
        .update(jobs)
        .set({
          status: "dispatched",
          currentStage: "dispatched",
          connectorId: identity.connectorId,
          leaseId,
          leaseExpiresAt,
          revision: sql`${jobs.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, job.status),
            eq(jobs.revision, job.revision),
            redispatch && job.leaseId !== null
              ? eq(jobs.leaseId, job.leaseId)
              : undefined,
          ),
        )
        .returning({ id: jobs.id });
      if (updated.length !== 1) return null;
      await appendJobEvent(tx, job.id, {
        type: redispatch ? "job.redispatched" : "job.dispatched",
        payload: {
          connector_id: identity.connectorId,
          attempt,
          lease_id: leaseId,
          ...(redispatch ? { previous_lease_id: job.leaseId } : {}),
        },
        source: "control-plane",
      });
      return enqueueServerMessage(
        tx,
        connector,
        "job.offer",
        {
          job_id: job.id,
          attempt,
          lease_id: leaseId,
          repository_id: job.repositoryId,
        },
        leaseExpiresAt,
      );
    });
  }

  async pendingServerMessages(
    identity: ConnectorIdentity,
    afterSequence: number,
    now = new Date(),
  ): Promise<readonly StoredServerMessage[]> {
    assertSafeSequence(afterSequence);
    return this.#db.transaction(async (tx) => {
      const connector = await lockConnector(tx, identity);
      await tombstoneExpiredOffers(tx, connector.id, afterSequence, now);
      const rows = await tx
        .select()
        .from(connectorMessages)
        .where(
          and(
            eq(connectorMessages.connectorId, identity.connectorId),
            eq(connectorMessages.direction, "server"),
            gt(connectorMessages.sequence, afterSequence),
          ),
        )
        .orderBy(asc(connectorMessages.sequence))
        .limit(SERVER_REPLAY_BATCH_SIZE);
      return rows.map(toStoredServerMessage);
    });
  }

  async enqueueServer(
    identity: ConnectorIdentity,
    type: ConnectorServerMessage["type"],
    payload: Record<string, unknown>,
    expiresAt: Date,
    correlationId?: string,
  ): Promise<StoredServerMessage> {
    return this.#db.transaction(async (tx) => {
      const connector = await lockConnector(tx, identity);
      return enqueueServerMessage(
        tx,
        connector,
        type,
        payload,
        expiresAt,
        correlationId,
      );
    });
  }

  async materializeServerMessage(
    stored: StoredServerMessage,
    decryptor?: RequestDecryptor,
  ): Promise<ConnectorServerMessage> {
    let payload = stored.payload;
    if (stored.type === "job.offer") {
      const jobId = stored.payload.job_id;
      if (typeof jobId !== "string" || decryptor === undefined) {
        throw new ConnectorStoreError("INTERNAL", "Offer cannot be hydrated");
      }
      const rows = await this.#db
        .select({ ciphertext: jobs.requestCiphertext })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      const ciphertext = rows[0]?.ciphertext;
      if (ciphertext === null || ciphertext === undefined) {
        throw new ConnectorStoreError("INTERNAL", "Offer request is missing");
      }
      payload = {
        ...stored.payload,
        request: await decryptor.decrypt(ciphertext),
      };
    }
    return ConnectorServerMessageSchema.parse({
      protocol_version: "1.0",
      message_id: stored.messageId,
      sequence: stored.sequence,
      sent_at: stored.createdAt.toISOString(),
      expires_at: stored.expiresAt.toISOString(),
      correlation_id: stored.correlationId,
      type: stored.type,
      payload,
    });
  }

  async refreshHealth(now = new Date()): Promise<void> {
    const staleBefore = new Date(now.getTime() - CONNECTOR_STALE_AFTER_MS);
    const offlineBefore = new Date(now.getTime() - CONNECTOR_OFFLINE_AFTER_MS);
    await this.#db
      .update(connectors)
      .set({ health: "offline", updatedAt: now })
      .where(lte(connectors.lastHeartbeatAt, offlineBefore));
    await this.#db
      .update(connectors)
      .set({ health: "stale", updatedAt: now })
      .where(
        and(
          gt(connectors.lastHeartbeatAt, offlineBefore),
          lte(connectors.lastHeartbeatAt, staleBefore),
        ),
      );
  }
}

export const storedServerMessageContainsPlaintextRequest = (
  message: StoredServerMessage,
): boolean => Object.hasOwn(message.payload, "request");

export const activeAttemptForOffer = (job: JobRow): number => job.attempt + 1;
