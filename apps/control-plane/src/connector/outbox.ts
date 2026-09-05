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
  approvals,
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
const ACTIVE_OFFER_JOB_STATUS_VALUES = [
  "running",
  "waiting_approval",
  "cancelling",
] as const;
const CLAIMED_JOB_STATES: ReadonlySet<JobStatus> = new Set([
  ...ACTIVE_OFFER_JOB_STATUS_VALUES,
]);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryDatabase = Database | Transaction;
type ConnectorRow = typeof connectors.$inferSelect;
type ConnectorMessageRow = typeof connectorMessages.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type OriginalResponse = Readonly<{
  row: ConnectorMessageRow;
  type: ConnectorServerMessage["type"];
  payload: Record<string, unknown>;
}>;
type StoredResponseMetadata = Readonly<{
  type: unknown;
  payload: unknown;
  sequence: unknown;
  correlation_id?: unknown;
}>;

const STORED_RESPONSE_KEY = "__qhb_original_response";
const RECEIPT_PROFILE_KEY = "__qhb_receipt_profile";
const RECEIPT_ACK_KEY = "__qhb_receipt_ack";
const DURABLE_RECEIPTS = "durable-receipts-v1";
const BUSINESS_EXPIRED_MESSAGE = "The business deadline has expired.";
const CLAIM_REJECTED_MESSAGE =
  "The offered job was cancelled before it was claimed.";
const APPROVAL_SUMMARY_MAX_LENGTH = 800;

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
  | "MESSAGE_EXPIRED"
  | "INTERNAL";

export class ConnectorStoreError extends Error {
  readonly code: ConnectorStoreErrorCode;

  constructor(code: ConnectorStoreErrorCode, message: string = code) {
    super(message);
    this.name = "ConnectorStoreError";
    this.code = code;
  }
}

