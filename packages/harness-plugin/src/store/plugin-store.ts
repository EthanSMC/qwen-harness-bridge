import { readFileSync } from "node:fs";
import {
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  activeOwnedKey,
  captureOwned,
  freezeOwned,
  generationOwnedKey,
  initialOwnedIntent,
  OwnedAttemptSchema,
  type OwnedIntent,
  OwnedIntentError,
  type OwnedIntentOwner,
  OwnedIntentOwnerSchema,
  OwnedIntentSchema,
  type OwnedIntentTransition,
  OwnedTransitionSchema,
  OwnedVersionSchema,
  ownedJson,
  ownedKey,
  type PrepareOwnedIntentInput,
  PrepareOwnedIntentSchema,
  parseOwnedRecord,
} from "./owned-intent.js";

export type { OwnedIntent, OwnedIntentOwner } from "./owned-intent.js";
export { OwnedIntentError } from "./owned-intent.js";

const SCHEMA_SQL = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);
const SCHEMA_VERSION = 1;

export type LocalJobMapping = Readonly<{
  jobId: string;
  attempt: number;
  sessionId: string;
  status: string;
}>;

export type OutboundEventInput = Readonly<{
  expectedReceiptProfile?: "job-coordination-v1";
  messageId: string;
  sequence: number;
  payload: string;
}>;

export type StoredOutboundEvent = Readonly<{
  expectedReceiptProfile?: "job-coordination-v1";
  messageId: string;
  sequence: number;
  payload: string;
  attempts: number;
  acknowledgedAt: string | null;
}>;

export type StoredInboundMessage = Readonly<{
  messageId: string;
  sequence: number;
  body: string;
  delivered: boolean;
}>;

export type InboundReplacement = Readonly<{
  coordinationRequestSequence?: number;
  previousMessageId: string;
  previousBody: string;
  messageId: string;
  sequence: number;
  body: string;
}>;

export interface PluginStore {
  recordInbound(
    messageId: string,
    sequence: number,
    body: string,
    evidence?: Readonly<{ coordinationRequestSequence: number }>,
  ): "new" | "duplicate";
  maxInboundSequence(): number;
  inboundMessage(messageId: string): StoredInboundMessage | undefined;
  inboundMessageBySequence(sequence: number): StoredInboundMessage | undefined;
  replaceInbound(replacement: InboundReplacement): void;
  pendingInboundMessages(): StoredInboundMessage[];
  markInboundDelivered(messageId: string): void;
  markInboundExpired(messageId: string): void;
  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void;
  findJob(jobId: string): LocalJobMapping | undefined;
  listNonterminalJobs(): readonly LocalJobMapping[];
  maxOutboundSequence(): number;
  enqueueEvent(event: OutboundEventInput, pinHello?: boolean): void;
  activeHello(): StoredOutboundEvent | undefined;
  outboundEvent(sequence: number): StoredOutboundEvent | undefined;
  renewDelivery(sequence: number, expiresAt: string): StoredOutboundEvent;
  provenClientSequence(): number;
  acknowledgeThrough(sequence: number, correlationId: string): void;
  pendingEvents(afterSequence: number): StoredOutboundEvent[];
  acknowledgeEvent(messageId: string): void;
  close(): void;
}

const CoordinationReceiptSchema = z
  .object({
    expectedReceiptProfile: z.literal("job-coordination-v1"),
    requestSequence: z.number().int().positive().safe(),
    requestMessageId: z.string(),
    requestCorrelationId: z.string(),
    requestType: z.enum([
      "job.sync",
      "job.claim",
      "job.event",
      "approval.requested",
      "job.cancelled",
    ]),
    responseSequence: z.number().int().positive().safe(),
    responseCorrelationId: z.string(),
    responseType: z.enum(["job.state", "protocol.error"]),
    responsePayloadJson: z.string(),
  })
  .strict();

export type StoredCoordinationReceipt = Readonly<
  z.infer<typeof CoordinationReceiptSchema>
>;

export interface CoordinatingPluginStore extends PluginStore {
  coordinationReceipt(sequence: number): StoredCoordinationReceipt | undefined;
  coordinationRequest(correlationId: string): StoredOutboundEvent | undefined;
}

export interface OwnedIntentPluginStore extends CoordinatingPluginStore {
  prepareOwnedIntent(input: PrepareOwnedIntentInput): OwnedIntent;
  ownedIntent(jobId: string, attempt: number): OwnedIntent | undefined;
  listOwnedIntents(): readonly OwnedIntent[];
  advanceOwnedIntent(
    owner: OwnedIntentOwner,
    expectedVersion: number,
    transition: OwnedIntentTransition,
  ): OwnedIntent;
}

export class StoreSequenceError extends Error {
  readonly code = "STORE_SEQUENCE_NOT_MONOTONIC" as const;

  constructor() {
    super("STORE_SEQUENCE_NOT_MONOTONIC");
    this.name = "StoreSequenceError";
  }
}

export class StoreInboundConflictError extends Error {
  readonly code = "STORE_INBOUND_CONFLICT" as const;

  constructor() {
    super("STORE_INBOUND_CONFLICT");
    this.name = "StoreInboundConflictError";
  }
}

class StoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}

const now = (): string => new Date().toISOString();
const INBOUND_DELIVERED_METADATA_PREFIX = "inbound-delivered:";
const OUTBOUND_PROFILE_PREFIX = "outbound-receipt-profile:";
const COORDINATION_PROFILE = "job-coordination-v1";
const INBOUND_RECEIPT_PREFIX = "inbound-coordination-receipt:";

// Strict state and error payloads contain only scalar fields.
const canonicalPayload = (payload: object): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );

