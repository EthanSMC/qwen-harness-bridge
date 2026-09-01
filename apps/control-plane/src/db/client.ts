import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export type DatabaseHandle = {
  db: Database;
  sql: ReturnType<typeof postgres>;
};

export type DatabaseOptions = {
  databaseUrl?: string;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
};

export function createDatabase(options: DatabaseOptions = {}): DatabaseHandle {
  const sql = postgres(options.databaseUrl ?? config.databaseUrl, {
    max: options.maxConnections ?? config.dbPoolMax,
    idle_timeout: options.idleTimeoutSeconds ?? config.dbIdleTimeoutSeconds,
    connect_timeout:
      options.connectTimeoutSeconds ?? config.dbConnectTimeoutSeconds,
    prepare: false,
  });

  return {
    db: drizzle(sql, { schema }),
    sql,
  };
}

export function createDbClient(options: DatabaseOptions = {}): Database {
  return createDatabase(options).db;
}

export const database = createDatabase();
export const db = database.db;

export async function closeDatabase(): Promise<void> {
  await database.sql.end({ timeout: 5 });
}