// Only explicit, authorized deadline checks may produce this disposition.
// A shared public error code alone is not sufficient evidence of expiry.
class BusinessDeadlineExpired extends ConnectorStoreError {
  constructor(code: "CLAIM_REJECTED" | "EVENT_REJECTED") {
    super(code, BUSINESS_EXPIRED_MESSAGE);
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
const UNSAFE_CONNECTOR_TEXT_PATTERNS = [
  /\bprocess\s*\.\s*env\b/iu,
  /\bconsole\s*\.\s*(?:log|error|warn|debug)\s*\(/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|credential|password|passwd|secret|token)\s*[:=]/iu,
  /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/iu,
  /\b(?:https?|ftp):\/\/[^\s"'<>]*:[^\s"'<>@/]+@[^\s"'<>]+/iu,
  /\b(?:https?|ftp):\/\/[^\s"'<>]*[?#][^\s"'<>]*/iu,
];

const containsUnsafeConnectorText = (value: string): boolean =>
  SOURCE_LIKE_EVENT_TEXT.test(value) ||
  UNSAFE_CONNECTOR_TEXT_PATTERNS.some((pattern) => pattern.test(value));

const sanitizeEventValue = (value: unknown): unknown => {
  if (typeof value === "string") return sanitizeConnectorText(value, 500);
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
): Record<string, unknown> => {
  const sanitized = sanitizeEventValue(payload) as Record<string, unknown>;
  if (
    typeof payload.summary === "string" &&
    payload.summary.trim().length === 0
  ) {
    delete sanitized.summary;
  }
  return sanitized;
};

const sanitizeConnectorText = (value: string, maxLength = 800): string => {
  const sanitized = sanitizePublicText(
    value.replace(SECRET_LIKE_CONNECTOR_TEXT, "[redacted]"),
    maxLength,
    maxLength,
    maxLength,
  );
  if (containsUnsafeConnectorText(sanitized)) {
    return SOURCE_LIKE_EVENT_TEXT.test(sanitized)
      ? "[redacted source content]"
      : "[redacted credential content]";
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
): boolean => {
  const durable =
    asRecord(row.payload)?.[RECEIPT_PROFILE_KEY] === DURABLE_RECEIPTS;
  if (
    row.direction !== "client" ||
    row.sequence !== message.sequence ||
    row.type !== message.type ||
    row.correlationId !== message.correlation_id ||
    (!durable && row.expiresAt.getTime() !== Date.parse(message.expires_at))
  ) {
    return false;
  }
  const payload = asRecord(row.payload);
  const comparablePayload =
    payload === null
      ? row.payload
      : Object.fromEntries(
          Object.entries(payload).filter(
            ([key]) =>
              key !== STORED_RESPONSE_KEY &&
              key !== RECEIPT_PROFILE_KEY &&
              key !== RECEIPT_ACK_KEY &&
              (!durable || key !== "expires_at_instant"),
          ),
        );
  return (
    canonicalJson(comparablePayload) ===
    canonicalJson(
      Object.fromEntries(
        Object.entries(storedClientPayload(message)).filter(
          ([key]) => !durable || key !== "expires_at_instant",
        ),
      ),
    )
  );
};

const findOriginalResponse = async (
  database: QueryDatabase,
  connectorId: string,
  message: ConnectorClientMessage,
  clientMessage: ConnectorMessageRow,
  responseKey = STORED_RESPONSE_KEY,
): Promise<OriginalResponse | null> => {
  const durable =
    asRecord(clientMessage.payload)?.[RECEIPT_PROFILE_KEY] === DURABLE_RECEIPTS;
  if (message.type === "ack" && !durable) return null;
  const storedPayload = asRecord(clientMessage.payload);
  const storedResponse: StoredResponseMetadata | null =
    storedPayload === null
      ? null
      : (asRecord(storedPayload[responseKey]) as StoredResponseMetadata | null);
  if (
    storedResponse === null ||
    typeof storedResponse.type !== "string" ||
    typeof storedResponse.sequence !== "number" ||
    !Number.isSafeInteger(storedResponse.sequence) ||
    storedResponse.sequence < 1
  ) {
    throw new ConnectorStoreError("INTERNAL", "Original response is missing");
  }

  const rows = await database
    .select()
    .from(connectorMessages)
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "server"),
        eq(connectorMessages.sequence, storedResponse.sequence),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new ConnectorStoreError("INTERNAL", "Original response is missing");
  }
  const row = rows[0];
  if (row === undefined) {
    throw new ConnectorStoreError("INTERNAL", "Original response is missing");
  }

  const validateResponse = (
    candidate: ConnectorMessageRow,
    type: unknown,
    payload: unknown,
    sequence: unknown,
    correlationId: unknown,
  ): OriginalResponse | null => {
    if (
      candidate.connectorId !== connectorId ||
      candidate.direction !== "server" ||
      candidate.correlationId !== message.correlation_id ||
      correlationId !== message.correlation_id ||
      sequence !== candidate.sequence ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      return null;
    }
    const createdAtMs = candidate.createdAt.getTime();
    const expiresAtMs = candidate.expiresAt.getTime();
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) {
      return null;
    }
    const schemaExpiresAt = new Date(Math.max(expiresAtMs, createdAtMs + 1));
    const parsed = ConnectorServerMessageSchema.safeParse({
      protocol_version: "1.0",
      message_id: candidate.messageId,
      sequence,
      sent_at: candidate.createdAt.toISOString(),
      expires_at: schemaExpiresAt.toISOString(),
      correlation_id: candidate.correlationId,
      type,
      payload,
    });
    if (!parsed.success) return null;
    const response = parsed.data;
    if (message.type === "connector.hello") {
      if (
        response.type !== "connector.welcome" ||
        response.payload.connector_id !== connectorId ||
        response.payload.server_sequence !== candidate.sequence ||
        response.payload.replay_from !==
          message.payload.last_server_sequence + 1
      ) {
        return null;
      }
    } else if (response.type === "ack") {
      if (response.payload.sequence !== message.sequence) return null;
    } else if (
      durable &&
      response.type === "protocol.error" &&
      [
        "job.claim",
        "job.event",
        "approval.requested",
        "job.cancelled",
      ].includes(message.type) &&
      response.payload.code ===
        (message.type === "job.claim" ? "CLAIM_REJECTED" : "EVENT_REJECTED") &&
      (response.payload.message === BUSINESS_EXPIRED_MESSAGE ||
        (message.type === "job.claim" &&
          response.payload.message === CLAIM_REJECTED_MESSAGE))
    ) {
      // The immutable receipt records this rejection; current capabilities and
      // current business state cannot reinterpret it during replay.
    } else if (
      message.type !== "job.claim" ||
      response.type !== "protocol.error" ||
      response.payload.code !== "CLAIM_REJECTED" ||
      response.payload.message !== CLAIM_REJECTED_MESSAGE
    ) {
      return null;
    }
    return {
      row: candidate,
      type: response.type,
      payload: response.payload as Record<string, unknown>,
    };
  };
  const storedCorrelationId = Object.hasOwn(storedResponse, "correlation_id")
    ? storedResponse.correlation_id
    : row.correlationId;
  if (
    storedCorrelationId !== row.correlationId ||
    (row.type !== storedResponse.type &&
      !(
        row.type === "protocol.error" && row.payload.code === "MESSAGE_EXPIRED"
      ))
  ) {
    throw new ConnectorStoreError("INTERNAL", "Original response is invalid");
  }
  if (row.type !== "protocol.error" || row.payload.code !== "MESSAGE_EXPIRED") {
    if (
      row.type !== storedResponse.type ||
      canonicalJson(row.payload) !== canonicalJson(storedResponse.payload)
    ) {
      throw new ConnectorStoreError("INTERNAL", "Original response is invalid");
    }
  }
  const response = validateResponse(
    row,
    storedResponse.type,
    storedResponse.payload,
    storedResponse.sequence,
    storedCorrelationId,
  );
  if (response === null) {
    throw new ConnectorStoreError("INTERNAL", "Original response is invalid");
  }
  return response;
};

const refreshServerMessage = async (
  database: QueryDatabase,
  originalResponse: OriginalResponse,
  now: Date,
): Promise<StoredServerMessage> => {
  const refreshed = await database
    .update(connectorMessages)
    .set({
      messageId: crypto.randomUUID(),
      type: originalResponse.type,
      payload: originalResponse.payload,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    })
    .where(
      and(
        eq(connectorMessages.id, originalResponse.row.id),
        eq(connectorMessages.messageId, originalResponse.row.messageId),
        eq(connectorMessages.direction, "server"),
      ),
    )
    .returning();
  const refreshedRow = refreshed[0];
  if (refreshedRow === undefined) {
    throw new ConnectorStoreError("INTERNAL", "Original response changed");
  }
  return toStoredServerMessage(refreshedRow);
};

const rememberOriginalResponse = async (
  database: QueryDatabase,
  connectorId: string,
  message: ConnectorClientMessage,
  response: StoredServerMessage,
  responseKey = STORED_RESPONSE_KEY,
): Promise<void> => {
  const updated = await database
    .update(connectorMessages)
    .set({
      payload: sql`${connectorMessages.payload} || ${JSON.stringify({
        [responseKey]: {
          type: response.type,
          payload: response.payload,
          sequence: response.sequence,
          correlation_id: response.correlationId,
        },
      })}::jsonb`,
    })
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "client"),
        eq(connectorMessages.messageId, message.message_id),
      ),
    )
    .returning({ id: connectorMessages.id });
  if (updated.length !== 1) {
    throw new ConnectorStoreError("INTERNAL", "Client message changed");
  }
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

