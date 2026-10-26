// Versioned SQLite schema for `.fern/fern.db` — spec §12. Every migration
// is a plain SQL string, applied once, recorded in `migrations`. The
// `migrations` table is both the audit log and the version-gate source of
// truth: `openFernDb` refuses to open a DB whose recorded max version is
// higher than `SCHEMA_VERSION` (an older binary opening a newer DB would
// otherwise silently run queries against a schema it doesn't understand).
//
// Table naming: spec §12 still says `exchanges` (pre-dates the 2026-10-24
// Leaflet rename) and lists an `embeddings` (sqlite-vec) table. This
// schema uses `leaflets` (matching the renamed `Leaflet` type) and skips
// `embeddings` — frond centroids are a JSON array directly on
// `fronds.centroid`; no vector index is needed yet. See docs/decisions.md.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        project_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        active_frond_id TEXT
      );

      CREATE TABLE fronds (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        parent_id TEXT REFERENCES fronds(id),
        name TEXT NOT NULL,
        color_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        centroid TEXT,
        brief_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE leaflets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        idx INTEGER NOT NULL,
        frond_id TEXT REFERENCES fronds(id),
        stray_from TEXT REFERENCES fronds(id),
        prompt_hash TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        files_touched TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        leaflet_id TEXT REFERENCES leaflets(id),
        action TEXT NOT NULL,
        target TEXT,
        with_frond TEXT,
        stage TEXT NOT NULL,
        roots_used TEXT,
        signals TEXT NOT NULL,
        confidence REAL NOT NULL,
        tokens_before INTEGER NOT NULL,
        tokens_after INTEGER NOT NULL,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        undone INTEGER NOT NULL DEFAULT 0,
        inverse TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE roots (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        source TEXT NOT NULL,
        label TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_fronds_session ON fronds(session_id);
      CREATE INDEX idx_leaflets_session ON leaflets(session_id);
      CREATE INDEX idx_decisions_session_seq ON decisions(session_id, seq);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
