// The typed repository API — spec §12. Pure core logic (buildDecision,
// buildDecisionInverse, runningMean) stays in core; this file only
// persists: SQLite rows, the journal mirror, and the brief files that
// go with a frond. See docs/decisions.md, 2026-10-26.

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  buildDecision,
  DEGRADED_SIGNAL,
  type Decision,
  type DecisionAction,
  type DecisionInverse,
  type FileTouch,
  type Frond,
  type FrondStatus,
  type Leaflet,
  type Mode,
  type RouterState,
  runningMean,
  type Session,
} from "@context-fern/core";
import {
  appendMergeBlock,
  archiveOrDeleteBrief,
  createBrief,
  parseRecentEntries,
  readBrief,
  stripMergeBlock,
} from "./briefs";
import { openFernDb } from "./db";
import { JsonlJournalSink } from "./jsonl-journal-sink";

function newId(): string {
  return crypto.randomUUID();
}
function nowIso(): string {
  return new Date().toISOString();
}

// --- row <-> type mapping -------------------------------------------------

interface SessionRow {
  id: string;
  agent: string;
  project_path: string;
  started_at: string;
  mode: string;
  active_frond_id: string | null;
}

interface FrondRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  name: string;
  color_index: number;
  status: string;
  centroid: string | null;
  brief_path: string;
  created_at: string;
}

interface LeafletRow {
  id: string;
  session_id: string;
  idx: number;
  frond_id: string | null;
  stray_from: string | null;
  prompt_hash: string;
  token_count: number;
  files_touched: string;
  created_at: string;
}

interface DecisionRow {
  id: string;
  session_id: string;
  leaflet_id: string | null;
  action: string;
  target: string | null;
  with_frond: string | null;
  stage: string;
  roots_used: string | null;
  signals: string;
  confidence: number;
  tokens_before: number;
  tokens_after: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  undone: number;
  inverse: string;
  created_at: string;
}

function rowToFrond(row: FrondRow): Frond {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    name: row.name,
    colorIndex: row.color_index,
    status: row.status as FrondStatus,
    centroid: row.centroid ? (JSON.parse(row.centroid) as number[]) : null,
    briefPath: row.brief_path,
    createdAt: row.created_at,
  };
}

function rowToDecision(row: DecisionRow): Decision {
  const stage = row.stage === "0" ? 0 : row.stage === "2" ? 2 : "manual";
  return {
    id: row.id,
    sessionId: row.session_id,
    leafletId: row.leaflet_id,
    action: row.action as DecisionAction,
    target: row.target,
    ...(row.with_frond !== null ? { with: row.with_frond } : {}),
    stage,
    ...(row.roots_used !== null
      ? { rootsUsed: JSON.parse(row.roots_used) as string[] }
      : {}),
    signals: JSON.parse(row.signals) as string[],
    confidence: row.confidence,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    undone: row.undone === 1,
    inverse: JSON.parse(row.inverse) as DecisionInverse,
    createdAt: row.created_at,
  };
}

// --- active-frond resolution: the stem is always the concrete fallback ---
// (never a literal NULL in storage) — see docs/decisions.md, 2026-10-26.

function getStemFrondId(db: Database, sessionId: string): string {
  const row = db
    .query("SELECT id FROM fronds WHERE session_id = ? AND parent_id IS NULL")
    .get(sessionId) as { id: string } | null;
  if (!row) {
    throw new Error(
      `Corrupted store: session ${sessionId} has no stem frond. This should never happen.`,
    );
  }
  return row.id;
}

function toRouterActiveFrondId(
  storedId: string,
  stemId: string,
): string | null {
  return storedId === stemId ? null : storedId;
}

function fromRouterActiveFrondId(
  routerId: string | null,
  stemId: string,
): string {
  return routerId ?? stemId;
}

// --- repository -------------------------------------------------------------

export interface CreateSessionInput {
  agent: string;
  projectPath: string;
  mode: Mode;
}

export interface CreateFrondInput {
  sessionId: string;
  parentId: string | null;
  name: string;
  colorIndex: number;
  centroid?: number[] | null;
  status?: FrondStatus;
}

export interface RecordLeafletInput {
  sessionId: string;
  index: number;
  frondId: string | null;
  strayFrom: string | null;
  promptHash: string;
  tokenCount: number;
  filesTouched: FileTouch[];
}

