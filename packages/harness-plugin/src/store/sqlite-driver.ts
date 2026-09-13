import { DatabaseSync, type StatementSync } from "node:sqlite";

/** better-sqlite3 waited this long for a busy database before reporting a lock
 * conflict; node:sqlite defaults the busy timeout to zero, which would turn
 * transient contention into an immediate failure. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Result of a write statement, matching the shape the store already consumes. */
export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface SqliteStatement {
  run(...params: readonly unknown[]): SqliteRunResult;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
}

export interface SqliteTransaction<A extends readonly unknown[], R> {
  (...args: A): R;
  immediate(): R;
  deferred(): R;
  exclusive(): R;
}

export interface SqliteDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): void;
  /** Register a deterministic SQL function; throwing propagates to the caller. */
  function(name: string, implementation: (...args: unknown[]) => unknown): void;
  pragma(statement: string, options?: { readonly simple: true }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<A extends readonly unknown[], R>(
    fn: (...args: A) => R,
  ): SqliteTransaction<A, R>;
  close(): void;
}

const normalizeValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  return value;
};

const normalizeRow = (row: unknown): unknown => {
  if (row === null || row === undefined) return row;
  if (typeof row !== "object") return normalizeValue(row);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
};

class NodeSqliteStatement implements SqliteStatement {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    // Read every integer as a bigint and narrow it ourselves, so an out-of-range
    // durable value is reported by the store's own validation instead of an
    // engine-level RangeError.
    statement.setReadBigInts(true);
    this.#statement = statement;
  }

  run(...params: readonly unknown[]): SqliteRunResult {
    const result = this.#statement.run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get(...params: readonly unknown[]): unknown {
    return normalizeRow(this.#statement.get(...(params as never[])));
  }

  all(...params: readonly unknown[]): unknown[] {
    return (this.#statement.all(...(params as never[])) as unknown[]).map(
      normalizeRow,
    );
  }
}

/**
 * A small, engine-agnostic database facade over the built-in `node:sqlite`.
 * The durable store uses exactly this surface, so the connector carries no
 * compiled native module and therefore no host-ABI dependency.
 */
class NodeSqliteDatabase implements SqliteDatabase {
  readonly #database: DatabaseSync;
  #savepoints = 0;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    // Per-connection, like the previous engine's default.
    this.#database.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
  }

  get inTransaction(): boolean {
    return this.#database.isTransaction;
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  function(
    name: string,
    implementation: (...args: unknown[]) => unknown,
  ): void {
    this.#database.function(name, implementation as never);
  }

  pragma(statement: string, options?: { readonly simple: true }): unknown {
    if (options?.simple === true) {
      const row = this.#database.prepare(`PRAGMA ${statement}`).get() as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) return undefined;
      const [first] = Object.values(row);
      return normalizeValue(first);
    }
    this.#database.exec(`PRAGMA ${statement}`);
    return undefined;
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.#database.prepare(sql));
  }

  transaction<A extends readonly unknown[], R>(
    fn: (...args: A) => R,
  ): SqliteTransaction<A, R> {
    const invoke =
      (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE") =>
      (...args: A): R => {
        const outermost = !this.#database.isTransaction;
        let savepoint: string | undefined;
        if (outermost) {
          this.#database.exec(`BEGIN ${mode}`);
        } else {
          this.#savepoints += 1;
          savepoint = `qhb_sp_${this.#savepoints}`;
          this.#database.exec(`SAVEPOINT ${savepoint}`);
        }
        try {
          const result = fn(...args);
          if (outermost) {
            this.#database.exec("COMMIT");
          } else if (savepoint !== undefined) {
            this.#database.exec(`RELEASE ${savepoint}`);
          }
          return result;
        } catch (error) {
          try {
            if (outermost) this.#database.exec("ROLLBACK");
            else if (savepoint !== undefined) {
              this.#database.exec(`ROLLBACK TO ${savepoint}`);
              this.#database.exec(`RELEASE ${savepoint}`);
            }
          } catch {
            // Preserve the original failure; SQLite already unwound the frame.
          }
          throw error;
        } finally {
          if (!outermost && savepoint !== undefined) this.#savepoints -= 1;
        }
      };
    const deferred = invoke("DEFERRED");
    return Object.assign(deferred, {
      immediate: invoke("IMMEDIATE"),
      deferred,
      exclusive: invoke("EXCLUSIVE"),
    }) as SqliteTransaction<A, R>;
  }

  close(): void {
    this.#database.close();
  }
}

export const openDatabase = (path: string): SqliteDatabase =>
  new NodeSqliteDatabase(path);
