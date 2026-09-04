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