const parseResponse = (messageId: string, sequence: number, body: string) => {
  const decoded = JSON.parse(body);
  const parsed = ConnectorServerMessageSchema.parse(decoded);
  // Coordination evidence must not acquire exact fixed-error semantics through
  // the shared legacy schema's trimming. Compare decoded scalars, not JSON bytes.
  if (
    parsed.type === "protocol.error" &&
    (decoded.payload.code !== parsed.payload.code ||
      decoded.payload.message !== parsed.payload.message)
  )
    throw new Error();
  if (parsed.message_id !== messageId || parsed.sequence !== sequence)
    throw new Error();
  return parsed;
};

const isExpiryPlaceholder = (
  response: ReturnType<typeof parseResponse>,
): boolean =>
  response.type === "protocol.error" &&
  response.payload.code === "MESSAGE_EXPIRED" &&
  response.payload.message === "A Connector message expired before delivery.";

const parseRequest = (event: OutboundEventInput) => {
  const parsed = ConnectorClientMessageSchema.parse(JSON.parse(event.payload));
  if (
    parsed.message_id !== event.messageId ||
    parsed.sequence !== event.sequence
  ) {
    throw new StoreError("STORE_COORDINATION_INVALID");
  }
  return parsed;
};

const assertNonEmpty = (value: string, code: string): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreError(code);
  }
};

const assertPositiveInteger = (value: number, code: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StoreError(code);
  }
};

const assertNonNegativeInteger = (value: number, code: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreError(code);
  }
};

type JobRow = {
  job_id: string;
  attempt: number;
  session_id: string;
  status: string;
};

type InboundRow = {
  message_id: string;
  sequence: number;
  body: string;
};

type EventRow = {
  message_id: string;
  sequence: number;
  payload_json: string;
  attempts: number;
  acknowledged_at: string | null;
};

type SchemaObjectRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

