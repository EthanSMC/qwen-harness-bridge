import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqlitePluginStore,
  type StoredOutboundEvent,
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
): StoredOutboundEvent => ({
  messageId,
  sequence,
  payload: JSON.stringify({ sequence }),
  attempts: 0,
});

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

  it("rejects an unknown future schema version without applying a partial migration", () => {
    const databasePath = makeDatabasePath();
    const database = new Database(databasePath);
    database.pragma("user_version = 99");
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_VERSION_UNSUPPORTED",
    );

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(99);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'",
        )
        .get(),
    ).toBeUndefined();
    reopened.close();
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
