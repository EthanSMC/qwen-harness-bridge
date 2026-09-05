import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  drizzle,
  type PostgresJsDatabase,
} from "../../../apps/control-plane/node_modules/drizzle-orm/postgres-js";
import { migrate } from "../../../apps/control-plane/node_modules/drizzle-orm/postgres-js/migrator";
import postgres, {
  type Sql,
} from "../../../apps/control-plane/node_modules/postgres";
import * as schema from "../../../apps/control-plane/src/db/schema.js";

const execFileAsync = promisify(execFile);

type PostgresBinaries = {
  initdb: string;
  pgCtl: string;
  createdb: string;
};

export type TestDatabaseClient = PostgresJsDatabase<typeof schema>;

export type QueryResult<T> = { rows: T[] };

export type TestDatabase = {
  readonly client: TestDatabaseClient;
  start(): Promise<void>;
  stop(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};

type IsolatedCluster = {
  rootDir: string;
  dataDir: string;
  socketDir: string;
  database: string;
  user: string;
  binaries: PostgresBinaries;
  running: boolean;
};

const migrationsFolder = fileURLToPath(
  new URL("../../../apps/control-plane/src/db/migrations", import.meta.url),
);

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const findBinary = (name: string): string | undefined => {
  const configuredDirectory = process.env.PG_BINDIR;
  const candidates = [
    configuredDirectory === undefined
      ? undefined
      : `${configuredDirectory}/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/lib/postgresql/16/bin/${name}`,
    `/usr/bin/${name}`,
  ];

  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && existsSync(candidate),
  );
};

const resolvePostgresBinaries = (): PostgresBinaries => {
  const initdb = findBinary("initdb");
  const pgCtl = findBinary("pg_ctl");
  const createdb = findBinary("createdb");
  if (initdb === undefined || pgCtl === undefined || createdb === undefined) {
    throw new Error(
      "PostgreSQL integration tests require initdb, pg_ctl, and createdb; set PG_BINDIR or install PostgreSQL 16",
    );
  }
  return { initdb, pgCtl, createdb };
};

const run = async (binary: string, args: string[]): Promise<void> => {
  await execFileAsync(binary, args, {
    env: {
      ...process.env,
      LC_ALL: "C",
    },
    maxBuffer: 4 * 1024 * 1024,
  });
};

class TemporaryPostgresDatabase implements TestDatabase {
  constructor(private readonly migrationPath = migrationsFolder) {}

  #database: TestDatabaseClient | undefined;
  #sql: Sql<Record<string, unknown>> | undefined;
  #cluster: IsolatedCluster | undefined;
  #started = false;

  get client(): TestDatabaseClient {
    if (this.#database === undefined) {
      throw new Error("Test database has not been started");
    }
    return this.#database;
  }

  get sql(): Sql<Record<string, unknown>> {
    if (this.#sql === undefined) {
      throw new Error("Test database has not been started");
    }
    return this.#sql;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    try {
      const externalUrl = process.env.TEST_DATABASE_URL?.trim();
      if (externalUrl !== undefined && externalUrl.length > 0) {
        this.#sql = postgres(externalUrl, {
          max: 8,
          prepare: false,
        });
      } else {
        await this.#startIsolatedCluster();
      }

      await this.sql`SELECT 1`;
      this.#database = drizzle(this.sql, { schema });
      await migrate(this.#database, { migrationsFolder: this.migrationPath });
      this.#started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#database = undefined;

    const sql = this.#sql;
    this.#sql = undefined;
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }

    const cluster = this.#cluster;
    this.#cluster = undefined;
    if (cluster !== undefined) {
      if (cluster.running) {
        await execFileAsync(
          cluster.binaries.pgCtl,
          ["-D", cluster.dataDir, "-m", "fast", "-w", "stop"],
          {
            env: { ...process.env, LC_ALL: "C" },
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      }
      await rm(cluster.rootDir, { recursive: true, force: true });
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const rows = await this.sql.unsafe(
      text,
      values.map((value) =>
        value instanceof Date ? value.toISOString() : value,
      ),
    );
    return { rows: Array.from(rows) as T[] };
  }

  async #startIsolatedCluster(): Promise<void> {
    const binaries = resolvePostgresBinaries();
    const rootDir = await mkdtemp(join(tmpdir(), "qhb-job-repository-"));
    const dataDir = join(rootDir, "data");
    const socketDir = join(rootDir, "socket");
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const user = `qhb_test_${process.pid}_${suffix}`;
    const database = `qhb_test_db_${process.pid}_${suffix}`;
    const cluster: IsolatedCluster = {
      rootDir,
      dataDir,
      socketDir,
      database,
      user,
      binaries,
      running: false,
    };
    this.#cluster = cluster;

    try {
      await mkdir(socketDir);
      await run(binaries.initdb, [
        "--pgdata",
        dataDir,
        "--username",
        user,
        "--auth-local",
        "trust",
        "--auth-host",
        "trust",
        "--no-locale",
        "--encoding",
        "UTF8",
      ]);

      const postgresOptions = [
        "-F",
        "-c listen_addresses=''",
        `-c unix_socket_directories=${shellQuote(socketDir)}`,
        "-c fsync=off",
        "-c synchronous_commit=off",
      ].join(" ");
      await run(binaries.pgCtl, [
        "-D",
        dataDir,
        "-o",
        postgresOptions,
        "-l",
        join(rootDir, "postgres.log"),
        "-w",
        "start",
      ]);
      cluster.running = true;

      await run(binaries.createdb, [
        "--host",
        socketDir,
        "--username",
        user,
        database,
      ]);
      this.#sql = postgres({
        host: socketDir,
        username: user,
        database,
        max: 8,
        prepare: false,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
}

export const createTestDatabase = (
  options: { migrationsFolder?: string } = {},
): TestDatabase => new TemporaryPostgresDatabase(options.migrationsFolder);