const expiredTombstonePayload = (): Record<string, string> => ({
  code: "MESSAGE_EXPIRED",
  message: "A Connector message expired before delivery.",
});

const cancelledTombstonePayload = (): Record<string, string> => ({
  code: "JOB_CANCELLED",
  message: "The offered job was cancelled before it was claimed.",
});

const replaceServerMessage = async (
  database: QueryDatabase,
  row: ConnectorMessageRow,
  now: Date,
  payload: Record<string, string>,
  expectedType?: ConnectorMessageRow["type"],
  expired = false,
): Promise<void> => {
  await database
    .update(connectorMessages)
    .set({
      messageId: crypto.randomUUID(),
      type: "protocol.error",
      payload,
      expiresAt: new Date(now.getTime() + REPLAY_TOMBSTONE_RETENTION_MS),
    })
    .where(
      and(
        eq(connectorMessages.id, row.id),
        eq(connectorMessages.messageId, row.messageId),
        eq(connectorMessages.direction, "server"),
        expectedType === undefined
          ? undefined
          : eq(connectorMessages.type, expectedType),
        expired ? lte(connectorMessages.expiresAt, now) : undefined,
      ),
    );
};

/*
 * Durable cursor contract: hello last_server_sequence=N means N was durably
 * received, so N is not replayed even when its ACK was lost. With N-1, an
 * expired actionable row at N is the first durable receipt and is replaced
 * in place by a fresh-ID, same-sequence tombstone. Ordinary replay rows keep
 * their stored identity.
 */
const tombstoneReplayBatch = async (
  database: QueryDatabase,
  connectorId: string,
  afterSequence: number,
  now: Date,
): Promise<void> => {
  const candidates = await database
    .select({ message: connectorMessages, job: jobs })
    .from(connectorMessages)
    .leftJoin(
      jobs,
      sql`${jobs.id}::text = ${connectorMessages.payload}->>'job_id'`,
    )
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "server"),
        gt(connectorMessages.sequence, afterSequence),
        or(
          lte(connectorMessages.expiresAt, now),
          and(
            eq(connectorMessages.type, "job.offer"),
            inArray(jobs.status, [
              "cancelled",
              "expired",
              "failed",
              "succeeded",
            ]),
          ),
        ),
      ),
    )
    .orderBy(asc(connectorMessages.sequence))
    .limit(SERVER_REPLAY_BATCH_SIZE);
  for (const { message, job } of candidates) {
    const inactiveOffer = message.type === "job.offer" && job !== null;
    await replaceServerMessage(
      database,
      message,
      now,
      inactiveOffer && job.status === "cancelled"
        ? cancelledTombstonePayload()
        : expiredTombstonePayload(),
      inactiveOffer ? "job.offer" : undefined,
      !inactiveOffer || message.expiresAt.getTime() <= now.getTime(),
    );
  }
};

const validateConnector = (
  row: ConnectorRow | undefined,
  identity: ConnectorIdentity,
): ConnectorRow => {
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

const readConnector = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
): Promise<ConnectorRow> => {
  const rows = await database
    .select()
    .from(connectors)
    .where(eq(connectors.id, identity.connectorId))
    .limit(1);
  return validateConnector(rows[0], identity);
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
  return validateConnector(rows[0], identity);
};

const lockClientJob = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
  jobId: string,
): Promise<JobRow | undefined> => {
  const rows = await database
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.ownerId, identity.ownerId),
        eq(jobs.connectorId, identity.connectorId),
      ),
    )
    .for("update");
  return rows[0];
};

const hasExpiredOriginalOffer = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
  message: Extract<ConnectorClientMessage, { type: "job.claim" }>,
  now: Date,
): Promise<boolean> => {
  // The current job lock deliberately authorizes only its current connector.
  // Historical proof can authorize a rejection, never a mutation of that job.
  // Dispatch audits survive both reassignment and outbox tombstones. These
  // tuple fields are server-only (excluded from the client event allowlist).
  const rows = await database
    .select({
      payload: jobEvents.payload,
      repositoryId: jobs.repositoryId,
      leaseId: jobs.leaseId,
    })
    .from(jobEvents)
    .innerJoin(jobs, eq(jobs.id, jobEvents.jobId))
    .where(
      and(
        eq(jobEvents.jobId, message.payload.job_id),
        eq(jobs.ownerId, identity.ownerId),
        eq(jobEvents.source, "control-plane"),
        inArray(jobEvents.eventType, ["job.dispatched", "job.redispatched"]),
        sql`${jobEvents.payload}->>'lease_id' = ${message.payload.lease_id}`,
      ),
    )
    .limit(2);
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (row === undefined || row.leaseId === message.payload.lease_id)
    return false;
  const proof = asRecord(row.payload);
  if (
    proof?.owner_id !== identity.ownerId ||
    proof.connector_id !== identity.connectorId ||
    proof.repository_id !== row.repositoryId ||
    proof.attempt !== message.payload.attempt ||
    proof.lease_id !== message.payload.lease_id ||
    typeof proof.lease_expires_at !== "string"
  )
    return false;
  const deadline = Date.parse(proof.lease_expires_at);
  return (
    Number.isFinite(deadline) &&
    new Date(deadline).toISOString() === proof.lease_expires_at &&
    deadline <= now.getTime()
  );
};

const readDatabaseTime = async (database: QueryDatabase): Promise<Date> => {
  const rows = await database.execute(
    sql`select clock_timestamp() as "currentTime"`,
  );
  const value = (rows[0] as { currentTime?: Date | string } | undefined)
    ?.currentTime;
  if (value === undefined) {
    throw new ConnectorStoreError(
      "INTERNAL",
      "Current database time is missing",
    );
  }
  const currentTime = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(currentTime.getTime())) {
    throw new ConnectorStoreError(
      "INTERNAL",
      "Current database time is invalid",
    );
  }
  return currentTime;
};

