import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, database } from "./client.js";

const migrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

try {
  await migrate(database.db, { migrationsFolder });
} catch {
  console.error("QHB database migration failed.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