const schemaObjects = (database: Database.Database): SchemaObjectRow[] => {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE substr(lower(name), 1, 7) <> 'sqlite_'
       ORDER BY type, name, tbl_name`,
    )
    .all() as SchemaObjectRow[];
  return rows.map((row) => ({
    ...row,
    sql: row.sql?.replace(/\s+/gu, " ").trim() ?? null,
  }));
};

const expectedSchemaObjects = (): SchemaObjectRow[] => {
  const database = new Database(":memory:");
  try {
    database.exec(SCHEMA_SQL);
    return schemaObjects(database);
  } finally {
    database.close();
  }
};

const EXPECTED_SCHEMA_OBJECTS = expectedSchemaObjects();

const schemaMatches = (database: Database.Database): boolean =>
  JSON.stringify(schemaObjects(database)) ===
  JSON.stringify(EXPECTED_SCHEMA_OBJECTS);

export class SqlitePluginStore implements OwnedIntentPluginStore {
  #database: Database.Database | null = null;
  #closed = false;

  constructor(databasePath: string) {
    assertNonEmpty(databasePath, "STORE_DATABASE_PATH_REQUIRED");
    try {
      this.#database = new Database(databasePath);
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma("synchronous = FULL");
      this.#database.pragma("foreign_keys = ON");

      const migrate = this.#database.transaction(() => {
        const version = Number(
          this.database.pragma("user_version", { simple: true }),
        );
        if (
          !Number.isSafeInteger(version) ||
          (version !== 0 && version !== SCHEMA_VERSION)
        ) {
          throw new StoreError("STORE_SCHEMA_VERSION_UNSUPPORTED");
        }
        if (version === 0) {
          this.database.exec(SCHEMA_SQL);
        }
        if (!schemaMatches(this.database)) {
          throw new StoreError("STORE_SCHEMA_INCOMPATIBLE");
        }
        if (version === 0) {
          this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
        }
      });
      migrate();
    } catch (error) {
      try {
        this.#database?.close();
      } catch {
        // Preserve the safe store error below.
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("STORE_INITIALIZATION_FAILED");
    }
  }

  // All journal reads and writes observe one database snapshot, and return only
  // after an outermost commit. No callback is exposed to consumers.
  private ownedTransaction<T>(operation: () => T): T {
    try {
      this.assertOpen();
      if (this.database.inTransaction)
        throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      return this.database.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof OwnedIntentError) throw error;
      throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
    }
  }

  private readOwnedIntents(): OwnedIntent[] {
    // TEXT affinity still permits BLOBs. Check storage classes before any
    // namespace predicate can hide a malformed key or coerce a value.
    if (
      this.database
        .prepare(
          "SELECT 1 FROM metadata WHERE typeof(key) <> 'text' OR typeof(value) <> 'text' LIMIT 1",
        )
        .get() !== undefined
    )
      throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
    const rows = this.database
      .prepare(
        "SELECT key, value FROM metadata WHERE key GLOB 'owned-intent-*' OR key GLOB 'owned-active-*' OR key GLOB 'owned-generation-*' ORDER BY key",
      )
      .all() as { key: string; value: string }[];
    if (
      !z
        .array(z.object({ key: z.string(), value: z.string() }).strict())
        .safeParse(rows).success
    )
      throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
    const metadata = new Map(rows.map((row) => [row.key, row.value]));
    const records: OwnedIntent[] = [];
    const consumed = new Set<string>();
    const mappings = this.database
      .prepare("SELECT job_id, attempt, session_id, status FROM job_mappings")
      .all() as JobRow[];
    if (
      !z
        .array(
          z
            .object({
              job_id: z.string().min(1),
              attempt: z.number().int().positive().safe(),
              session_id: z.string().min(1),
              status: z.string().min(1),
            })
            .strict(),
        )
        .safeParse(mappings).success
    )
      throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
    for (const row of rows) {
      if (!row.key.startsWith("owned-intent-v1:")) continue;
      const value = parseOwnedRecord(OwnedIntentSchema, row.value);
      const owner = value.owner;
      if (row.key !== ownedKey(owner))
        throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
      for (const index of [activeOwnedKey(owner), generationOwnedKey(owner)]) {
        const body = metadata.get(index);
        if (
          body === undefined ||
          consumed.has(index) ||
          ownedJson(parseOwnedRecord(OwnedIntentOwnerSchema, body)) !==
            ownedJson(owner)
        )
          throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
        consumed.add(index);
      }
      const matching = mappings.filter(
        (mapping) =>
          mapping.job_id.toLowerCase() === owner.jobId ||
          mapping.session_id.toLowerCase() === owner.sessionId,
      );
      const mapping = matching[0];
      if (
        matching.length !== 1 ||
        mapping === undefined ||
        mapping.job_id !== owner.jobId ||
        mapping.attempt !== owner.attempt ||
        mapping.session_id !== owner.sessionId ||
        mapping.status !== value.phase
      )
        throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
      consumed.add(row.key);
      records.push(freezeOwned(value));
    }
    if (
      consumed.size !== rows.length ||
      mappings.some(
        (mapping) =>
          ["prepared", "creating", "submitting", "started"].includes(
            mapping.status,
          ) &&
          !records.some(
            (record) =>
              record.owner.jobId === mapping.job_id &&
              record.owner.attempt === mapping.attempt,
          ),
      )
    )
      throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
    return records.sort((a, b) =>
      a.owner.jobId < b.owner.jobId
        ? -1
        : a.owner.jobId > b.owner.jobId
          ? 1
          : a.owner.attempt - b.owner.attempt,
    );
  }

  prepareOwnedIntent(input: PrepareOwnedIntentInput): OwnedIntent {
    const captured = captureOwned(PrepareOwnedIntentSchema, input);
    // The refinement above rejects other envelope types before any SQL work.
    if (captured.offer.type !== "job.offer")
      throw new OwnedIntentError("OWNED_INTENT_INVALID");
    captureOwned(OwnedAttemptSchema, captured.offer.payload.attempt);
    const candidate = initialOwnedIntent({
      ...captured,
      offer: captured.offer,
    });
    return this.ownedTransaction(() => {
      const records = this.readOwnedIntents();
      const existing = records.find(
        (record) => ownedKey(record.owner) === ownedKey(candidate.owner),
      );
      if (existing !== undefined) {
        const original = {
          ...existing,
          phase: "prepared",
          version: 0,
          mode: null,
          startedEvidence: null,
          unavailable: null,
        };
        if (ownedJson(original) !== ownedJson(candidate))
          throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
        return existing;
      }
      const inbound = this.database
        .prepare(
          "SELECT body FROM inbound_messages WHERE message_id = ? AND sequence = ?",
        )
        .get(captured.offer.message_id, captured.offer.sequence) as
        | { body: string }
        | undefined;
      if (inbound === undefined)
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      let stored: ReturnType<typeof ConnectorServerMessageSchema.parse>;
      try {
        stored = ConnectorServerMessageSchema.parse(JSON.parse(inbound.body));
      } catch {
        throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
      }
      if (
        stored.type !== "job.offer" ||
        ownedJson(stored) !== ownedJson(captured.offer)
      )
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      const value = initialOwnedIntent({ ...captured, offer: stored });
      const owner = value.owner;
      if (
        records.some(
          (record) =>
            record.owner.jobId === owner.jobId ||
            record.owner.ownerGeneration === owner.ownerGeneration,
        ) ||
        this.database
          .prepare(
            "SELECT 1 FROM job_mappings WHERE lower(job_id) = ? OR lower(session_id) = ?",
          )
          .get(owner.jobId, owner.sessionId) !== undefined
      )
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      const serialized = ownedJson(value);
      if (Buffer.byteLength(serialized, "utf8") > 16384)
        throw new OwnedIntentError("OWNED_INTENT_INVALID");
      const mapping = this.database
        .prepare(
          "INSERT INTO job_mappings (job_id, attempt, session_id, status, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(owner.jobId, owner.attempt, owner.sessionId, value.phase, now());
      if (mapping.changes !== 1)
        throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      const insert = this.database.prepare(
        "INSERT INTO metadata (key, value) VALUES (?, ?)",
      );
      for (const [key, body] of [
        [ownedKey(owner), serialized],
        [activeOwnedKey(owner), ownedJson(owner)],
        [generationOwnedKey(owner), ownedJson(owner)],
      ] as const) {
        if (insert.run(key, body).changes !== 1)
          throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      }
      return freezeOwned(value);
    });
  }

  ownedIntent(jobId: string, attempt: number): OwnedIntent | undefined {
    const captured = captureOwned(
      z
        .object({
          jobId: OwnedIntentOwnerSchema.shape.jobId,
          attempt: OwnedAttemptSchema,
        })
        .strict(),
      { jobId, attempt },
    );
    return this.ownedTransaction(() =>
      this.readOwnedIntents().find(
        (record) =>
          record.owner.jobId === captured.jobId &&
          record.owner.attempt === captured.attempt,
      ),
    );
  }

  listOwnedIntents(): readonly OwnedIntent[] {
    return this.ownedTransaction(() => Object.freeze(this.readOwnedIntents()));
  }

  advanceOwnedIntent(
    owner: OwnedIntentOwner,
    expectedVersion: number,
    transition: OwnedIntentTransition,
  ): OwnedIntent {
    const capturedOwner = captureOwned(OwnedIntentOwnerSchema, owner);
    const version = captureOwned(OwnedVersionSchema, expectedVersion);
    const next = captureOwned(OwnedTransitionSchema, transition);
    return this.ownedTransaction(() => {
      const current = this.readOwnedIntents().find(
        (record) => ownedKey(record.owner) === ownedKey(capturedOwner),
      );
      if (
        current === undefined ||
        ownedJson(current.owner) !== ownedJson(capturedOwner) ||
        current.version !== version
      )
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      let updated: OwnedIntent;
      if ("unavailable" in next) {
        if (current.unavailable !== null) {
          if (current.unavailable === next.unavailable) return current;
          throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
        }
        updated = { ...current, unavailable: next.unavailable };
      } else {
        if (current.unavailable !== null)
          throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
        if (next.phase === "creating" && current.phase === "prepared")
          updated = { ...current, phase: next.phase, mode: next.mode };
        else if (next.phase === "submitting" && current.phase === "creating")
          updated = { ...current, phase: next.phase };
        else if (
          next.phase === "started" &&
          current.phase === "submitting" &&
          next.evidence.sessionId === current.owner.sessionId &&
          next.evidence.messageId === current.initialMessageId &&
          next.evidence.requestDigest === current.requestDigest
        ) {
          // Identity validation only: the native adapter must independently
          // verify own-session history and complete the actual persistence flush.
          updated = {
            ...current,
            phase: next.phase,
            startedEvidence: next.evidence,
          };
        } else throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      }
      if (version === Number.MAX_SAFE_INTEGER)
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      updated = { ...updated, version: version + 1 };
      const serialized = ownedJson(updated);
      if (Buffer.byteLength(serialized, "utf8") > 16384)
        throw new OwnedIntentError("OWNED_INTENT_INVALID");
      const row = this.database
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get(ownedKey(capturedOwner)) as { value: string };
      const changed = this.database
        .prepare("UPDATE metadata SET value = ? WHERE key = ? AND value = ?")
        .run(serialized, ownedKey(capturedOwner), row.value);
      if (changed.changes !== 1)
        throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      const mapped = this.database
        .prepare(
          "UPDATE job_mappings SET status = ?, updated_at = ? WHERE job_id = ? AND attempt = ? AND session_id = ? AND status = ?",
        )
        .run(
          updated.phase,
          now(),
          capturedOwner.jobId,
          capturedOwner.attempt,
          capturedOwner.sessionId,
          current.phase,
        );
      if (mapped.changes !== 1)
        throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      return freezeOwned(updated);
    });
  }

  recordInbound(
    messageId: string,
    sequence: number,
    body: string,
    evidence?: Readonly<{ coordinationRequestSequence: number }>,
  ): "new" | "duplicate" {
    this.assertOpen();
    assertNonEmpty(messageId, "STORE_MESSAGE_ID_REQUIRED");
    assertPositiveInteger(sequence, "STORE_SEQUENCE_INVALID");
    assertNonEmpty(body, "STORE_MESSAGE_BODY_REQUIRED");

    const write = this.database.transaction((): "new" | "duplicate" => {
      if (evidence !== undefined) {
        z.object({
          coordinationRequestSequence: z.number().int().positive().safe(),
        })
          .strict()
          .parse(evidence);
      }
      const receipt = this.prepareCoordinationReceipt(
        messageId,
        sequence,
        body,
        evidence?.coordinationRequestSequence,
        false,
      );
      const byMessage = this.database
        .prepare(
          `SELECT message_id, sequence, body
           FROM inbound_messages WHERE message_id = ?`,
        )
        .get(messageId) as InboundRow | undefined;
      if (byMessage !== undefined) {
        if (byMessage.sequence === sequence && byMessage.body === body) {
          return "duplicate";
        }
        throw new StoreInboundConflictError();
      }

      const bySequence = this.database
        .prepare(
          `SELECT message_id, sequence, body
           FROM inbound_messages WHERE sequence = ?`,
        )
        .get(sequence) as InboundRow | undefined;
      if (bySequence !== undefined) throw new StoreInboundConflictError();

      this.database
        .prepare(
          `INSERT INTO inbound_messages
            (message_id, sequence, body, received_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(messageId, sequence, body, now());
      this.insertCoordinationReceipt(receipt);
      return "new";
    });

    try {
      return write.immediate();
    } catch (error) {
      if (error instanceof StoreInboundConflictError) throw error;
      throw new StoreError("STORE_INBOUND_WRITE_FAILED");
    }
  }

  maxInboundSequence(): number {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT MAX(sequence) AS sequence FROM inbound_messages")
      .get() as { sequence: number | null };
    return row.sequence ?? 0;
  }

  inboundMessage(messageId: string): StoredInboundMessage | undefined {
    this.assertOpen();
    assertNonEmpty(messageId, "STORE_MESSAGE_ID_REQUIRED");
    const row = this.database
      .prepare(
        `SELECT message_id, sequence, body
         FROM inbound_messages WHERE message_id = ?`,
      )
      .get(messageId) as InboundRow | undefined;
    if (row === undefined) return undefined;
    const delivery = this.database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(`${INBOUND_DELIVERED_METADATA_PREFIX}${messageId}`) as
      | { value: string }
      | undefined;
    return {
      messageId: row.message_id,
      sequence: row.sequence,
      body: row.body,
      delivered: delivery?.value === String(row.sequence),
    };
  }

  inboundMessageBySequence(sequence: number): StoredInboundMessage | undefined {
    this.assertOpen();
    assertPositiveInteger(sequence, "STORE_SEQUENCE_INVALID");
    const row = this.database
      .prepare("SELECT message_id FROM inbound_messages WHERE sequence = ?")
      .get(sequence) as { message_id: string } | undefined;
    return row === undefined ? undefined : this.inboundMessage(row.message_id);
  }

  replaceInbound(replacement: InboundReplacement): void {
    this.assertOpen();
    assertNonEmpty(replacement.previousMessageId, "STORE_MESSAGE_ID_REQUIRED");
    assertNonEmpty(replacement.previousBody, "STORE_MESSAGE_BODY_REQUIRED");
    assertNonEmpty(replacement.messageId, "STORE_MESSAGE_ID_REQUIRED");
    assertPositiveInteger(replacement.sequence, "STORE_SEQUENCE_INVALID");
    assertNonEmpty(replacement.body, "STORE_MESSAGE_BODY_REQUIRED");

    const write = this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT message_id, sequence, body
           FROM inbound_messages WHERE sequence = ?`,
        )
        .get(replacement.sequence) as InboundRow | undefined;
      const byReplacementId = this.database
        .prepare("SELECT sequence FROM inbound_messages WHERE message_id = ?")
        .get(replacement.messageId) as { sequence: number } | undefined;
      if (
        current?.message_id !== replacement.previousMessageId ||
        current.body !== replacement.previousBody ||
        byReplacementId !== undefined
      ) {
        throw new StoreInboundConflictError();
      }
      const receipt = this.prepareCoordinationReceipt(
        replacement.messageId,
        replacement.sequence,
        replacement.body,
        replacement.coordinationRequestSequence,
        true,
      );
      // Completion belongs to the proven state sequence, not its renewable
      // outer identity. Read it before mutation and transfer it atomically.
      const original =
        receipt ?? this.coordinationReceipt(replacement.sequence);
      const preserveCompletion =
        original?.responseType === "job.state" &&
        this.inboundMessage(current.message_id)?.delivered === true;
      const updated = this.database
        .prepare(
          `UPDATE inbound_messages
           SET message_id = ?, body = ?, received_at = ?
           WHERE sequence = ? AND message_id = ? AND body = ?`,
        )
        .run(
          replacement.messageId,
          replacement.body,
          now(),
          replacement.sequence,
          replacement.previousMessageId,
          replacement.previousBody,
        );
      if (updated.changes !== 1) throw new StoreInboundConflictError();
      this.database
        .prepare("DELETE FROM metadata WHERE key IN (?, ?)")
        .run(
          `${INBOUND_DELIVERED_METADATA_PREFIX}${replacement.previousMessageId}`,
          `${INBOUND_DELIVERED_METADATA_PREFIX}${replacement.messageId}`,
        );
      this.insertCoordinationReceipt(receipt);
      if (preserveCompletion) {
        this.database
          .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
          .run(
            `${INBOUND_DELIVERED_METADATA_PREFIX}${replacement.messageId}`,
            String(replacement.sequence),
          );
      }
    });
    try {
      write.immediate();
    } catch (error) {
      if (error instanceof StoreInboundConflictError) throw error;
      throw new StoreError("STORE_INBOUND_WRITE_FAILED");
    }
  }

  private createCoordinationReceipt(
    requestSequence: number,
    response: ReturnType<typeof parseResponse>,
  ): StoredCoordinationReceipt {
    assertPositiveInteger(requestSequence, "STORE_COORDINATION_INVALID");
    const stored = this.outboundEvent(requestSequence);
    if (stored?.expectedReceiptProfile !== COORDINATION_PROFILE)
      throw new Error();
    const request = parseRequest(stored);
    if (request.correlation_id !== response.correlation_id) throw new Error();
    if (response.type === "job.state") {
      if (
        request.type !== "job.sync" ||
        response.payload.job_id !== request.payload.job_id ||
        response.payload.requested_attempt !== request.payload.attempt ||
        response.payload.request_message_id !== request.message_id ||
        response.payload.request_sequence !== request.sequence ||
        response.payload.nonce !== request.payload.nonce
      )
        throw new Error();
    } else if (response.type === "protocol.error") {
      const { code, message } = response.payload;
      const conflict =
        message === "The job authority has changed." ||
        message === "The job business limit has been reached.";
      const valid =
        request.type === "job.sync"
          ? code === "JOB_AUTHORITY_UNAVAILABLE" &&
            message === "The job authority is unavailable."
          : request.type === "job.claim"
            ? code === "CLAIM_REJECTED" && conflict
            : ["job.event", "approval.requested", "job.cancelled"].includes(
                request.type,
              ) &&
              code === "EVENT_REJECTED" &&
              conflict;
      if (!valid) throw new Error();
    } else throw new Error();
    return CoordinationReceiptSchema.parse({
      expectedReceiptProfile: COORDINATION_PROFILE,
      requestSequence: request.sequence,
      requestMessageId: request.message_id,
      requestCorrelationId: request.correlation_id,
      requestType: request.type,
      responseSequence: response.sequence,
      responseCorrelationId: response.correlation_id,
      responseType: response.type,
      responsePayloadJson: canonicalPayload(response.payload),
    });
  }

  coordinationReceipt(sequence: number): StoredCoordinationReceipt | undefined {
    this.assertOpen();
    assertPositiveInteger(sequence, "STORE_SEQUENCE_INVALID");
    try {
      const metadata = this.database
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get(`${INBOUND_RECEIPT_PREFIX}${sequence}`) as
        | { value: string }
        | undefined;
      if (metadata === undefined) return undefined;
      const receipt = CoordinationReceiptSchema.parse(
        JSON.parse(metadata.value),
      );
      const inbound = this.inboundMessageBySequence(sequence);
      if (inbound === undefined || receipt.responseSequence !== sequence)
        throw new Error();
      const current = parseResponse(inbound.messageId, sequence, inbound.body);
      // Revalidate the retained original even when the current row is a tombstone.
      const original = ConnectorServerMessageSchema.parse({
        ...current,
        type: receipt.responseType,
        payload: JSON.parse(receipt.responsePayloadJson),
      });
      const validated = this.createCoordinationReceipt(
        receipt.requestSequence,
        original,
      );
      if (JSON.stringify(validated) !== JSON.stringify(receipt))
        throw new Error();
      if (
        !isExpiryPlaceholder(current) &&
        (current.type !== receipt.responseType ||
          canonicalPayload(current.payload) !== receipt.responsePayloadJson)
      )
        throw new Error();
      return Object.freeze(receipt);
    } catch {
      throw new StoreError("STORE_COORDINATION_INVALID");
    }
  }

  private prepareCoordinationReceipt(
    messageId: string,
    sequence: number,
    body: string,
    requestSequence: number | undefined,
    replacing: boolean,
  ): StoredCoordinationReceipt | undefined {
    const original = this.coordinationReceipt(sequence);
    if (original === undefined && requestSequence === undefined)
      return undefined;
    const response = parseResponse(messageId, sequence, body);
    if (requestSequence === undefined) {
      if (
        !isExpiryPlaceholder(response) ||
        response.correlation_id !== original?.responseCorrelationId
      )
        throw new Error();
      return undefined;
    }
    const candidate = this.createCoordinationReceipt(requestSequence, response);
    if (original !== undefined) {
      if (JSON.stringify(candidate) !== JSON.stringify(original))
        throw new Error();
      return undefined;
    }
    const current = this.inboundMessageBySequence(sequence);
    if (current !== undefined) {
      const previous = parseResponse(current.messageId, sequence, current.body);
      if (
        !replacing ||
        !isExpiryPlaceholder(previous) ||
        previous.correlation_id !== response.correlation_id
      )
        throw new Error();
    }
    return candidate;
  }

  private insertCoordinationReceipt(
    receipt: StoredCoordinationReceipt | undefined,
  ): void {
    if (receipt === undefined) return;
    this.database
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run(
        `${INBOUND_RECEIPT_PREFIX}${receipt.responseSequence}`,
        JSON.stringify(receipt),
      );
  }

  pendingInboundMessages(): StoredInboundMessage[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT inbound.message_id, inbound.sequence, inbound.body
         FROM inbound_messages AS inbound
         WHERE NOT EXISTS (
           SELECT 1 FROM metadata
           WHERE key = ? || inbound.message_id
             AND value = CAST(inbound.sequence AS TEXT)
         )
         ORDER BY inbound.sequence ASC`,
      )
      .all(INBOUND_DELIVERED_METADATA_PREFIX) as InboundRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      sequence: row.sequence,
      body: row.body,
      delivered: false,
    }));
  }

  markInboundDelivered(messageId: string): void {
    this.assertOpen();
    assertNonEmpty(messageId, "STORE_MESSAGE_ID_REQUIRED");
    const write = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT sequence FROM inbound_messages WHERE message_id = ?")
        .get(messageId) as { sequence: number } | undefined;
      if (row === undefined) throw new StoreError("STORE_INBOUND_MISSING");
      this.database
        .prepare(
          `INSERT INTO metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(
          `${INBOUND_DELIVERED_METADATA_PREFIX}${messageId}`,
          String(row.sequence),
        );
    });
    write.immediate();
  }

  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void {
    this.assertOpen();
    let captured: LocalJobMapping;
    try {
      captured = {
        jobId: input.jobId,
        attempt: input.attempt,
        sessionId: input.sessionId,
        status: input.status,
      };
    } catch {
      throw new StoreError("STORE_MAPPING_INPUT_INVALID");
    }
    assertNonEmpty(captured.jobId, "STORE_JOB_ID_REQUIRED");
    assertPositiveInteger(captured.attempt, "STORE_ATTEMPT_INVALID");
    assertNonEmpty(captured.sessionId, "STORE_SESSION_ID_REQUIRED");
    assertNonEmpty(captured.status, "STORE_STATUS_REQUIRED");

    const write = this.database.transaction(() => {
      // Legacy mappings cannot mutate or replace journal ownership. Validate
      // every journal fact first so corrupt indexes cannot bypass this guard.
      let owned: OwnedIntent[];
      try {
        owned = this.readOwnedIntents();
      } catch (error) {
        if (error instanceof OwnedIntentError) throw error;
        throw new OwnedIntentError("OWNED_INTENT_UNAVAILABLE");
      }
      if (
        owned.some(
          (record) =>
            record.owner.jobId === captured.jobId.toLowerCase() ||
            record.owner.sessionId === captured.sessionId.toLowerCase(),
        )
      )
        throw new OwnedIntentError("OWNED_INTENT_CONFLICT");
      const byJob = this.database
        .prepare(
          `SELECT job_id, attempt, session_id, status
           FROM job_mappings WHERE job_id = ? AND attempt = ?`,
        )
        .get(captured.jobId, captured.attempt) as JobRow | undefined;
      const bySession = this.database
        .prepare(
          `SELECT job_id, attempt, session_id, status
           FROM job_mappings WHERE session_id = ?`,
        )
        .get(captured.sessionId) as JobRow | undefined;

      if (
        (byJob !== undefined && byJob.session_id !== captured.sessionId) ||
        (bySession !== undefined &&
          (bySession.job_id !== captured.jobId ||
            bySession.attempt !== captured.attempt))
      ) {
        throw new StoreError("STORE_MAPPING_CONFLICT");
      }

      if (byJob !== undefined) {
        this.database
          .prepare(
            `UPDATE job_mappings SET status = ?, updated_at = ?
             WHERE job_id = ? AND attempt = ?`,
          )
          .run(captured.status, now(), captured.jobId, captured.attempt);
        return;
      }

      this.database
        .prepare(
          `INSERT INTO job_mappings
            (job_id, attempt, session_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          captured.jobId,
          captured.attempt,
          captured.sessionId,
          captured.status,
          now(),
        );
    });
    write();
  }

  findJob(jobId: string): LocalJobMapping | undefined {
    this.assertOpen();
    assertNonEmpty(jobId, "STORE_JOB_ID_REQUIRED");
    const row = this.database
      .prepare(
        `SELECT job_id, attempt, session_id, status
         FROM job_mappings WHERE job_id = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(jobId) as JobRow | undefined;
    if (row === undefined) return undefined;
    return {
      jobId: row.job_id,
      attempt: row.attempt,
      sessionId: row.session_id,
      status: row.status,
    };
  }

  listNonterminalJobs(): readonly LocalJobMapping[] {
    this.assertOpen();
    try {
      const rows = this.database
        .prepare(
          `SELECT job_id, attempt, session_id, status
           FROM job_mappings
           WHERE status NOT IN (?, ?, ?, ?)
           ORDER BY job_id ASC, attempt ASC`,
        )
        .all("succeeded", "failed", "cancelled", "expired") as JobRow[];
      return rows.map((row) => ({
        jobId: row.job_id,
        attempt: row.attempt,
        sessionId: row.session_id,
        status: row.status,
      }));
    } catch {
      throw new StoreError("STORE_JOB_MAPPING_READ_FAILED");
    }
  }

  maxOutboundSequence(): number {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT MAX(sequence) AS sequence FROM outbound_events")
      .get() as { sequence: number | null };
    const sequence = row.sequence ?? 0;
    assertNonNegativeInteger(sequence, "STORE_SEQUENCE_INVALID");
    return sequence;
  }

  enqueueEvent(event: OutboundEventInput, pinHello = false): void {
    this.assertOpen();
    assertNonEmpty(event.messageId, "STORE_MESSAGE_ID_REQUIRED");
    assertPositiveInteger(event.sequence, "STORE_SEQUENCE_INVALID");
    if (typeof event.payload !== "string") {
      throw new StoreError("STORE_PAYLOAD_INVALID");
    }
    try {
      JSON.parse(event.payload);
    } catch {
      throw new StoreError("STORE_PAYLOAD_INVALID");
    }
    if (event.expectedReceiptProfile !== undefined) {
      try {
        if (event.expectedReceiptProfile !== COORDINATION_PROFILE)
          throw new Error();
        parseRequest(event);
      } catch {
        throw new StoreError("STORE_COORDINATION_INVALID");
      }
    }
    const write = this.database.transaction(() => {
      const byMessage = this.database
        .prepare(
          `SELECT message_id, sequence, payload_json, attempts, acknowledged_at
           FROM outbound_events WHERE message_id = ?`,
        )
        .get(event.messageId) as EventRow | undefined;
      if (byMessage !== undefined) {
        if (
          byMessage.sequence === event.sequence &&
          byMessage.payload_json === event.payload &&
          this.storedEvent(byMessage).expectedReceiptProfile ===
            event.expectedReceiptProfile
        ) {
          return;
        }
        throw new StoreSequenceError();
      }

      const latest = this.database
        .prepare("SELECT MAX(sequence) AS sequence FROM outbound_events")
        .get() as { sequence: number | null };
      if (latest.sequence !== null && event.sequence <= latest.sequence) {
        throw new StoreSequenceError();
      }

      this.database
        .prepare(
          `INSERT INTO outbound_events
            (message_id, sequence, payload_json, attempts, acknowledged_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(event.messageId, event.sequence, event.payload, 0, null, now());
      if (pinHello) {
        const previous = this.activeHello();
        if (
          JSON.parse(event.payload).type !== "connector.hello" ||
          (previous !== undefined &&
            this.provenClientSequence() !== event.sequence - 1)
        ) {
          throw new StoreError("STORE_HELLO_NOT_PROVEN");
        }
        this.database
          .prepare(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('transport-hello', ?)",
          )
          .run(String(event.sequence));
      }
      if (event.expectedReceiptProfile !== undefined) {
        this.database
          .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
          .run(
            `${OUTBOUND_PROFILE_PREFIX}${event.sequence}`,
            event.expectedReceiptProfile,
          );
      }
    });
    try {
      write();
    } catch (error) {
      if (error instanceof StoreError || error instanceof StoreSequenceError)
        throw error;
      throw new StoreError("STORE_OUTBOUND_WRITE_FAILED");
    }
  }

  outboundEvent(sequence: number): StoredOutboundEvent | undefined {
    assertPositiveInteger(sequence, "STORE_SEQUENCE_INVALID");
    const row = this.database
      .prepare(
        "SELECT message_id, sequence, payload_json, attempts, acknowledged_at FROM outbound_events WHERE sequence = ?",
      )
      .get(sequence) as EventRow | undefined;
    return row === undefined ? undefined : this.storedEvent(row);
  }

  private storedEvent(row: EventRow): StoredOutboundEvent {
    const metadata = this.database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(`${OUTBOUND_PROFILE_PREFIX}${row.sequence}`) as
      | { value: string }
      | undefined;
    const stored: StoredOutboundEvent = {
      messageId: row.message_id,
      sequence: row.sequence,
      payload: row.payload_json,
      attempts: row.attempts,
      acknowledgedAt: row.acknowledged_at,
      ...(metadata === undefined
        ? {}
        : { expectedReceiptProfile: COORDINATION_PROFILE }),
    };
    if (metadata !== undefined) {
      try {
        if (metadata.value !== COORDINATION_PROFILE) throw new Error();
        parseRequest(stored);
      } catch {
        throw new StoreError("STORE_COORDINATION_INVALID");
      }
    }
    return stored;
  }

  coordinationRequest(correlationId: string): StoredOutboundEvent | undefined {
    this.assertOpen();
    assertNonEmpty(correlationId, "STORE_COORDINATION_INVALID");
    try {
      const rows = this.database
        .prepare(
          `SELECT message_id, sequence, payload_json, attempts, acknowledged_at
         FROM outbound_events WHERE json_extract(payload_json, '$.correlation_id') = ? LIMIT 2`,
        )
        .all(correlationId) as EventRow[];
      if (rows.length > 1) throw new Error();
      const row = rows[0];
      if (row === undefined) return undefined;
      const stored = this.storedEvent(row);
      parseRequest(stored);
      return stored.expectedReceiptProfile === undefined ? undefined : stored;
    } catch {
      throw new StoreError("STORE_COORDINATION_INVALID");
    }
  }

  activeHello(): StoredOutboundEvent | undefined {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'transport-hello'")
      .get() as { value: string } | undefined;
    if (row === undefined) return undefined;
    const hello = this.outboundEvent(Number(row.value));
    if (
      hello === undefined ||
      JSON.parse(hello.payload).type !== "connector.hello"
    )
      throw new StoreError("STORE_HELLO_INVALID");
    return hello;
  }

  provenClientSequence(): number {
    const row = this.database
      .prepare(
        "SELECT value FROM metadata WHERE key = 'transport-proven-prefix'",
      )
      .get() as { value: string } | undefined;
    const value = row === undefined ? 0 : Number(row.value);
    assertNonNegativeInteger(value, "STORE_SEQUENCE_INVALID");
    if (value > this.maxOutboundSequence())
      throw new StoreError("STORE_RECEIPT_INVALID");
    return value;
  }

  acknowledgeThrough(sequence: number, correlationId: string): void {
    this.database.transaction(() => {
      const stored = this.outboundEvent(sequence);
      if (stored === undefined) throw new StoreError("STORE_RECEIPT_INVALID");
      const message = JSON.parse(stored.payload);
      if (
        message.sequence !== sequence ||
        message.correlation_id !== correlationId
      )
        throw new StoreError("STORE_RECEIPT_INVALID");
      const prefix = Math.max(sequence, this.provenClientSequence());
      this.database
        .prepare(
          "INSERT OR REPLACE INTO metadata(key, value) VALUES ('transport-proven-prefix', ?)",
        )
        .run(String(prefix));
      this.database
        .prepare(
          "UPDATE outbound_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE sequence <= ?",
        )
        .run(now(), prefix);
    })();
  }

  renewDelivery(sequence: number, expiresAt: string): StoredOutboundEvent {
    return this.database.transaction(() => {
      const stored = this.outboundEvent(sequence);
      if (stored === undefined) throw new StoreError("STORE_DELIVERY_MISSING");
      const message = JSON.parse(stored.payload);
      if (
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.parse(message.sent_at)
      )
        throw new StoreError("STORE_DELIVERY_INVALID");
      const payload = JSON.stringify({ ...message, expires_at: expiresAt });
      if (stored.expectedReceiptProfile !== undefined) {
        try {
          parseRequest({ ...stored, payload });
        } catch {
          throw new StoreError("STORE_DELIVERY_INVALID");
        }
      }
      this.database
        .prepare(
          "UPDATE outbound_events SET payload_json = ? WHERE sequence = ?",
        )
        .run(payload, sequence);
      return { ...stored, payload };
    })();
  }

  markInboundExpired(messageId: string): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, 'expired')",
        )
        .run(`inbound-disposition:${messageId}`);
      this.markInboundDelivered(messageId);
    })();
  }

  pendingEvents(afterSequence: number): StoredOutboundEvent[] {
    this.assertOpen();
    assertNonNegativeInteger(afterSequence, "STORE_SEQUENCE_INVALID");

    const read = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT message_id, sequence, payload_json, attempts, acknowledged_at
           FROM outbound_events
           WHERE acknowledged_at IS NULL AND sequence > ?
           ORDER BY sequence ASC`,
        )
        .all(afterSequence) as EventRow[];
      if (rows.length === 0) return [];

      const update = this.database.prepare(
        `UPDATE outbound_events SET attempts = attempts + 1
         WHERE message_id = ? AND acknowledged_at IS NULL`,
      );
      for (const row of rows) update.run(row.message_id);

      return rows.map((row) =>
        this.storedEvent({ ...row, attempts: row.attempts + 1 }),
      );
    });
    return read();
  }

  acknowledgeEvent(messageId: string): void {
    this.assertOpen();
    assertNonEmpty(messageId, "STORE_MESSAGE_ID_REQUIRED");
    this.database
      .prepare(
        `UPDATE outbound_events SET acknowledged_at = COALESCE(acknowledged_at, ?)
         WHERE message_id = ?`,
      )
      .run(now(), messageId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
    this.#database = null;
  }

  private assertOpen(): void {
    if (this.#closed) throw new StoreError("STORE_CLOSED");
  }

  private get database(): Database.Database {
    if (this.#database === null) {
      throw new StoreError("STORE_CLOSED");
    }
    return this.#database;
  }
}
