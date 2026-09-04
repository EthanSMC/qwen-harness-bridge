import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

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
  messageId: string;
  sequence: number;
  payload: string;
}>;

export type StoredOutboundEvent = Readonly<{
  messageId: string;
  sequence: number;
  payload: string;
  attempts: number;
  acknowledgedAt: string | null;
}>;

export interface PluginStore {
  recordInbound(
    messageId: string,
    sequence: number,
    body: string,
  ): "new" | "duplicate";
  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void;
  findJob(jobId: string): LocalJobMapping | undefined;
  enqueueEvent(event: OutboundEventInput): void;
  pendingEvents(afterSequence: number): StoredOutboundEvent[];
  acknowledgeEvent(messageId: string): void;
  close(): void;
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

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexListRow = {
  name: string;
  unique: number;
};

type IndexInfoRow = {
  seqno: number;
  name: string;
};

type TableDefinitionRow = {
  sql: string | null;
};

const REQUIRED_SCHEMA = {
  inbound_messages: {
    columns: [
      ["message_id", "TEXT", 1, null, 1],
      ["sequence", "INTEGER", 1, null, 0],
      ["body", "TEXT", 1, null, 0],
      ["received_at", "TEXT", 1, null, 0],
    ],
    uniqueColumns: [["sequence"]],
    requiredChecks: ["CHECK(SEQUENCE>=1)"],
  },
  job_mappings: {
    columns: [
      ["job_id", "TEXT", 1, null, 1],
      ["attempt", "INTEGER", 1, null, 2],
      ["session_id", "TEXT", 1, null, 0],
      ["status", "TEXT", 1, null, 0],
      ["updated_at", "TEXT", 1, null, 0],
    ],
    uniqueColumns: [["session_id"]],
    requiredChecks: ["CHECK(ATTEMPT>=1)"],
  },
  outbound_events: {
    columns: [
      ["message_id", "TEXT", 1, null, 1],
      ["sequence", "INTEGER", 1, null, 0],
      ["payload_json", "TEXT", 1, null, 0],
      ["attempts", "INTEGER", 1, "0", 0],
      ["acknowledged_at", "TEXT", 0, null, 0],
      ["created_at", "TEXT", 1, null, 0],
    ],
    uniqueColumns: [["sequence"]],
    requiredChecks: ["CHECK(SEQUENCE>=1)", "CHECK(ATTEMPTS>=0)"],
  },
  metadata: {
    columns: [
      ["key", "TEXT", 1, null, 1],
      ["value", "TEXT", 1, null, 0],
    ],
    uniqueColumns: [],
    requiredChecks: [],
  },
} as const;

const schemaMatches = (database: Database.Database): boolean => {
  for (const [tableName, expected] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = database.pragma(
      `table_info(${tableName})`,
    ) as TableInfoRow[];
    const actualColumns = columns.map((column) => [
      column.name,
      column.type.toUpperCase(),
      column.notnull,
      column.dflt_value,
      column.pk,
    ]);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expected.columns)) {
      return false;
    }

    const definition = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tableName) as TableDefinitionRow | undefined;
    const normalizedDefinition = definition?.sql
      ?.replace(/\s+/g, "")
      .toUpperCase();
    if (
      normalizedDefinition === undefined ||
      expected.requiredChecks.some(
        (requiredCheck) => !normalizedDefinition.includes(requiredCheck),
      )
    ) {
      return false;
    }

    const indexes = (
      database.pragma(`index_list(${tableName})`) as IndexListRow[]
    ).filter((index) => index.unique === 1);
    for (const requiredColumns of expected.uniqueColumns) {
      const hasRequiredIndex = indexes.some((index) => {
        const indexColumns = (
          database
            .prepare(
              "SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno",
            )
            .all(index.name) as IndexInfoRow[]
        ).map(({ name }) => name);
        return JSON.stringify(indexColumns) === JSON.stringify(requiredColumns);
      });
      if (!hasRequiredIndex) return false;
    }
  }
  return true;
};

export class SqlitePluginStore implements PluginStore {
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

  recordInbound(
    messageId: string,
    sequence: number,
    body: string,
  ): "new" | "duplicate" {
    this.assertOpen();
    assertNonEmpty(messageId, "STORE_MESSAGE_ID_REQUIRED");
    assertPositiveInteger(sequence, "STORE_SEQUENCE_INVALID");
    assertNonEmpty(body, "STORE_MESSAGE_BODY_REQUIRED");

    const write = this.database.transaction((): "new" | "duplicate" => {
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
      return "new";
    });

    try {
      return write.immediate();
    } catch (error) {
      if (error instanceof StoreInboundConflictError) throw error;
      throw new StoreError("STORE_INBOUND_WRITE_FAILED");
    }
  }

  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void {
    this.assertOpen();
    assertNonEmpty(input.jobId, "STORE_JOB_ID_REQUIRED");
    assertPositiveInteger(input.attempt, "STORE_ATTEMPT_INVALID");
    assertNonEmpty(input.sessionId, "STORE_SESSION_ID_REQUIRED");
    assertNonEmpty(input.status, "STORE_STATUS_REQUIRED");

    const write = this.database.transaction(() => {
      const byJob = this.database
        .prepare(
          `SELECT job_id, attempt, session_id, status
           FROM job_mappings WHERE job_id = ? AND attempt = ?`,
        )
        .get(input.jobId, input.attempt) as JobRow | undefined;
      const bySession = this.database
        .prepare(
          `SELECT job_id, attempt, session_id, status
           FROM job_mappings WHERE session_id = ?`,
        )
        .get(input.sessionId) as JobRow | undefined;

      if (
        (byJob !== undefined && byJob.session_id !== input.sessionId) ||
        (bySession !== undefined &&
          (bySession.job_id !== input.jobId ||
            bySession.attempt !== input.attempt))
      ) {
        throw new StoreError("STORE_MAPPING_CONFLICT");
      }

      if (byJob !== undefined) {
        this.database
          .prepare(
            `UPDATE job_mappings SET status = ?, updated_at = ?
             WHERE job_id = ? AND attempt = ?`,
          )
          .run(input.status, now(), input.jobId, input.attempt);
        return;
      }

      this.database
        .prepare(
          `INSERT INTO job_mappings
            (job_id, attempt, session_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.jobId, input.attempt, input.sessionId, input.status, now());
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

  enqueueEvent(event: OutboundEventInput): void {
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
          byMessage.payload_json === event.payload
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
    });
    write();
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

      return rows.map((row) => ({
        messageId: row.message_id,
        sequence: row.sequence,
        payload: row.payload_json,
        attempts: row.attempts + 1,
        acknowledgedAt: row.acknowledged_at,
      }));
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
