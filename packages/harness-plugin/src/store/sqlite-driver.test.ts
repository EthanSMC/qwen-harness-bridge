import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase, SqliteUnavailableError } from "./sqlite-driver.js";

it("executes statements and reports bounded row results", () => {
  const database = openDatabase(":memory:");
  try {
    database.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
    );
    const insert = database.prepare("INSERT INTO t(name) VALUES (?)");
    expect(insert.run("alpha")).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(database.prepare("SELECT name FROM t WHERE id = ?").get(1)).toEqual({
      name: "alpha",
    });
    expect(database.prepare("SELECT name FROM t ORDER BY id").all()).toEqual([
      { name: "alpha" },
    ]);
    expect(database.prepare("SELECT name FROM t WHERE id = 99").get()).toBe(
      undefined,
    );
  } finally {
    database.close();
  }
});

it("reads and writes pragmas", () => {
  const database = openDatabase(":memory:");
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("user_version = 7");
    expect(Number(database.pragma("user_version", { simple: true }))).toBe(7);
  } finally {
    database.close();
  }
});

/** A host without the built-in module must fail closed with a bounded domain
 * code instead of an engine-level module-resolution crash during plugin load. */
it("fails closed with a bounded error when the host lacks node:sqlite", () => {
  expect(() =>
    openDatabase(":memory:", {
      load: () => {
        throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
      },
    }),
  ).toThrow(SqliteUnavailableError);
  expect(() =>
    openDatabase(":memory:", {
      load: () => ({}) as never,
    }),
  ).toThrow("STORE_SQLITE_UNAVAILABLE");
});

it("waits for a busy database instead of failing immediately", () => {
  const database = openDatabase(":memory:");
  try {
    // better-sqlite3 waited five seconds before reporting a lock conflict, and
    // the standalone store relies on that under transient contention;
    // node:sqlite defaults the busy timeout to zero.
    expect(Number(database.pragma("busy_timeout", { simple: true }))).toBe(
      5000,
    );
  } finally {
    database.close();
  }
});

it("commits, rolls back and exposes transaction state", () => {
  const database = openDatabase(":memory:");
  try {
    database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const insert = database.transaction((name: string) => {
      expect(database.inTransaction).toBe(true);
      database.prepare("INSERT INTO t(id, name) VALUES (1, ?)").run(name);
      return name;
    });
    expect(database.inTransaction).toBe(false);
    expect(insert("kept")).toBe("kept");
    expect(database.prepare("SELECT name FROM t").get()).toEqual({
      name: "kept",
    });

    const failing = database.transaction(() => {
      database.prepare("UPDATE t SET name = ? WHERE id = 1").run("discarded");
      throw new Error("rollback");
    });
    expect(() => failing.immediate()).toThrow("rollback");
    expect(database.prepare("SELECT name FROM t").get()).toEqual({
      name: "kept",
    });
    expect(database.inTransaction).toBe(false);
  } finally {
    database.close();
  }
});

it("persists to a file and closes", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "qhb-sqlite-")));
  const path = join(directory, "store.sqlite");
  try {
    const first = openDatabase(path);
    first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    first.prepare("INSERT INTO t(id, value) VALUES (1, ?)").run("persisted");
    first.close();

    const second = openDatabase(path);
    expect(second.prepare("SELECT value FROM t WHERE id = 1").get()).toEqual({
      value: "persisted",
    });
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
