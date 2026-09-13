import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { SqlitePluginStore } from "./plugin-store.js";

/** Temporary diagnostic: report how the store engine reacts to an external
 * write lock so the Linux CI run can explain the lock-semantics difference. */
it("diagnostic: external writer lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-lock-diag-"));
  const path = join(directory, "state.sqlite");
  const store = new SqlitePluginStore(path);
  const raw = new Database(path);
  const observations: Record<string, unknown> = {};
  try {
    const adapter = (
      store as unknown as {
        database: {
          exec(sql: string): void;
          pragma(statement: string, options?: { simple: true }): unknown;
          inTransaction: boolean;
        };
      }
    ).database;
    observations.platform = process.platform;
    observations.node = process.version;
    observations.storeJournal = adapter.pragma("journal_mode", {
      simple: true,
    });
    observations.rawJournal = raw.pragma("journal_mode", { simple: true });
    adapter.pragma("busy_timeout = 1");
    observations.storeBusy = adapter.pragma("busy_timeout", { simple: true });
    raw.exec("BEGIN IMMEDIATE");
    observations.rawInTransaction = raw.inTransaction;
    try {
      adapter.exec("BEGIN IMMEDIATE");
      observations.directBegin = "succeeded";
      adapter.exec("ROLLBACK");
    } catch (error) {
      observations.directBegin = String(error);
    }
    raw.exec("ROLLBACK");
    observations.afterRollback = adapter.inTransaction;
  } finally {
    raw.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(
    observations.directBegin,
    `LOCK_DIAGNOSTIC ${JSON.stringify(observations)}`,
  ).not.toBe("succeeded");
});