const assertDeadlinesAfterWrite = async (
  database: QueryDatabase,
  deadlines: readonly Date[],
): Promise<void> => {
  // The first deadline is transport admission; the remaining deadlines belong
  // to the business operation. Only the latter justify a consumed rejection.
  const currentTime = await readDatabaseTime(database);
  if (
    deadlines
      .slice(1)
      .some((deadline) => deadline.getTime() <= currentTime.getTime())
  ) {
    throw new BusinessDeadlineExpired("EVENT_REJECTED");
  }
  if (
    deadlines.some((deadline) => deadline.getTime() <= currentTime.getTime())
  ) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }
};

const databaseErrorCode = (error: unknown): string | undefined => {
  let candidate = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (candidate === null || typeof candidate !== "object") return;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string") return code;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return;
};

const enqueueServerMessage = async (
  database: QueryDatabase,
  connector: ConnectorRow,
  type: ConnectorServerMessage["type"],
  payload: Record<string, unknown>,
  expiresAt: Date | undefined,
  correlationId: string = crypto.randomUUID(),
): Promise<StoredServerMessage> => {
  const effectiveExpiresAt =
    expiresAt ??
    new Date((await readDatabaseTime(database)).getTime() + 60_000);
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
      expiresAt: effectiveExpiresAt,
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

const hasUsableTerminalSummary = (
  payload: Record<string, unknown>,
): boolean => {
  if (typeof payload.summary === "string") {
    return payload.summary.trim().length > 0;
  }
  return (
    payload.summary !== null &&
    typeof payload.summary === "object" &&
    !Array.isArray(payload.summary) &&
    Object.keys(payload.summary).length > 0
  );
};

const ingestApprovalRequested = async (
  database: QueryDatabase,
  message: Extract<ConnectorClientMessage, { type: "approval.requested" }>,
  job: JobRow | undefined,
  now: Date,
): Promise<void> => {
  if (
    job === undefined ||
    !["running", "waiting_approval"].includes(job.status) ||
    job.attempt !== message.payload.attempt ||
    message.payload.job_revision !== job.revision + 1
  ) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }

  if (
    job.expiresAt.getTime() <= now.getTime() ||
    Date.parse(message.payload.expires_at) <= now.getTime()
  ) {
    throw new BusinessDeadlineExpired("EVENT_REJECTED");
  }

  const actionSummary = sanitizeConnectorText(
    message.payload.action_summary,
    400,
  );
  const impactSummary = sanitizeConnectorText(
    message.payload.impact_summary,
    APPROVAL_SUMMARY_MAX_LENGTH,
  );
  const riskClass = sanitizeConnectorText(message.payload.risk_class, 64);
  const updatedRows = await database
    .update(jobs)
    .set({
      status: "waiting_approval",
      currentStage: "waiting_approval",
      revision: sql`${jobs.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.revision, job.revision),
        eq(jobs.attempt, message.payload.attempt),
        sql`${jobs.expiresAt} > clock_timestamp()`,
        sql`${new Date(message.payload.expires_at).toISOString()}::timestamptz > clock_timestamp()`,
        sql`${new Date(message.expires_at).toISOString()}::timestamptz > clock_timestamp()`,
      ),
    )
    .returning({ id: jobs.id });
  if (updatedRows.length !== 1) {
    await assertDeadlinesAfterWrite(database, [
      new Date(message.expires_at),
      job.expiresAt,
      new Date(message.payload.expires_at),
    ]);
    throw new ConnectorStoreError("EVENT_REJECTED");
  }

  try {
    await database.insert(approvals).values({
      id: message.payload.approval_id,
      jobId: job.id,
      attempt: message.payload.attempt,
      jobRevision: message.payload.job_revision,
      actionSummary,
      impactSummary,
      actionFingerprint: message.payload.action_fingerprint,
      riskClass,
      expiresAt: new Date(message.payload.expires_at),
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      throw new ConnectorStoreError("EVENT_REJECTED");
    }
    throw error;
  }
  await appendJobEvent(database, job.id, {
    type: "approval.requested",
    payload: {
      approval_id: message.payload.approval_id,
      attempt: message.payload.attempt,
      job_revision: message.payload.job_revision,
      action_summary: actionSummary,
      impact_summary: impactSummary,
      risk_class: riskClass,
      action_fingerprint: message.payload.action_fingerprint,
      expires_at: message.payload.expires_at,
    },
    source: "connector",
    messageId: message.message_id,
    correlationId: message.correlation_id,
  });
  await assertDeadlinesAfterWrite(database, [
    new Date(message.expires_at),
    job.expiresAt,
    new Date(message.payload.expires_at),
  ]);
};

const ingestJobCancelled = async (
  database: QueryDatabase,
  message: Extract<ConnectorClientMessage, { type: "job.cancelled" }>,
  job: JobRow | undefined,
  now: Date,
): Promise<void> => {
  if (job === undefined || job.attempt !== message.payload.attempt) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }

  const reason = sanitizeConnectorText(message.payload.reason, 400);
  const active = job.status === "cancelling";
  if (active) {
    if (job.expiresAt.getTime() <= now.getTime()) {
      throw new BusinessDeadlineExpired("EVENT_REJECTED");
    }
    const updatedRows = await database
      .update(jobs)
      .set({
        status: "cancelled",
        currentStage: "cancelled",
        revision: sql`${jobs.revision} + 1`,
        terminalAt: sql`coalesce(${jobs.terminalAt}, clock_timestamp())`,
        requestDeleteAt: sql`coalesce(${jobs.requestDeleteAt}, clock_timestamp() + interval '24 hours')`,
        unreadTerminal: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "cancelling"),
          eq(jobs.attempt, message.payload.attempt),
          sql`${jobs.expiresAt} > clock_timestamp()`,
          sql`${new Date(message.expires_at).toISOString()}::timestamptz > clock_timestamp()`,
        ),
      )
      .returning({ id: jobs.id });
    if (updatedRows.length !== 1) {
      await assertDeadlinesAfterWrite(database, [
        new Date(message.expires_at),
        job.expiresAt,
      ]);
      throw new ConnectorStoreError("EVENT_REJECTED");
    }
  } else if (!TERMINAL_JOB_STATES.has(job.status)) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }

  await appendJobEvent(database, job.id, {
    type: "job.cancelled",
    payload: {
      job_id: message.payload.job_id,
      attempt: message.payload.attempt,
      reason,
    },
    source: "connector",
    messageId: message.message_id,
    correlationId: message.correlation_id,
  });
  await assertDeadlinesAfterWrite(
    database,
    active
      ? [new Date(message.expires_at), job.expiresAt]
      : [new Date(message.expires_at)],
  );
};

const withdrawCancelledOffer = async (
  database: QueryDatabase,
  connectorId: string,
  jobId: string,
  leaseId: string,
  now: Date,
): Promise<void> => {
  const rows = await database
    .select()
    .from(connectorMessages)
    .where(
      and(
        eq(connectorMessages.connectorId, connectorId),
        eq(connectorMessages.direction, "server"),
        eq(connectorMessages.type, "job.offer"),
        sql`${connectorMessages.payload}->>'job_id' = ${jobId}`,
        sql`${connectorMessages.payload}->>'lease_id' = ${leaseId}`,
      ),
    )
    .limit(1)
    .for("update");
  const offer = rows[0];
  if (offer !== undefined) {
    await replaceServerMessage(
      database,
      offer,
      now,
      cancelledTombstonePayload(),
      "job.offer",
    );
  }
};

const claimOfferedJob = async (
  database: QueryDatabase,
  identity: ConnectorIdentity,
  message: Extract<ConnectorClientMessage, { type: "job.claim" }>,
  job: JobRow | undefined,
  now: Date,
  durable = false,
): Promise<"claimed" | "cancelled"> => {
  if (
    job !== undefined &&
    job.status === "cancelled" &&
    job.expiresAt.getTime() > now.getTime() &&
    job.leaseId === message.payload.lease_id &&
    message.payload.attempt === job.attempt + 1
  ) {
    await withdrawCancelledOffer(
      database,
      identity.connectorId,
      job.id,
      message.payload.lease_id,
      now,
    );
    return "cancelled";
  }
  if (
    job === undefined ||
    job.status !== "dispatched" ||
    job.leaseId !== message.payload.lease_id ||
    job.leaseExpiresAt === null ||
    message.payload.attempt !== job.attempt + 1
  ) {
    throw new ConnectorStoreError("CLAIM_REJECTED");
  }
  if (
    job.leaseExpiresAt.getTime() <= now.getTime() ||
    job.expiresAt.getTime() <= now.getTime()
  ) {
    throw new BusinessDeadlineExpired("CLAIM_REJECTED");
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
        sql`${jobs.leaseExpiresAt} > clock_timestamp()`,
        sql`${jobs.expiresAt} > clock_timestamp()`,
        sql`${new Date(message.expires_at).toISOString()}::timestamptz > clock_timestamp()`,
      ),
    )
    .returning({ id: jobs.id });
  if (updated.length !== 1) {
    const at = await readDatabaseTime(database);
    if (
      job.leaseExpiresAt.getTime() <= at.getTime() ||
      job.expiresAt.getTime() <= at.getTime()
    ) {
      throw new BusinessDeadlineExpired("CLAIM_REJECTED");
    }
    throw new ConnectorStoreError("CLAIM_REJECTED");
  }
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
  if (durable) {
    const at = await readDatabaseTime(database);
    if (
      job.leaseExpiresAt.getTime() <= at.getTime() ||
      job.expiresAt.getTime() <= at.getTime()
    ) {
      throw new BusinessDeadlineExpired("CLAIM_REJECTED");
    }
  }
  return "claimed";
};

const terminalStatusForEvent = (
  eventType: string,
  payload: Record<string, unknown>,
): JobStatus | null => {
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
  return null;
};

const statusForEvent = (
  current: JobStatus,
  eventType: string,
  payload: Record<string, unknown>,
): JobStatus => {
  const terminal = terminalStatusForEvent(eventType, payload);
  if (terminal !== null) return terminal;
  const explicit = payload.status;
  const candidate =
    typeof explicit === "string" ? explicit : eventType.toLowerCase();
  if (candidate === "waiting_approval") return "waiting_approval";
  if (candidate === "running" || candidate === "resumed") return "running";
  return current;
};

const ingestJobEvent = async (
  database: QueryDatabase,
  message: Extract<ConnectorClientMessage, { type: "job.event" }>,
  job: JobRow | undefined,
  now: Date,
): Promise<void> => {
  if (job === undefined || job.attempt !== message.payload.attempt) {
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
  const terminal =
    terminalStatusForEvent(sanitizedEventType, sanitizedPayload) !== null;
  if (TERMINAL_JOB_STATES.has(job.status)) {
    if (!terminal) throw new ConnectorStoreError("EVENT_REJECTED");
    await appendJobEvent(database, job.id, {
      type: sanitizedEventType,
      payload: sanitizedPayload,
      source: sanitizedSource,
      messageId: message.message_id,
      correlationId: message.correlation_id,
    });
    await assertDeadlinesAfterWrite(database, [new Date(message.expires_at)]);
    return;
  }
  if (!CLAIMED_JOB_STATES.has(job.status)) {
    throw new ConnectorStoreError("EVENT_REJECTED");
  }
  if (job.expiresAt.getTime() <= now.getTime()) {
    throw new BusinessDeadlineExpired("EVENT_REJECTED");
  }
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
            summary: hasUsableTerminalSummary(sanitizedPayload)
              ? sanitizedPayload
              : null,
          }
        : {}),
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.revision, job.revision),
        sql`${jobs.expiresAt} > clock_timestamp()`,
        sql`${new Date(message.expires_at).toISOString()}::timestamptz > clock_timestamp()`,
      ),
    )
    .returning({ id: jobs.id });
  if (updated.length !== 1) {
    await assertDeadlinesAfterWrite(database, [
      new Date(message.expires_at),
      job.expiresAt,
    ]);
    throw new ConnectorStoreError("EVENT_REJECTED");
  }
  await appendJobEvent(database, job.id, {
    type: sanitizedEventType,
    payload: sanitizedPayload,
    source: sanitizedSource,
    messageId: message.message_id,
    correlationId: message.correlation_id,
  });
  await assertDeadlinesAfterWrite(database, [
    new Date(message.expires_at),
    job.expiresAt,
  ]);
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
    _callerNow?: Date,
  ): Promise<ClientMessageAcceptance> {
    return this.#db.transaction(async (tx) => {
      const lockedJob =
        message.type === "job.claim" ||
        message.type === "job.event" ||
        message.type === "approval.requested" ||
        message.type === "job.cancelled"
          ? await lockClientJob(tx, identity, message.payload.job_id)
          : undefined;
      const connector = await lockConnector(tx, identity);
      const currentTime = await readDatabaseTime(tx);
      const durable =
        message.type === "connector.hello"
          ? message.payload.capabilities?.includes(DURABLE_RECEIPTS) === true
          : connector.capabilities.includes(DURABLE_RECEIPTS);
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
        // Only the immutable profile on this receipt grants expired replay.
        // Reject legacy expiry before restoring responses or refreshing health.
        const durableReceipt =
          asRecord(existing.payload)?.[RECEIPT_PROFILE_KEY] ===
          DURABLE_RECEIPTS;
        if (
          durableReceipt
            ? Date.parse(message.expires_at) > currentTime.getTime() + 60_000
            : Date.parse(message.expires_at) <= currentTime.getTime()
        ) {
          throw new ConnectorStoreError("CLIENT_REPLAY_MISMATCH");
        }
        const originalResponse = await findOriginalResponse(
          tx,
          connector.id,
          message,
          existing,
        );
        const responseNeedsRefresh =
          originalResponse !== null &&
          (originalResponse.row.expiresAt.getTime() <= currentTime.getTime() ||
            originalResponse.row.type !== originalResponse.type ||
            canonicalJson(originalResponse.row.payload) !==
              canonicalJson(originalResponse.payload));
        let response =
          originalResponse === null
            ? null
            : responseNeedsRefresh
              ? await refreshServerMessage(
                  tx,
                  originalResponse,
                  await readDatabaseTime(tx),
                )
              : toStoredServerMessage(originalResponse.row);
        const replay: StoredServerMessage[] = [];
        if (asRecord(existing.payload)?.[RECEIPT_ACK_KEY] !== undefined) {
          const originalAck = await findOriginalResponse(
            tx,
            connector.id,
            message,
            existing,
            RECEIPT_ACK_KEY,
          );
          if (
            response === null ||
            originalAck === null ||
            originalAck.type !== "ack" ||
            originalAck.row.sequence !== response.sequence + 1
          ) {
            throw new ConnectorStoreError(
              "INTERNAL",
              "Original receipt order is invalid",
            );
          }
          replay.push(response);
          response =
            originalAck.row.expiresAt.getTime() <= currentTime.getTime() ||
            originalAck.row.type !== originalAck.type
              ? await refreshServerMessage(
                  tx,
                  originalAck,
                  await readDatabaseTime(tx),
                )
              : toStoredServerMessage(originalAck.row);
        }
        if (
          message.type === "connector.heartbeat" &&
          asRecord(existing.payload)?.[RECEIPT_PROFILE_KEY] !== DURABLE_RECEIPTS
        ) {
          await tx
            .update(connectors)
            .set({
              lastHeartbeatAt: currentTime,
              health: "fresh",
              updatedAt: currentTime,
            })
            .where(eq(connectors.id, connector.id));
        }
        return { duplicate: true, replay, response };
      }

      if (
        Date.parse(message.expires_at) <= currentTime.getTime() ||
        (durable &&
          Date.parse(message.expires_at) > currentTime.getTime() + 60_000)
      ) {
        throw new ConnectorStoreError(
          "CLIENT_REPLAY_MISMATCH",
          "Expired message",
        );
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
      if (message.type === "ack") {
        const serverRows = await tx
          .select({ id: connectorMessages.id })
          .from(connectorMessages)
          .where(
            and(
              eq(connectorMessages.connectorId, connector.id),
              eq(connectorMessages.direction, "server"),
              eq(connectorMessages.sequence, message.payload.sequence),
            ),
          )
          .limit(1);
        if (serverRows[0] === undefined) {
          throw new ConnectorStoreError(
            "CLIENT_REPLAY_MISMATCH",
            "ACK references a missing server message",
          );
        }
      }

      await tx.insert(connectorMessages).values({
        connectorId: connector.id,
        direction: "client",
        sequence: message.sequence,
        messageId: message.message_id,
        type: message.type,
        payload: {
          ...storedClientPayload(message),
          ...(durable ? { [RECEIPT_PROFILE_KEY]: DURABLE_RECEIPTS } : {}),
        },
        correlationId: message.correlation_id,
        expiresAt: new Date(message.expires_at),
      });

      let claimResult: "claimed" | "cancelled" | undefined;
      let rejection: BusinessDeadlineExpired | undefined;
      let historicalClaimExpired = false;
      const applyBusiness = async (businessTx: Transaction): Promise<void> => {
        if (message.type === "job.claim") {
          if (durable && lockedJob?.leaseId !== message.payload.lease_id) {
            historicalClaimExpired = await hasExpiredOriginalOffer(
              businessTx,
              identity,
              message,
              currentTime,
            );
            if (historicalClaimExpired)
              throw new BusinessDeadlineExpired("CLAIM_REJECTED");
          }
          claimResult = await claimOfferedJob(
            businessTx,
            identity,
            message,
            lockedJob,
            currentTime,
            durable,
          );
        } else if (message.type === "job.event") {
          await ingestJobEvent(businessTx, message, lockedJob, currentTime);
        } else if (message.type === "approval.requested") {
          await ingestApprovalRequested(
            businessTx,
            message,
            lockedJob,
            currentTime,
          );
        } else if (message.type === "job.cancelled") {
          await ingestJobCancelled(businessTx, message, lockedJob, currentTime);
        } else if (message.type === "ack") {
          await businessTx
            .update(connectorMessages)
            .set({ acknowledgedAt: currentTime })
            .where(
              and(
                eq(connectorMessages.connectorId, connector.id),
                eq(connectorMessages.direction, "server"),
                eq(connectorMessages.sequence, message.payload.sequence),
              ),
            );
        }
      };
      if (durable) {
        try {
          await tx.transaction(applyBusiness);
        } catch (error) {
          if (
            !(error instanceof BusinessDeadlineExpired) ||
            (lockedJob === undefined && !historicalClaimExpired)
          )
            throw error;
          rejection = error;
        }
      } else {
        await applyBusiness(tx);
      }

      const capabilities =
        message.type === "connector.hello"
          ? (message.payload.capabilities?.map((capability: string) =>
              sanitizeConnectorText(capability, 64),
            ) ??
            connector.capabilities.filter(
              (capability) => capability !== DURABLE_RECEIPTS,
            ))
          : connector.capabilities;
      const isHeartbeat =
        message.type === "connector.hello" ||
        message.type === "connector.heartbeat";
      await tx
        .update(connectors)
        .set({
          lastClientSequence: message.sequence,
          ...(isHeartbeat
            ? { lastHeartbeatAt: currentTime, health: "fresh" as const }
            : {}),
          capabilities,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(connectors.id, connector.id),
            eq(connectors.lastClientSequence, connector.lastClientSequence),
          ),
        );
      connector.lastClientSequence = message.sequence;
      if (isHeartbeat) {
        connector.lastHeartbeatAt = currentTime;
        connector.health = "fresh";
      }

      if (message.type === "connector.hello") {
        await tx
          .update(connectorMessages)
          .set({ acknowledgedAt: currentTime })
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
        await tombstoneReplayBatch(
          tx,
          connector.id,
          message.payload.last_server_sequence,
          currentTime,
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
            ...(durable ? { capabilities: [DURABLE_RECEIPTS] } : {}),
          },
          new Date(currentTime.getTime() + 60_000),
          message.correlation_id,
        );
        await rememberOriginalResponse(tx, connector.id, message, welcome);
        return {
          duplicate: false,
          replay: replayRows.map(toStoredServerMessage),
          response: welcome,
        };
      }

      const response =
        message.type === "ack" && !durable
          ? null
          : claimResult === "cancelled" || rejection !== undefined
            ? await enqueueServerMessage(
                tx,
                connector,
                "protocol.error",
                {
                  code: rejection?.code ?? "CLAIM_REJECTED",
                  message:
                    rejection === undefined
                      ? CLAIM_REJECTED_MESSAGE
                      : BUSINESS_EXPIRED_MESSAGE,
                },
                new Date(currentTime.getTime() + 60_000),
                message.correlation_id,
              )
            : await enqueueServerMessage(
                tx,
                connector,
                "ack",
                { sequence: message.sequence },
                new Date(currentTime.getTime() + 60_000),
                message.correlation_id,
              );
      if (response !== null) {
        await rememberOriginalResponse(tx, connector.id, message, response);
      }
      if (durable && response?.type === "protocol.error") {
        const ack = await enqueueServerMessage(
          tx,
          connector,
          "ack",
          { sequence: message.sequence },
          undefined,
          message.correlation_id,
        );
        await rememberOriginalResponse(
          tx,
          connector.id,
          message,
          ack,
          RECEIPT_ACK_KEY,
        );
        return { duplicate: false, replay: [response], response: ack };
      }
      return { duplicate: false, replay: [], response };
    });
  }

  async dispatchNext(
    identity: ConnectorIdentity,
    _callerNow?: Date,
  ): Promise<StoredServerMessage | null> {
    return this.#db.transaction(async (tx) => {
      await readConnector(tx, identity);
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

      const admissionTime = await readDatabaseTime(tx);
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
              and(
                eq(jobs.status, "dispatched"),
                gt(jobs.leaseExpiresAt, admissionTime),
              ),
            ),
            gt(jobs.expiresAt, admissionTime),
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
              and(
                eq(jobs.status, "dispatched"),
                lte(jobs.leaseExpiresAt, admissionTime),
              ),
            ),
            gt(jobs.expiresAt, admissionTime),
          ),
        )
        .orderBy(asc(jobs.acceptedAt), asc(jobs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      const job = jobRows[0];
      if (job === undefined) return null;
      const connector = await lockConnector(tx, identity);
      const currentTime = await readDatabaseTime(tx);
      if (job.expiresAt.getTime() <= currentTime.getTime()) return null;
      if (job.requestCiphertext === null) {
        throw new ConnectorStoreError("INTERNAL", "Queued request is missing");
      }
      const redispatch = job.status === "dispatched";
      if (
        redispatch &&
        (job.leaseId === null ||
          job.leaseExpiresAt === null ||
          job.leaseExpiresAt.getTime() > currentTime.getTime())
      ) {
        throw new ConnectorStoreError("INTERNAL", "Offer lease is invalid");
      }
      const leaseId = crypto.randomUUID();
      const leaseExpiresAt = new Date(
        Math.min(
          currentTime.getTime() + OFFER_LEASE_MS,
          job.expiresAt.getTime(),
        ),
      );
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
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, job.status),
            eq(jobs.revision, job.revision),
            redispatch && job.leaseId !== null
              ? eq(jobs.leaseId, job.leaseId)
              : undefined,
            sql`${jobs.expiresAt} > clock_timestamp()`,
            redispatch
              ? sql`${jobs.leaseExpiresAt} <= clock_timestamp()`
              : undefined,
          ),
        )
        .returning({ id: jobs.id });
      if (updated.length !== 1) return null;
      await appendJobEvent(tx, job.id, {
        type: redispatch ? "job.redispatched" : "job.dispatched",
        payload: {
          owner_id: job.ownerId,
          repository_id: job.repositoryId,
          connector_id: identity.connectorId,
          attempt,
          lease_id: leaseId,
          lease_expires_at: leaseExpiresAt.toISOString(),
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
    _callerNow?: Date,
  ): Promise<readonly StoredServerMessage[]> {
    assertSafeSequence(afterSequence);
    return this.#db.transaction(async (tx) => {
      const connector = await lockConnector(tx, identity);
      const currentTime = await readDatabaseTime(tx);
      await tombstoneReplayBatch(tx, connector.id, afterSequence, currentTime);
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
    expiresAt?: Date,
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
    _callerNow?: Date,
    _callerCurrentTime?: () => Date,
  ): Promise<ConnectorServerMessage> {
    const jobId = stored.payload.job_id;
    const leaseId = stored.payload.lease_id;
    const attempt = stored.payload.attempt;
    const assertNotExpired = (at: Date): void => {
      if (stored.expiresAt.getTime() <= at.getTime()) {
        throw new ConnectorStoreError(
          "MESSAGE_EXPIRED",
          "The Connector message expired before materialization",
        );
      }
    };
    const readActionableOffer = async (at: Date): Promise<string> => {
      if (
        typeof jobId !== "string" ||
        typeof leaseId !== "string" ||
        typeof attempt !== "number" ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1
      ) {
        throw new ConnectorStoreError(
          "MESSAGE_EXPIRED",
          "The Connector offer is no longer actionable",
        );
      }
      const rows = await this.#db
        .select({ message: connectorMessages, job: jobs })
        .from(connectorMessages)
        .innerJoin(jobs, eq(jobs.id, jobId))
        .where(
          and(
            eq(connectorMessages.connectorId, stored.connectorId),
            eq(connectorMessages.direction, "server"),
            eq(connectorMessages.sequence, stored.sequence),
            eq(connectorMessages.messageId, stored.messageId),
            eq(connectorMessages.type, "job.offer"),
            eq(connectorMessages.expiresAt, stored.expiresAt),
            or(
              and(eq(jobs.status, "dispatched"), eq(jobs.attempt, attempt - 1)),
              and(
                inArray(jobs.status, ACTIVE_OFFER_JOB_STATUS_VALUES),
                eq(jobs.attempt, attempt),
              ),
            ),
            eq(jobs.connectorId, stored.connectorId),
            eq(jobs.leaseId, leaseId),
            gt(connectorMessages.expiresAt, at),
            gt(jobs.leaseExpiresAt, at),
            gt(jobs.expiresAt, at),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (
        row === undefined ||
        row.message.payload.job_id !== jobId ||
        row.message.payload.lease_id !== leaseId ||
        row.message.payload.attempt !== attempt ||
        row.job.requestCiphertext === null
      ) {
        throw new ConnectorStoreError(
          "MESSAGE_EXPIRED",
          "The Connector offer is no longer actionable",
        );
      }
      return row.job.requestCiphertext;
    };
    let payload = stored.payload;
    if (stored.type === "job.offer") {
      if (typeof jobId !== "string" || decryptor === undefined) {
        throw new ConnectorStoreError("INTERNAL", "Offer cannot be hydrated");
      }
      const beforeDecrypt = await readDatabaseTime(this.#db);
      assertNotExpired(beforeDecrypt);
      const ciphertext = await readActionableOffer(beforeDecrypt);
      payload = {
        ...stored.payload,
        request: await decryptor.decrypt(ciphertext),
      };
      const afterDecrypt = await readDatabaseTime(this.#db);
      await readActionableOffer(afterDecrypt);
      assertNotExpired(afterDecrypt);
    } else {
      assertNotExpired(await readDatabaseTime(this.#db));
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

  async refreshHealth(_now?: Date): Promise<void> {
    const currentTime = await readDatabaseTime(this.#db);
    const staleBefore = new Date(
      currentTime.getTime() - CONNECTOR_STALE_AFTER_MS,
    );
    const offlineBefore = new Date(
      currentTime.getTime() - CONNECTOR_OFFLINE_AFTER_MS,
    );
    await this.#db
      .update(connectors)
      .set({ health: "offline", updatedAt: currentTime })
      .where(lte(connectors.lastHeartbeatAt, offlineBefore));
    await this.#db
      .update(connectors)
      .set({ health: "stale", updatedAt: currentTime })
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