/** One row for `fern ui`'s List view — a leaflet joined with its most recent decision and (where recoverable) real prompt text. See docs/decisions.md on why `promptPreview` is `null` for most leaflets: the brief's Recent section is the only place real prompt text exists on disk, and it's capped at 5 tagged entries per frond. */
export interface UiLeaflet {
  turn: number;
  frondName: string;
  isStray: boolean;
  strayFromFrondName: string | null;
  kind: DecisionAction | null;
  promptPreview: string | null;
  tokenCount: number;
  confidence: number | null;
  filesTouchedCount: number;
}

export interface UiLeafletPage {
  leaflets: UiLeaflet[];
  total: number;
}

/**
 * Stat-tile source data. `undo` is `null` ("n/a" in the UI) when there
 * are fewer than 5 actionable decisions — too few for a ratio to mean
 * anything. `rootsUsed` and `ctxKeptOut` aren't included here: they're
 * fixed literals the daemon composes directly (`0` and `"n/a"`), not
 * derived from a query — see docs/decisions.md on why (`roots` is
 * schema-only and unwritten; isolate-mode token accounting isn't built).
 */
export interface SessionStats {
  frondCount: number;
  strayCount: number;
  /** Leaflets that open a frond (a `new` decision, not undone). Each is a real leaflet in the leaflet count, so the count is turns plus these. */
  frondOpenings: number;
  undo: { count: number; of: number } | null;
}

export interface HeatmapRow {
  frondName: string;
  cells: (string | null)[];
}

export interface HeatmapResult {
  rows: HeatmapRow[];
  turnsPerCell: number;
}

export interface FernStore {
  db: Database;
  createSession(input: CreateSessionInput): Promise<Session>;
  findSessionByProjectPath(projectPath: string): Promise<Session | null>;
  /** Every distinct `project_path` any session row in this store was ever created under — used to migrate historical rows stored under a now-non-canonical spelling (a short/long Windows path, mixed case, a trailing slash) onto the one canonical spelling, without losing their history. See docs/decisions.md. */
  listDistinctProjectPaths(): Promise<string[]>;
  /** Rewrites every session row's `project_path` from `oldPath` to `newPath` — the write half of the migration above. A no-op (0 rows) if nothing currently matches `oldPath`. */
  renameSessionsProjectPath(oldPath: string, newPath: string): Promise<void>;
  createFrond(input: CreateFrondInput): Promise<Frond>;
  recordLeaflet(input: RecordLeafletInput): Promise<Leaflet>;
  recordDecision(
    decision: Decision,
    promptEmbedding: number[] | null,
  ): Promise<Decision>;
  listFronds(sessionId: string): Promise<Frond[]>;
  getTree(sessionId: string): Promise<{ session: Session; fronds: Frond[] }>;
  loadRouterState(sessionId: string): Promise<RouterState>;
  setActiveFrond(sessionId: string, frondId: string | null): Promise<void>;
  setMode(sessionId: string, mode: Mode): Promise<void>;
  getMostRecentLeaflet(sessionId: string): Promise<Leaflet | null>;
  markStray(leafletId: string, strayFrom: string | null): Promise<Decision>;
  undoLast(sessionId: string): Promise<Decision>;
  mergeFrond(frondId: string): Promise<Decision>;
  /** `fern ui`'s List view — windowed, so a session with thousands of leaflets never has to render (or query) them all at once. */
  listLeafletsWithDecisions(
    sessionId: string,
    page: { offset: number; limit: number },
  ): Promise<UiLeafletPage>;
  /** `fern ui`'s stat tiles. */
  getSessionStats(sessionId: string): Promise<SessionStats>;
  /** `fern ui`'s Categories view topic-switching heat map, aggregated into at most `maxColumns` columns so a long session doesn't produce one column per turn. */
  heatmapRows(sessionId: string, maxColumns: number): Promise<HeatmapResult>;
  /** `fern ui`'s Start screen — how many sessions this store has recorded for one project path (almost always every session in this store, since one store serves one project). */
  countSessionsForProjectPath(projectPath: string): Promise<number>;
  close(): void;
}

