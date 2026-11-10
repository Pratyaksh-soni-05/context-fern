// One daemon per machine, many projects. Keyed by absolute projectPath.
// The in-flight-open Promise (not the resolved value) is cached on first
// miss, so two near-simultaneous requests for a brand-new project can't
// double-open its SQLite file. RouterState is cached in memory for the
// daemon's process lifetime — reloaded from SQLite only at open time —
// both for /prompt's latency budget and because every mutating call
// refreshes it in place afterward (see docs/decisions.md on why this
// means a daemon restart starts a fresh session, not a resumed one).

import { join } from "node:path";
import {
  CLI_NAME,
  CONFIG_DIR,
  type FileTouch,
  type Mode,
  mergeConfig,
  type RouterAction,
  type RouterConfig,
  type RouterState,
} from "@context-fern/core";
import {
  type FernStore,
  loadFernConfig,
  openFernStore,
} from "@context-fern/store";
import { canonicalizeProjectPath } from "./client";

export interface PendingExchange {
  promptHash: string;
  /** In-memory only — never persisted to fern.db (only promptHash is). The one place this reaches disk at all is a brief .md file's Goal section, which is explicitly local/gitignored/user-editable. See docs/decisions.md. */
  promptText: string;
  tokenCount: number;
  promptEmbedding: number[];
  filesTouched: FileTouch[];
  startedAt: string;
}

export interface PendingSuggestion {
  action: RouterAction;
  confidence: number;
  signals: string[];
  target: string | null;
  proposedName?: string;
}

export interface ProjectState {
  projectPath: string;
  store: FernStore;
  sessionId: string;
  stemFrondId: string;
  /** frond id -> name, including the stem; kept in sync by every handler that creates/removes a frond. */
  frondNames: Map<string, string>;
  config: RouterConfig;
  routerState: RouterState;
  pendingExchange: PendingExchange | null;
  pendingSuggestion: PendingSuggestion | null;
  /** Mirrors the session row's mode — kept here too so /prompt's hot path never needs an extra query; handleMode (handlers.ts) updates both. */
  mode: Mode;
  /** The Claude Code hook session_id last seen for this project, if any. Bookkeeping only — the fern session itself already outlives /clear and compaction; this just stops the field from going stale. */
  lastAgentSessionId: string | null;
  /** Set by SessionStart's own restore call (via /status's `restored` flag), cleared by the next /prompt, which attaches the restored receipt then — a signal independent of whether Claude Code happens to mint a new agentSessionId across a resume/clear/compaction/fork, which isn't confirmed either way. See docs/decisions.md. */
  pendingRestoreReceipt: boolean;
  /** Serializes every request for this project — see withProjectLock. */
  lock: Promise<unknown>;
}

const registry = new Map<string, Promise<ProjectState>>();

/**
 * `canonicalizeProjectPath` already normalizes case via the real
 * on-disk casing `realpathSync.native` returns — this is a backstop
 * for its one fallback case (the path doesn't exist yet, so native
 * resolution fails and whatever casing the caller passed in survives
 * unchanged): the in-memory registry Map still needs one canonical key
 * regardless, since plain Map key equality can't be case-insensitive
 * on its own. `projectPath` itself (stored in ProjectState, passed to
 * the store) keeps its real casing — only this Map-key derivation
 * folds it.
 */
function registryKey(projectPath: string): string {
  return process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
}

/**
 * Looks for any historical session row stored under a different
 * spelling of this same real project path — a Windows 8.3 short name,
 * a case difference, or a trailing slash, all of which canonicalize to
 * the same real directory but didn't exact-match in SQL before this
 * function existed. Renames every match onto `projectPath` (already
 * canonical) so the project's full history becomes reachable from one
 * spelling, merged rather than lost. A no-op, cheap scan once there's
 * nothing left to migrate (every row is already canonical going
 * forward, since createSession below always receives a canonical path).
 */
async function migrateHistoricalProjectPaths(
  store: FernStore,
  projectPath: string,
): Promise<void> {
  const distinctPaths = await store.listDistinctProjectPaths();
  for (const old of distinctPaths) {
    if (old !== projectPath && canonicalizeProjectPath(old) === projectPath) {
      await store.renameSessionsProjectPath(old, projectPath);
    }
  }
}

