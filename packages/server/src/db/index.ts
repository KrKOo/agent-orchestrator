import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export { schema };
export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

/** Opens (creating if needed) the SQLite database at `path` (`:memory:` for tests) and applies migrations. */
export function createDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA synchronous = NORMAL");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