export async function openFernStore(fernDir: string): Promise<FernStore> {
  const db = await openFernDb(join(fernDir, "fern.db"));
  const journal = new JsonlJournalSink(join(fernDir, "journal.jsonl"));
  const frondsDir = join(fernDir, "fronds");

  function briefPathFor(name: string): string {
    return join(frondsDir, `${name}.md`);
  }

  function getSessionRow(sessionId: string): SessionRow {
    const row = db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | null;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    return row;
  }

  function getFrondRow(frondId: string): FrondRow {
    const row = db
      .query("SELECT * FROM fronds WHERE id = ?")
      .get(frondId) as FrondRow | null;
    if (!row) throw new Error(`No such frond: ${frondId}`);
    return row;
  }

  function setFrondStatus(frondId: string, status: FrondStatus): void {
    db.query("UPDATE fronds SET status = ? WHERE id = ?").run(status, frondId);
  }

  // Synchronous core — callable from inside a db.transaction() callback
  // (bun:sqlite transactions wrap a sync function). The public
  // `setActiveFrond` below is just this, for callers outside a transaction.
  function setActiveFrondSync(
    sessionId: string,
    frondId: string | null,
  ): string {
    const stemId = getStemFrondId(db, sessionId);
    const resolved = frondId ?? stemId;
    db.query("UPDATE sessions SET active_frond_id = ? WHERE id = ?").run(
      resolved,
      sessionId,
    );
    return resolved;
  }

  async function setActiveFrond(
    sessionId: string,
    frondId: string | null,
  ): Promise<void> {
    setActiveFrondSync(sessionId, frondId);
  }

  async function createSession(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: newId(),
      agent: input.agent,
      projectPath: input.projectPath,
      startedAt: nowIso(),
      mode: input.mode,
    };
    db.query(
      "INSERT INTO sessions (id, agent, project_path, started_at, mode, active_frond_id) VALUES (?, ?, ?, ?, ?, NULL)",
    ).run(
      session.id,
      session.agent,
      session.projectPath,
      session.startedAt,
      session.mode,
    );

    const stem = await createFrond({
      sessionId: session.id,
      parentId: null,
      name: "stem",
      colorIndex: 0,
      centroid: null,
      status: "active",
    });
    db.query("UPDATE sessions SET active_frond_id = ? WHERE id = ?").run(
      stem.id,
      session.id,
    );

    return session;
  }

  /**
   * The most recently started session already recorded for this exact
   * project path, if any — null if none exists yet. Lets a caller
   * resume an existing session (active frond, fronds, briefs — all
   * already on disk) across a daemon restart instead of unconditionally
   * starting a fresh one, which otherwise silently abandons everything
   * the previous daemon process had open. See docs/decisions.md.
   */
  async function findSessionByProjectPath(
    projectPath: string,
  ): Promise<Session | null> {
    // started_at has only millisecond resolution — two sessions created
    // in the same millisecond (plausible in a fast test, or two rapid
    // daemon restarts) would otherwise tie; rowid breaks the tie by
    // true insertion order.
    const row = db
      .query(
        "SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(projectPath) as SessionRow | null;
    return row ? sessionRowToSession(row) : null;
  }

  async function listDistinctProjectPaths(): Promise<string[]> {
    const rows = db
      .query("SELECT DISTINCT project_path FROM sessions")
      .all() as { project_path: string }[];
    return rows.map((r) => r.project_path);
  }

  async function renameSessionsProjectPath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    db.run("UPDATE sessions SET project_path = ? WHERE project_path = ?", [
      newPath,
      oldPath,
    ]);
  }

  async function createFrond(input: CreateFrondInput): Promise<Frond> {
    const frond: Frond = {
      id: newId(),
      sessionId: input.sessionId,
      parentId: input.parentId,
      name: input.name,
      colorIndex: input.colorIndex,
      status: input.status ?? "active",
      centroid: input.centroid ?? null,
      briefPath: briefPathFor(input.name),
      createdAt: nowIso(),
    };
    db.query(
      `INSERT INTO fronds (id, session_id, parent_id, name, color_index, status, centroid, brief_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      frond.id,
      frond.sessionId,
      frond.parentId,
      frond.name,
      frond.colorIndex,
      frond.status,
      frond.centroid ? JSON.stringify(frond.centroid) : null,
      frond.briefPath,
      frond.createdAt,
    );
    await createBrief(frond.briefPath);
    return frond;
  }

  async function recordLeaflet(input: RecordLeafletInput): Promise<Leaflet> {
    const leaflet: Leaflet = {
      id: newId(),
      sessionId: input.sessionId,
      index: input.index,
      frondId: input.frondId,
      strayFrom: input.strayFrom,
      promptHash: input.promptHash,
      tokenCount: input.tokenCount,
      filesTouched: input.filesTouched,
      createdAt: nowIso(),
    };
    db.query(
      `INSERT INTO leaflets (id, session_id, idx, frond_id, stray_from, prompt_hash, token_count, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      leaflet.id,
      leaflet.sessionId,
      leaflet.index,
      leaflet.frondId,
      leaflet.strayFrom,
      leaflet.promptHash,
      leaflet.tokenCount,
      JSON.stringify(leaflet.filesTouched),
      leaflet.createdAt,
    );
    return leaflet;
  }

  function insertDecisionRow(decision: Decision): void {
    db.query(
      `INSERT INTO decisions
         (id, session_id, leaflet_id, action, target, with_frond, stage, roots_used, signals,
          confidence, tokens_before, tokens_after, cache_read_tokens, cache_write_tokens,
          undone, inverse, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.id,
      decision.sessionId,
      decision.leafletId,
      decision.action,
      decision.target,
      decision.with ?? null,
      String(decision.stage),
      decision.rootsUsed ? JSON.stringify(decision.rootsUsed) : null,
      JSON.stringify(decision.signals),
      decision.confidence,
      decision.tokensBefore,
      decision.tokensAfter,
      decision.cacheReadTokens,
      decision.cacheWriteTokens,
      decision.undone ? 1 : 0,
      JSON.stringify(decision.inverse),
      decision.createdAt,
    );
  }

  function updateCentroid(frondId: string, embedding: number[]): void {
    const row = getFrondRow(frondId);
    const centroid = row.centroid
      ? (JSON.parse(row.centroid) as number[])
      : null;
    // count isn't tracked as its own column — derive it from how many
    // leaflets currently point at this frond, which is already the
    // running tally applyDecision's FrondState.count represents.
    const { count } = db
      .query("SELECT COUNT(*) AS count FROM leaflets WHERE frond_id = ?")
      .get(frondId) as { count: number };
    const next = runningMean(centroid, count, embedding);
    db.query("UPDATE fronds SET centroid = ? WHERE id = ?").run(
      JSON.stringify(next),
      frondId,
    );
  }

  // A decision whose `inverse.kind` doesn't match what its `action` needs
  // must never be persisted — recordDecision's structural switch would
  // silently no-op on the mismatch, leaving the journal/decisions table
  // claiming something happened that the fern never actually did.
  function assertInverseMatchesAction(decision: Decision): void {
    const expectedKind: DecisionInverse["kind"] =
      decision.action === "merge" ? "merge" : "router";
    if (decision.inverse.kind !== expectedKind) {
      throw new Error(
        `Refusing to record decision ${decision.id}: action "${decision.action}" needs inverse.kind "${expectedKind}", got "${decision.inverse.kind}".`,
      );
    }
  }

  async function recordDecision(
    decision: Decision,
    promptEmbedding: number[] | null,
  ): Promise<Decision> {
    assertInverseMatchesAction(decision);

    const applyStructural = db.transaction(() => {
      insertDecisionRow(decision);
      switch (decision.action) {
        case "continue": {
          if (decision.target && promptEmbedding) {
            updateCentroid(decision.target, promptEmbedding);
          }
          break;
        }
        case "new": {
          if (decision.inverse.kind !== "router") break; // narrows the type; asserted above
          const { priorActiveFrondId, createdFrondId } = decision.inverse;
          const stemId = getStemFrondId(db, decision.sessionId);
          if (priorActiveFrondId && priorActiveFrondId !== stemId) {
            setFrondStatus(priorActiveFrondId, "resting");
          }
          if (createdFrondId) {
            setFrondStatus(createdFrondId, "active");
            setActiveFrondSync(decision.sessionId, createdFrondId);
          }
          break;
        }
        case "return":
        case "combine": {
          if (decision.inverse.kind !== "router" || !decision.target) break;
          const stemId = getStemFrondId(db, decision.sessionId);
          const { priorActiveFrondId } = decision.inverse;
          if (priorActiveFrondId && priorActiveFrondId !== stemId) {
            setFrondStatus(priorActiveFrondId, "resting");
          }
          setFrondStatus(decision.target, "active");
          setActiveFrondSync(decision.sessionId, decision.target);
          if (promptEmbedding) updateCentroid(decision.target, promptEmbedding);
          break;
        }
        case "stray":
          break; // never touches a frond or the active pointer — only the leaflet, already set by the caller
        case "merge": {
          if (decision.inverse.kind !== "merge") break;
          setFrondStatus(decision.inverse.frondId, "merged");
          const session = getSessionRow(decision.sessionId);
          if (session.active_frond_id === decision.inverse.frondId) {
            const stemId = getStemFrondId(db, decision.sessionId);
            setActiveFrondSync(decision.sessionId, stemId);
          }
          break;
        }
        default:
          break;
      }
    });
    applyStructural();

    await journal.record(decision);
    return decision;
  }

  async function listFronds(sessionId: string): Promise<Frond[]> {
    const rows = db
      .query(
        "SELECT * FROM fronds WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as FrondRow[];
    return rows.map(rowToFrond);
  }

  function sessionRowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      agent: row.agent,
      projectPath: row.project_path,
      startedAt: row.started_at,
      mode: row.mode as Mode,
    };
  }

  async function getTree(
    sessionId: string,
  ): Promise<{ session: Session; fronds: Frond[] }> {
    const session = sessionRowToSession(getSessionRow(sessionId));
    const fronds = await listFronds(sessionId);
    return { session, fronds };
  }

  // `leaflets.files_touched` is written on every recordLeaflet but was
  // never read back here — every cold-start reload of RouterState was
  // silently zeroing config.weights.fileOverlap's entire contribution.
  // See docs/decisions.md, 2026-10-27.
  function filesTouchedForFrond(frondId: string): string[] {
    const rows = db
      .query("SELECT files_touched FROM leaflets WHERE frond_id = ?")
      .all(frondId) as { files_touched: string }[];
    const paths = new Set<string>();
    for (const row of rows) {
      const touches = JSON.parse(row.files_touched) as FileTouch[];
      for (const touch of touches) paths.add(touch.path);
    }
    return Array.from(paths);
  }

  async function loadRouterState(sessionId: string): Promise<RouterState> {
    const sessionRow = getSessionRow(sessionId);
    const stemId = getStemFrondId(db, sessionId);
    const rows = db
      .query(
        "SELECT * FROM fronds WHERE session_id = ? AND parent_id IS NOT NULL AND status != 'merged'",
      )
      .all(sessionId) as FrondRow[];
    const fronds: RouterState["fronds"] = {};
    for (const row of rows) {
      fronds[row.id] = {
        id: row.id,
        centroid: row.centroid ? (JSON.parse(row.centroid) as number[]) : null,
        count: (
          db
            .query("SELECT COUNT(*) AS count FROM leaflets WHERE frond_id = ?")
            .get(row.id) as {
            count: number;
          }
        ).count,
        files: filesTouchedForFrond(row.id),
        status: row.status as "active" | "resting",
      };
    }
    const stemRow = getFrondRow(stemId);
    return {
      activeFrondId: toRouterActiveFrondId(
        sessionRow.active_frond_id ?? stemId,
        stemId,
      ),
      stemCentroid: stemRow.centroid
        ? (JSON.parse(stemRow.centroid) as number[])
        : null,
      stemFiles: filesTouchedForFrond(stemId),
      fronds,
    };
  }

  async function setMode(sessionId: string, mode: Mode): Promise<void> {
    db.query("UPDATE sessions SET mode = ? WHERE id = ?").run(mode, sessionId);
  }

  async function getMostRecentLeaflet(
    sessionId: string,
  ): Promise<Leaflet | null> {
    const row = db
      .query(
        "SELECT * FROM leaflets WHERE session_id = ? ORDER BY idx DESC LIMIT 1",
      )
      .get(sessionId) as LeafletRow | null;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      index: row.idx,
      frondId: row.frond_id,
      strayFrom: row.stray_from,
      promptHash: row.prompt_hash,
      tokenCount: row.token_count,
      filesTouched: JSON.parse(row.files_touched) as FileTouch[],
      createdAt: row.created_at,
    };
  }

  async function markStray(
    leafletId: string,
    strayFrom: string | null,
  ): Promise<Decision> {
    const leafletRow = db
      .query("SELECT * FROM leaflets WHERE id = ?")
      .get(leafletId) as LeafletRow | null;
    if (!leafletRow) throw new Error(`No such leaflet: ${leafletId}`);

    const priorFrondId = leafletRow.frond_id;
    db.query(
      "UPDATE leaflets SET frond_id = NULL, stray_from = ? WHERE id = ?",
    ).run(strayFrom, leafletId);

    const decision = buildDecision({
      id: newId(),
      createdAt: nowIso(),
      sessionId: leafletRow.session_id,
      leafletId,
      action: "stray",
      target: null,
      stage: "manual",
      signals: ["manual"],
      confidence: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse: {
        kind: "router",
        priorActiveFrondId: priorFrondId,
        priorFrondStatuses: {},
        createdFrondId: null,
      },
    });
    return recordDecision(decision, null);
  }

  async function undoLast(sessionId: string): Promise<Decision> {
    // "continue" is journaled on every plain prompt for accountability but
    // is never itself an undo target — otherwise `fern undo` would almost
    // always just silently undo the last no-op. See docs/decisions.md.
    const row = db
      .query(
        "SELECT * FROM decisions WHERE session_id = ? AND undone = 0 AND action != 'continue' ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId) as DecisionRow | null;
    if (!row) throw new Error(`Nothing to undo for session ${sessionId}`);
    const decision = rowToDecision(row);
    const stemId = getStemFrondId(db, sessionId);

    if (decision.inverse.kind === "router") {
      const { priorActiveFrondId, priorFrondStatuses, createdFrondId } =
        decision.inverse;
      const resolvedPrior = fromRouterActiveFrondId(priorActiveFrondId, stemId);

      // Resolve the brief file (fs, async) before touching any DB row —
      // if this throws, nothing below has mutated yet.
      if (createdFrondId) {
        const createdFrond = getFrondRow(createdFrondId);
        await archiveOrDeleteBrief(
          createdFrond.brief_path,
          createdFrond.name,
          decision.id,
        );
      }

      const applyUndo = db.transaction(() => {
        if (decision.leafletId) {
          db.query(
            "UPDATE leaflets SET frond_id = ?, stray_from = NULL WHERE id = ?",
          ).run(resolvedPrior, decision.leafletId);
        }
        if (createdFrondId) {
          db.query("DELETE FROM fronds WHERE id = ?").run(createdFrondId);
        }
        for (const [frondId, status] of Object.entries(priorFrondStatuses)) {
          if (frondId === createdFrondId) continue; // row just deleted
          setFrondStatus(frondId, status);
        }
        // "stray" never touches the active pointer on the forward path
        // (recordDecision's "stray" case is a pure no-op) — not on undo
        // either. Without this guard, undoing a markStray on a leaflet
        // that isn't the session's current one would wrongly drag the
        // session's active frond back to wherever that old leaflet lived.
        if (decision.action !== "stray") {
          setActiveFrondSync(sessionId, resolvedPrior);
        }
        db.query("UPDATE decisions SET undone = 1 WHERE id = ?").run(
          decision.id,
        );
      });
      applyUndo();
    } else {
      const { frondId, priorStatus, priorActiveFrondId, decisionId } =
        decision.inverse;

      // Strip the brief marker (fs, async) first — if the marker's gone,
      // fail loud before any DB row changes, never a partial undo.
      const stem = getFrondRow(stemId);
      const stripped = await stripMergeBlock(stem.brief_path, decisionId);
      if (!stripped) {
        throw new Error(
          `Can't undo this merge: the stem brief changed since the merge ran (its marker is gone). Undo it by hand in ${stem.brief_path}.`,
        );
      }

      const applyUndo = db.transaction(() => {
        setFrondStatus(frondId, priorStatus);
        setActiveFrondSync(sessionId, priorActiveFrondId);
        db.query("UPDATE decisions SET undone = 1 WHERE id = ?").run(
          decision.id,
        );
      });
      applyUndo();
    }

    const undoneDecision: Decision = { ...decision, undone: true };
    await journal.record(undoneDecision);
    return undoneDecision;
  }

  async function mergeFrond(frondId: string): Promise<Decision> {
    const frond = getFrondRow(frondId);
    if (frond.parent_id === null) {
      throw new Error("Can't merge the stem into itself.");
    }
    const stemId = getStemFrondId(db, frond.session_id);
    const stem = getFrondRow(stemId);

    const brief = await readBrief(frond.brief_path);
    const decisionId = newId();
    await appendMergeBlock(stem.brief_path, decisionId, brief.Decided);

    const session = getSessionRow(frond.session_id);
    const priorActiveFrondId = session.active_frond_id ?? stemId;

    const decision = buildDecision({
      id: decisionId,
      createdAt: nowIso(),
      sessionId: frond.session_id,
      leafletId: null,
      action: "merge",
      target: stemId,
      stage: "manual",
      signals: ["manual"],
      confidence: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse: {
        kind: "merge",
        frondId,
        priorStatus: frond.status as FrondStatus,
        priorActiveFrondId,
        decisionId,
      },
    });
    return recordDecision(decision, null);
  }

  interface LeafletWithDecisionRow {
    idx: number;
    frond_id: string | null;
    frond_name: string | null;
    stray_from_name: string | null;
    token_count: number;
    files_touched: string;
    action: string | null;
    confidence: number | null;
    stage: string | null;
    signals: string | null;
  }

  /**
   * `decisions.confidence` is `NOT NULL` — every manual/forced decision
   * (stage "manual", or a forced-continue's `signals` entry) still
   * stores a real `1` there, never a real router score, so it can't be
   * told apart from a genuine 100%-confidence router decision by value
   * alone. Rather than loosen the schema constraint, the UI-facing
   * projection derives the honest value here: `null` ("no router score"
   * — the List/Inspector show "—"/"forced, no score") for anything
   * that isn't a real stage 0/2 router decision. A decision made
   * with no embedding model (tagged `degraded:no-embedding`) is the same
   * case: its stored number is the complement of a structural 0, not a
   * measurement. See docs/decisions.md.
   */
  function hasRealRouterScore(
    stage: string | null,
    signalsJson: string | null,
  ): boolean {
    if (stage === "manual") return false;
    if (!signalsJson) return true;
    try {
      const signals = JSON.parse(signalsJson) as string[];
      if (signals.includes("forced-continue")) return false;
      if (signals.includes(DEGRADED_SIGNAL)) return false;
    } catch {
      // malformed signals JSON — err on the side of trusting the stored
      // confidence rather than hiding a real one.
    }
    return true;
  }

  async function listLeafletsWithDecisions(
    sessionId: string,
    page: { offset: number; limit: number },
  ): Promise<UiLeafletPage> {
    const { count: total } = db
      .query("SELECT COUNT(*) AS count FROM leaflets WHERE session_id = ?")
      .get(sessionId) as { count: number };

    const rows = db
      .query(
        `SELECT
           l.idx AS idx,
           l.frond_id AS frond_id,
           f.name AS frond_name,
           sf.name AS stray_from_name,
           l.token_count AS token_count,
           l.files_touched AS files_touched,
           d.action AS action,
           d.confidence AS confidence,
           d.stage AS stage,
           d.signals AS signals
         FROM leaflets l
         LEFT JOIN fronds f ON l.frond_id = f.id
         LEFT JOIN fronds sf ON l.stray_from = sf.id
         LEFT JOIN (
           SELECT leaflet_id, action, confidence, stage, signals,
                  ROW_NUMBER() OVER (PARTITION BY leaflet_id ORDER BY seq DESC) AS rn
           FROM decisions
           WHERE leaflet_id IS NOT NULL
         ) d ON d.leaflet_id = l.id AND d.rn = 1
         WHERE l.session_id = ?
         ORDER BY l.idx ASC
         LIMIT ? OFFSET ?`,
      )
      .all(sessionId, page.limit, page.offset) as LeafletWithDecisionRow[];

    // The only place real prompt text exists on disk is a frond's brief
    // Recent section, tagged by turn (see briefs.ts's pushRecentEntry) —
    // read each distinct frond's brief once, not once per leaflet.
    const frondIds = new Set(
      rows.map((r) => r.frond_id).filter((id): id is string => id !== null),
    );
    const previewByTurn = new Map<number, string>();
    for (const frondId of frondIds) {
      const briefPath = getFrondRow(frondId).brief_path;
      const sections = await readBrief(briefPath).catch(() => null);
      if (!sections) continue;
      for (const entry of parseRecentEntries(sections.Recent)) {
        if (entry.turn !== null) previewByTurn.set(entry.turn, entry.text);
      }
    }

    const leaflets: UiLeaflet[] = rows.map((r) => {
      const isStray = r.frond_id === null;
      return {
        turn: r.idx,
        frondName: isStray ? "stray" : (r.frond_name ?? "stem"),
        isStray,
        strayFromFrondName: r.stray_from_name,
        kind: (r.action as DecisionAction | null) ?? null,
        promptPreview: previewByTurn.get(r.idx) ?? null,
        tokenCount: r.token_count,
        confidence:
          r.confidence !== null && hasRealRouterScore(r.stage, r.signals)
            ? r.confidence
            : null,
        filesTouchedCount: (JSON.parse(r.files_touched) as FileTouch[]).length,
      };
    });

    return { leaflets, total };
  }

  async function getSessionStats(sessionId: string): Promise<SessionStats> {
    const fronds = await listFronds(sessionId);
    const frondCount = fronds.filter(
      (f) => f.parentId !== null && f.status !== "merged",
    ).length;
    const { count: strayCount } = db
      .query(
        "SELECT COUNT(*) AS count FROM leaflets WHERE session_id = ? AND frond_id IS NULL",
      )
      .get(sessionId) as { count: number };

    // Every plain continuation already journals a "continue" — counting
    // those in the denominator would make the ratio sit near 0% forever
    // and mean nothing. Only decisions that were an actual routing
    // choice (new/return/combine/stray/merge) count. See docs/decisions.md.
    const { of_count: of, undone_count: undoneCount } = db
      .query(
        `SELECT COUNT(*) AS of_count, COALESCE(SUM(undone), 0) AS undone_count
         FROM decisions WHERE session_id = ? AND action != 'continue'`,
      )
      .get(sessionId) as { of_count: number; undone_count: number };

    const { count: frondOpenings } = db
      .query(
        "SELECT COUNT(*) AS count FROM decisions WHERE session_id = ? AND action = 'new' AND undone = 0",
      )
      .get(sessionId) as { count: number };

    return {
      frondCount,
      strayCount,
      frondOpenings,
      undo: of >= 5 ? { count: undoneCount, of } : null,
    };
  }

  async function heatmapRows(
    sessionId: string,
    maxColumns: number,
  ): Promise<HeatmapResult> {
    const leafletRows = db
      .query(
        "SELECT idx, frond_id FROM leaflets WHERE session_id = ? ORDER BY idx ASC",
      )
      .all(sessionId) as { idx: number; frond_id: string | null }[];

    const totalTurns = leafletRows.length;
    const turnsPerCell = Math.max(1, Math.ceil(totalTurns / maxColumns));
    const columnCount =
      totalTurns === 0 ? 0 : Math.floor((totalTurns - 1) / turnsPerCell) + 1;

    const allFronds = await listFronds(sessionId);
    const stem = allFronds.find((f) => f.parentId === null);
    const topicFronds = allFronds.filter((f) => f.parentId !== null);
    const nameByKey = new Map<string, string>();
    if (stem) nameByKey.set(stem.id, stem.name);
    for (const f of topicFronds) nameByKey.set(f.id, f.name);
    nameByKey.set("stray", "stray");
    const rowOrder = [
      ...(stem ? [stem.id] : []),
      ...topicFronds.map((f) => f.id),
      "stray",
    ];

    // Bucket counts per column, per frond key — "stray" for a null frond_id.
    const buckets: Map<string, number>[] = Array.from(
      { length: columnCount },
      () => new Map(),
    );
    for (const row of leafletRows) {
      const bucketIndex = Math.floor(row.idx / turnsPerCell);
      const key = row.frond_id ?? "stray";
      const bucket = buckets[bucketIndex];
      if (!bucket) continue;
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }

    const rows: HeatmapRow[] = rowOrder.map((key) => {
      const name = nameByKey.get(key) ?? key;
      const cells = buckets.map((bucket) => {
        let bestKey: string | null = null;
        let bestCount = -1;
        for (const [k, c] of bucket) {
          if (c > bestCount) {
            bestCount = c;
            bestKey = k;
          }
        }
        return bestKey === key ? name : null;
      });
      return { frondName: name, cells };
    });

    return { rows, turnsPerCell };
  }

  async function countSessionsForProjectPath(
    projectPath: string,
  ): Promise<number> {
    const { count } = db
      .query("SELECT COUNT(*) AS count FROM sessions WHERE project_path = ?")
      .get(projectPath) as { count: number };
    return count;
  }

  return {
    db,
    createSession,
    findSessionByProjectPath,
    listDistinctProjectPaths,
    renameSessionsProjectPath,
    createFrond,
    recordLeaflet,
    recordDecision,
    listFronds,
    getTree,
    loadRouterState,
    setActiveFrond,
    setMode,
    getMostRecentLeaflet,
    markStray,
    undoLast,
    mergeFrond,
    listLeafletsWithDecisions,
    getSessionStats,
    heatmapRows,
    countSessionsForProjectPath,
    close: () => db.close(),
  };
}
