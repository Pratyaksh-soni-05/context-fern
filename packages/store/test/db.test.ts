import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openFernDb } from "../src/db";
import { SCHEMA_VERSION } from "../src/schema";
import { type TempDir, withTempFernDir } from "./test-helpers";

let dir: TempDir | undefined;
let openDbs: Database[] = [];

afterEach(async () => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  if (dir) await dir.cleanup();
  dir = undefined;
});

// sqlite_sequence is SQLite's own bookkeeping table for AUTOINCREMENT
// columns (decisions.seq) — present, not one of ours.
function nonSqliteTables(db: Database): string[] {
  return db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

test("openFernDb creates every table and turns WAL mode on", async () => {
  dir = await withTempFernDir();
  const db = await openFernDb(join(dir.path, "fern.db"));
  openDbs.push(db);

  const mode = db.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(mode.journal_mode.toLowerCase()).toBe("wal");

  expect(nonSqliteTables(db)).toEqual(
    [
      "decisions",
      "fronds",
      "leaflets",
      "migrations",
      "roots",
      "sessions",
    ].sort(),
  );

  const migrations = db.query("SELECT version FROM migrations").all();
  expect(migrations).toHaveLength(1);
});

test("re-opening an existing DB is idempotent — no duplicate tables, no re-applied migrations", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "fern.db");

  const first = await openFernDb(path);
  first.close();
  const second = await openFernDb(path);
  openDbs.push(second);

  const migrations = second.query("SELECT version FROM migrations").all();
  expect(migrations).toHaveLength(1);
});

test("refuses to open a DB stamped with a newer schema version than this code knows about", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "fern.db");

  // Simulate "a newer Context Fern already migrated this DB."
  const future = new Database(path);
  future.exec(
    "CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
  );
  future
    .query(
      "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)",
    )
    .run(
      SCHEMA_VERSION + 1,
      "a migration from the future",
      new Date().toISOString(),
    );
  future.close();

  await expect(openFernDb(path)).rejects.toThrow(
    new RegExp(`version ${SCHEMA_VERSION + 1}.*version ${SCHEMA_VERSION}`, "s"),
  );

  // No `sessions`/`fronds`/etc. table should have been created — the
  // refusal happens before any other schema work.
  const db = new Database(path);
  openDbs.push(db);
  expect(nonSqliteTables(db)).toEqual(["migrations"]);
});
