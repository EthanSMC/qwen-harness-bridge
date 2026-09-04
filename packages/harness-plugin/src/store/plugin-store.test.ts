import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type OutboundEventInput,
  SqlitePluginStore,
  StoreInboundConflictError,
  StoreSequenceError,
} from "./plugin-store.js";

const temporaryDirectories: string[] = [];

const makeDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-plugin-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
};

const event = (
  sequence: number,
  messageId = `event-${sequence}`,
): OutboundEventInput => ({
  messageId,
  sequence,
  payload: JSON.stringify({ sequence }),
});

const captureStoreError = (
  operation: () => void,
): Error & { code?: string } => {
  try {
    operation();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected store operation to fail");
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      recursive: true,
      force: true,
    });
  }
});

describe("SQLite Harness plugin store", () => {
  it("persists a proven prefix separately from its pinned reconnect hello", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const hello = {
      ...event(1),
      payload: JSON.stringify({
        sequence: 1,
        type: "connector.hello",
        correlation_id: "hello",
      }),
    };
    store.enqueueEvent(hello, true);
    store.enqueueEvent({
      ...event(2),
      payload: JSON.stringify({ sequence: 2, correlation_id: "event" }),
    });
    expect(() => store.acknowledgeThrough(2, "wrong")).toThrow();
    expect(store.provenClientSequence()).toBe(0);
    store.acknowledgeThrough(2, "event");
    expect(store.pendingEvents(0)).toEqual([]);
    expect(store.activeHello()?.messageId).toBe(hello.messageId);
    store.close();
    const reopened = new SqlitePluginStore(path);
    expect(reopened.provenClientSequence()).toBe(2);
    expect(reopened.activeHello()?.messageId).toBe(hello.messageId);
    reopened.enqueueEvent(
      {
        ...event(3),
        payload: JSON.stringify({
          sequence: 3,
          type: "connector.hello",
          correlation_id: "next",
        }),
      },
      true,
    );
    expect(reopened.activeHello()?.sequence).toBe(3);
    reopened.close();
  });
  it("creates an atomic WAL schema with the expected durable tables", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(tables).toEqual([
      "inbound_messages",
      "job_mappings",
      "metadata",
      "outbound_events",
    ]);
    database.close();
  });

  it.each([-1, 2, 99])(
    "rejects unsupported schema version %s without applying a partial migration",
    (version) => {
      const databasePath = makeDatabasePath();
      const database = new Database(databasePath);
      database.pragma(`user_version = ${version}`);
      database.close();

      expect(() => new SqlitePluginStore(databasePath)).toThrow(
        "STORE_SCHEMA_VERSION_UNSUPPORTED",
      );

      const reopened = new Database(databasePath, { readonly: true });
      expect(reopened.pragma("user_version", { simple: true })).toBe(version);
      expect(
        reopened
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'",
          )
          .get(),
      ).toBeUndefined();
      reopened.close();
    },
  );

  it("rolls back a malformed version-zero schema instead of blessing it", () => {
    const databasePath = makeDatabasePath();
    const database = new Database(databasePath);
    database.exec(
      "CREATE TABLE inbound_messages (message_id TEXT PRIMARY KEY NOT NULL)",
    );
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(0);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["inbound_messages"]);
    expect(reopened.pragma("table_info(inbound_messages)")).toHaveLength(1);
    reopened.close();
  });

  it("rejects a malformed version-one schema instead of trusting user_version", () => {
    const databasePath = makeDatabasePath();
    const database = new Database(databasePath);
    database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL)");
    database.pragma("user_version = 1");
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(1);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["metadata"]);
    reopened.close();
  });

  it("rejects a version-one schema missing a required check constraint", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(`
      ALTER TABLE inbound_messages RENAME TO inbound_messages_old;
      CREATE TABLE inbound_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      DROP TABLE inbound_messages_old;
    `);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it.each([
    ["table", "CREATE TABLE unexpected_table (value TEXT)"],
    ["index", "CREATE INDEX unexpected_index ON metadata(value)"],
    ["view", "CREATE VIEW unexpected_view AS SELECT key FROM metadata"],
    [
      "trigger",
      "CREATE TRIGGER unexpected_trigger AFTER INSERT ON metadata BEGIN SELECT 1; END",
    ],
  ])("rejects an unexpected user %s", (_kind, sql) => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(sql);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it("rejects a tautological check hidden behind the canonical text in a comment", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(`
      ALTER TABLE inbound_messages RENAME TO inbound_messages_old;
      CREATE TABLE inbound_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        sequence INTEGER NOT NULL UNIQUE CHECK (1 = 1) /*CHECK(sequence>=1)*/,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      DROP TABLE inbound_messages_old;
    `);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it("deduplicates inbound message IDs and persists the decision after reopen", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);

    expect(first.recordInbound("message-1", 1, "body")).toBe("new");
    expect(first.recordInbound("message-1", 1, "body")).toBe("duplicate");
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.recordInbound("message-1", 1, "body")).toBe("duplicate");
    reopened.close();
  });

  it("restores the maximum durable inbound sequence after reopen", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);

    expect(first.maxInboundSequence()).toBe(0);
    first.recordInbound("message-1", 1, "body-1");
    first.recordInbound("message-2", 2, "body-2");
    expect(first.maxInboundSequence()).toBe(2);
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.maxInboundSequence()).toBe(2);
    reopened.close();
  });

  it("persists completed inbound delivery while leaving unfinished receipts retryable", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);
    first.recordInbound("message-1", 1, "body-1");
    first.recordInbound("message-2", 2, "body-2");

    expect(first.inboundMessage("message-1")).toEqual({
      messageId: "message-1",
      sequence: 1,
      body: "body-1",
      delivered: false,
    });
    expect(
      first.pendingInboundMessages().map(({ messageId }) => messageId),
    ).toEqual(["message-1", "message-2"]);
    first.markInboundDelivered("message-1");
    first.markInboundDelivered("message-1");
    expect(first.inboundMessage("message-1")?.delivered).toBe(true);
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(
      reopened.pendingInboundMessages().map(({ messageId }) => messageId),
    ).toEqual(["message-2"]);
    expect(reopened.inboundMessage("message-1")?.delivered).toBe(true);
    reopened.close();
  });

  it("transactionally replaces one inbound identity at the same sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("old-message", 1, "old-body");
    store.markInboundDelivered("old-message");

    expect(store.inboundMessageBySequence(1)?.messageId).toBe("old-message");
    store.replaceInbound({
      previousMessageId: "old-message",
      previousBody: "old-body",
      messageId: "replacement-message",
      sequence: 1,
      body: "replacement-body",
    });

    expect(store.inboundMessage("old-message")).toBeUndefined();
    expect(store.inboundMessageBySequence(1)).toEqual({
      messageId: "replacement-message",
      sequence: 1,
      body: "replacement-body",
      delivered: false,
    });
    expect(store.pendingInboundMessages()).toEqual([
      {
        messageId: "replacement-message",
        sequence: 1,
        body: "replacement-body",
        delivered: false,
      },
    ]);
    const audit = new Database(databasePath, { readonly: true });
    expect(
      audit
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("inbound-delivered:old-message"),
    ).toBeUndefined();
    audit.close();
    expect(() =>
      store.replaceInbound({
        previousMessageId: "old-message",
        previousBody: "old-body",
        messageId: "attacker-message",
        sequence: 1,
        body: "attacker-body",
      }),
    ).toThrowError(StoreInboundConflictError);
    expect(store.inboundMessageBySequence(1)?.messageId).toBe(
      "replacement-message",
    );
    store.close();
  });

  it("rejects reused inbound IDs unless sequence and body match exactly", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("message-private", 1, "body-private");

    for (const [sequence, body] of [
      [2, "body-private"],
      [1, "body-changed-private"],
    ] as const) {
      const error = captureStoreError(() =>
        store.recordInbound("message-private", sequence, body),
      );
      expect(error).toMatchObject({
        name: "StoreInboundConflictError",
        code: "STORE_INBOUND_CONFLICT",
        message: "STORE_INBOUND_CONFLICT",
      });
      expect(error).toBeInstanceOf(StoreInboundConflictError);
      expect(error.message).not.toMatch(
        /message-private|body-private|body-changed-private/,
      );
    }

    expect(store.recordInbound("message-private", 1, "body-private")).toBe(
      "duplicate",
    );
    store.close();
  });

  it("rejects a different inbound message at an already recorded sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("message-1", 1, "first-body");

    const error = captureStoreError(() =>
      store.recordInbound("message-2-private", 1, "second-body-private"),
    );
    expect(error).toMatchObject({
      name: "StoreInboundConflictError",
      code: "STORE_INBOUND_CONFLICT",
      message: "STORE_INBOUND_CONFLICT",
    });
    expect(error).toBeInstanceOf(StoreInboundConflictError);
    expect(error.message).not.toMatch(/message-2-private|second-body-private/);
    expect(store.recordInbound("message-1", 1, "first-body")).toBe("duplicate");
    store.close();
  });

  it("stores the latest job mapping and rejects conflicting unique identities", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.mapJob({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "running",
    });
    store.mapJob({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "waiting_approval",
    });

    expect(store.findJob("job-1")).toEqual({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "waiting_approval",
    });
    expect(() =>
      store.mapJob({
        jobId: "job-1",
        attempt: 1,
        sessionId: "session-2",
        status: "running",
      }),
    ).toThrow(/STORE_MAPPING_CONFLICT/);
    expect(() =>
      store.mapJob({
        jobId: "job-2",
        attempt: 1,
        sessionId: "session-1",
        status: "running",
      }),
    ).toThrow(/STORE_MAPPING_CONFLICT/);
    store.close();
  });

  it("chooses the greatest attempt deterministically when a job has multiple attempts", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.mapJob({
      jobId: "job-retry",
      attempt: 1,
      sessionId: "session-retry-1",
      status: "failed",
    });
    store.mapJob({
      jobId: "job-retry",
      attempt: 2,
      sessionId: "session-retry-2",
      status: "running",
    });

    expect(store.findJob("job-retry")).toEqual({
      jobId: "job-retry",
      attempt: 2,
      sessionId: "session-retry-2",
      status: "running",
    });
    store.close();
  });

  it("lists active job mappings deterministically and excludes terminal mappings", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    for (const mapping of [
      {
        jobId: "job-zulu",
        attempt: 2,
        sessionId: "session-zulu-2",
        status: "running",
      },
      {
        jobId: "job-alpha",
        attempt: 2,
        sessionId: "session-alpha-2",
        status: "waiting_approval",
      },
      {
        jobId: "job-alpha",
        attempt: 1,
        sessionId: "session-alpha-1",
        status: "failed",
      },
      {
        jobId: "job-bravo",
        attempt: 1,
        sessionId: "session-bravo-1",
        status: "cancelling",
      },
      {
        jobId: "job-cancelled",
        attempt: 1,
        sessionId: "session-cancelled",
        status: "cancelled",
      },
      {
        jobId: "job-expired",
        attempt: 1,
        sessionId: "session-expired",
        status: "expired",
      },
      {
        jobId: "job-succeeded",
        attempt: 1,
        sessionId: "session-succeeded",
        status: "succeeded",
      },
    ]) {
      store.mapJob(mapping);
    }
    store.close();

    const reopened = new SqlitePluginStore(databasePath);

    expect(reopened.listNonterminalJobs()).toEqual([
      {
        jobId: "job-alpha",
        attempt: 2,
        sessionId: "session-alpha-2",
        status: "waiting_approval",
      },
      {
        jobId: "job-bravo",
        attempt: 1,
        sessionId: "session-bravo-1",
        status: "cancelling",
      },
      {
        jobId: "job-zulu",
        attempt: 2,
        sessionId: "session-zulu-2",
        status: "running",
      },
    ]);
    reopened.close();
  });

  it("fails closed with a safe error when the mapping query is unavailable", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    const sabotagingConnection = new Database(databasePath);
    sabotagingConnection.exec("DROP TABLE job_mappings");
    sabotagingConnection.close();

    const error = captureStoreError(() => store.listNonterminalJobs());

    expect(error).toMatchObject({
      code: "STORE_JOB_MAPPING_READ_FAILED",
      message: "STORE_JOB_MAPPING_READ_FAILED",
    });
    expect(error.message).not.toMatch(/job_mappings|SELECT|sqlite/iu);
    store.close();
  });

  it("keeps outbound event sequences monotonic, replays pending events, and acknowledges idempotently", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.enqueueEvent(event(1));
    store.enqueueEvent(event(2));
    expect(store.pendingEvents(0)).toMatchObject([
      { messageId: "event-1", sequence: 1, attempts: 1 },
      { messageId: "event-2", sequence: 2, attempts: 1 },
    ]);
    expect(store.pendingEvents(1)).toMatchObject([
      { messageId: "event-2", sequence: 2, attempts: 2 },
    ]);
    expect(() => store.enqueueEvent(event(2, "event-conflict"))).toThrow(
      StoreSequenceError,
    );
    expect(() => store.enqueueEvent(event(1, "event-1-conflict"))).toThrow(
      StoreSequenceError,
    );

    store.acknowledgeEvent("event-1");
    store.acknowledgeEvent("event-1");
    expect(store.pendingEvents(0).map(({ messageId }) => messageId)).toEqual([
      "event-2",
    ]);
    store.close();

    const reopened = new SqlitePluginStore(databasePath);
    reopened.enqueueEvent(event(3, "event-3"));
    expect(reopened.pendingEvents(0).map(({ messageId }) => messageId)).toEqual(
      ["event-2", "event-3"],
    );
    reopened.close();
    expect(existsSync(databasePath)).toBe(true);
  });

  it("reports the durable maximum outbound sequence across acknowledged and pending rows", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    expect(store.maxOutboundSequence()).toBe(0);
    store.enqueueEvent(event(7, "pending-event"));
    store.enqueueEvent(event(11, "acknowledged-event"));
    store.acknowledgeEvent("acknowledged-event");
    expect(store.maxOutboundSequence()).toBe(11);
    store.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.maxOutboundSequence()).toBe(11);
    expect(reopened.pendingEvents(0)).toMatchObject([
      { messageId: "pending-event", sequence: 7 },
    ]);
    reopened.close();
  });

  it("rejects an unsafe durable outbound sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();
    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO outbound_events
          (message_id, sequence, payload_json, attempts, acknowledged_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "unsafe-event",
        Number.MAX_SAFE_INTEGER + 1,
        "{}",
        0,
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
      );
    database.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(() => reopened.maxOutboundSequence()).toThrow(
      "STORE_SEQUENCE_INVALID",
    );
    reopened.close();
  });

  it("always initializes outbound delivery state instead of accepting forged state", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    const forgedInput = {
      ...event(1, "event-forged"),
      attempts: 41,
      acknowledgedAt: "2026-09-04T00:00:00.000Z",
    } as OutboundEventInput;

    store.enqueueEvent(forgedInput);

    expect(store.pendingEvents(0)).toEqual([
      {
        messageId: "event-forged",
        sequence: 1,
        payload: JSON.stringify({ sequence: 1 }),
        attempts: 1,
        acknowledgedAt: null,
      },
    ]);
    store.close();
  });

  it("preserves mappings and unacknowledged events across a simulated process exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "qhb-plugin-store-parent-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nested", "state.sqlite");
    mkdirSync(join(directory, "nested"));
    const first = new SqlitePluginStore(databasePath);
    first.mapJob({
      jobId: "job-reopen",
      attempt: 2,
      sessionId: "session-reopen",
      status: "running",
    });
    first.enqueueEvent(event(7, "event-reopen"));
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.findJob("job-reopen")).toEqual({
      jobId: "job-reopen",
      attempt: 2,
      sessionId: "session-reopen",
      status: "running",
    });
    expect(reopened.pendingEvents(0)).toMatchObject([
      { messageId: "event-reopen", sequence: 7 },
    ]);
    reopened.close();
  });
});