async function openProject(projectPath: string): Promise<ProjectState> {
  const fernDir = join(projectPath, CONFIG_DIR);
  const store = await openFernStore(fernDir);
  const config = await loadFernConfig(join(fernDir, "config.toml")).catch(() =>
    mergeConfig(),
  );
  // Resume the most recent existing session for this exact path, if
  // one's already on disk, rather than unconditionally starting a
  // fresh one — this is the one thing that makes a daemon restart (a
  // crash, a version-check self-heal, a machine reboot) not silently
  // abandon whatever frond was active, found and fixed during
  // dogfooding: every getOrOpenProject cache-miss used to insert a
  // brand-new session with a brand-new empty stem, even when a real,
  // populated session for this exact path already existed. See
  // docs/decisions.md.
  let found = await store.findSessionByProjectPath(projectPath);
  if (!found) {
    // Before concluding there's truly no prior session: a differently-
    // spelled historical row for this same real path may exist (see
    // docs/decisions.md's path-canonicalization entry) — migrate it
    // onto the canonical spelling and look again.
    await migrateHistoricalProjectPaths(store, projectPath);
    found = await store.findSessionByProjectPath(projectPath);
  }
  const session =
    found ??
    (await store.createSession({
      agent: `${CLI_NAME}-daemon`,
      projectPath,
      mode: "suggest",
    }));
  const routerState = await store.loadRouterState(session.id);
  const { fronds } = await store.getTree(session.id);
  const stem = fronds.find((f) => f.parentId === null);
  if (!stem)
    throw new Error(`Corrupted store: no stem frond for ${projectPath}`);
  const frondNames = new Map(fronds.map((f) => [f.id, f.name]));
  return {
    projectPath,
    store,
    sessionId: session.id,
    stemFrondId: stem.id,
    frondNames,
    config,
    routerState,
    pendingExchange: null,
    pendingSuggestion: null,
    mode: session.mode,
    lastAgentSessionId: null,
    pendingRestoreReceipt: false,
    lock: Promise.resolve(),
  };
}

/** Records the hook's session_id for bookkeeping. Silently ignores a missing/empty value — most requests (CLI, tests) carry none. */
export function updateAgentSessionId(
  state: ProjectState,
  agentSessionId: string | null | undefined,
): void {
  if (typeof agentSessionId === "string" && agentSessionId.length > 0) {
    state.lastAgentSessionId = agentSessionId;
  }
}

/** Re-reads the frond id->name map after anything that creates or deletes a frond (undo of a "new"). */
export async function refreshFrondNames(state: ProjectState): Promise<void> {
  const { fronds } = await state.store.getTree(state.sessionId);
  state.frondNames = new Map(fronds.map((f) => [f.id, f.name]));
}

/**
 * Canonicalizes `rawProjectPath` once here, at the one chokepoint every
 * caller (CLI, hooks, and every `fern ui` browser request) ultimately
 * goes through — a short/long Windows path, mixed case, or a trailing
 * slash for the same real directory now all resolve to the same
 * registry entry and the same store session, instead of each minting
 * its own empty one. See docs/decisions.md.
 */
export function getOrOpenProject(
  rawProjectPath: string,
): Promise<ProjectState> {
  const projectPath = canonicalizeProjectPath(rawProjectPath);
  const key = registryKey(projectPath);
  let entry = registry.get(key);
  if (!entry) {
    entry = openProject(projectPath);
    // A transient failure (locked file, disk hiccup) must not poison this
    // projectPath for the rest of the daemon's process lifetime — drop
    // the rejected promise so the next request gets a fresh attempt.
    // Guarded on identity so this can't delete a newer, already-replaced
    // (possibly successful) entry for the same path.
    const failedEntry = entry;
    failedEntry.catch(() => {
      if (registry.get(key) === failedEntry) registry.delete(key);
    });
    registry.set(key, entry);
  }
  return entry;
}

/** Test-only: forget a project so a fresh openProject() runs next time. */
export async function forgetProject(rawProjectPath: string): Promise<void> {
  const key = registryKey(canonicalizeProjectPath(rawProjectPath));
  const entry = registry.get(key);
  registry.delete(key);
  if (entry) (await entry).store.close();
}

/** Closes every open project's SQLite connection before clearing the cache — otherwise the file handle outlives the process that opened it (a real problem for tests that then try to remove the temp dir). */
export async function closeAllProjects(): Promise<void> {
  for (const entry of registry.values()) {
    const state = await entry;
    state.store.close();
  }
  registry.clear();
}

/**
 * Serializes every operation on one project's state — a slow /prompt and
 * a /status for the same project can't interleave and lose an update.
 * `fn` receives the live state and may mutate `pendingExchange`/
 * `pendingSuggestion`/`routerState` in place; the caller is responsible
 * for refreshing `routerState` from the store after any mutation.
 */
export async function withProjectLock<T>(
  state: ProjectState,
  fn: (state: ProjectState) => Promise<T>,
): Promise<T> {
  const previous = state.lock;
  let release: (value?: unknown) => void = () => {};
  state.lock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn(state);
  } finally {
    release();
  }
}
