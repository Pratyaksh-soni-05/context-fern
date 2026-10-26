import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PRODUCT_NAME } from "@context-fern/core";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

/**
 * Opens (or creates) `.fern/fern.db` in WAL mode and brings it to
 * `SCHEMA_VERSION`. Refuses to open — throws before running any other
 * query — if the DB's own recorded schema version is newer than this
 * code knows about (an older binary must not silently query a newer
 * schema it doesn't understand).
 */
export async function openFernDb(dbPath: string): Promise<Database> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .query("SELECT MAX(version) AS maxVersion FROM migrations")
    .get() as { maxVersion: number | null };
  const currentVersion = row.maxVersion ?? 0;

  if (currentVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Can't open ${dbPath}: its schema is version ${currentVersion}, but this version of ${PRODUCT_NAME} only knows up to version ${SCHEMA_VERSION}. Update ${PRODUCT_NAME} before opening this project again.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length > 0) {
    const applyAll = db.transaction(() => {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.query(
          "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, new Date().toISOString());
      }
    });
    applyAll();
  }

  return db;
}
