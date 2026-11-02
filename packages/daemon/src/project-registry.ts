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

export interface PendingExchange {
  promptHash: string;
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
  /** Serializes every request for this project — see withProjectLock. */
  lock: Promise<unknown>;
}

const registry = new Map<string, Promise<ProjectState>>();

async function openProject(projectPath: string): Promise<ProjectState> {
  const fernDir = join(projectPath, CONFIG_DIR);
  const store = await openFernStore(fernDir);
  const config = await loadFernConfig(join(fernDir, "config.toml")).catch(() =>
    mergeConfig(),
  );
  const session = await store.createSession({
    agent: `${CLI_NAME}-daemon`,
    projectPath,
    mode: "suggest",
  });
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

export function getOrOpenProject(projectPath: string): Promise<ProjectState> {
  let entry = registry.get(projectPath);
  if (!entry) {
    entry = openProject(projectPath);
    // A transient failure (locked file, disk hiccup) must not poison this
    // projectPath for the rest of the daemon's process lifetime — drop
    // the rejected promise so the next request gets a fresh attempt.
    // Guarded on identity so this can't delete a newer, already-replaced
    // (possibly successful) entry for the same path.
    const failedEntry = entry;
    failedEntry.catch(() => {
      if (registry.get(projectPath) === failedEntry)
        registry.delete(projectPath);
    });
    registry.set(projectPath, entry);
  }
  return entry;
}

/** Test-only: forget a project so a fresh openProject() runs next time. */
export async function forgetProject(projectPath: string): Promise<void> {
  const entry = registry.get(projectPath);
  registry.delete(projectPath);
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
