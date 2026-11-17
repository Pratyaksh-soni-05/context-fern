// GET /tree, GET /status, POST /mode — the smaller endpoints. /tree
// returns structured data; the CLI does the ASCII rendering (TTY/color
// detection is a terminal concern, not the daemon's).

import { relative } from "node:path";
import type { Mode } from "@context-fern/core";
import {
  BRIEF_SECTIONS,
  type BriefSection,
  readBrief,
} from "@context-fern/store";
import {
  truncateBriefForContext,
  truncateBriefsForContext,
} from "./brief-context";
import { degradedReceipt, type EmbedderHealth } from "./embedder";
import type { ProjectState } from "./project-registry";
import { DaemonError } from "./prompt-util";
import { statuslineReceipt, statusReceipt } from "./receipts";

export interface TreeFrond {
  id: string;
  name: string;
  status: "active" | "resting" | "merged";
  colorIndex: number;
  leafletCount: number;
}

export interface TreeResponse {
  stemName: string;
  fronds: TreeFrond[];
  strayCount: number;
}

function countStrays(state: ProjectState): number {
  const row = state.store.db
    .query(
      "SELECT COUNT(*) AS count FROM leaflets WHERE session_id = ? AND frond_id IS NULL",
    )
    .get(state.sessionId) as { count: number };
  return row.count;
}

function countFrondOpenings(state: ProjectState): number {
  const row = state.store.db
    .query(
      "SELECT COUNT(*) AS count FROM decisions WHERE session_id = ? AND action = 'new' AND undone = 0",
    )
    .get(state.sessionId) as { count: number };
  return row.count;
}

function countLeaflets(state: ProjectState): number {
  const row = state.store.db
    .query("SELECT COUNT(*) AS count FROM leaflets WHERE session_id = ?")
    .get(state.sessionId) as { count: number };
  return row.count;
}

export async function handleTree(state: ProjectState): Promise<TreeResponse> {
  const fronds = await state.store.listFronds(state.sessionId);
  const stem = fronds.find((f) => f.parentId === null);
  const topicFronds = fronds.filter((f) => f.parentId !== null);

  const result: TreeFrond[] = topicFronds.map((f) => {
    const row = state.store.db
      .query("SELECT COUNT(*) AS count FROM leaflets WHERE frond_id = ?")
      .get(f.id) as { count: number };
    return {
      id: f.id,
      name: f.name,
      status: f.status,
      colorIndex: f.colorIndex,
      leafletCount: row.count,
    };
  });

  return {
    stemName: stem?.name ?? "stem",
    fronds: result,
    strayCount: countStrays(state),
  };
}

export interface StatusResponse {
  /** Spec §7's exact compact terminal-statusline format — unchanged by leafletCount/mode, since `fern statusline` reads this same field. */
  receipt: string;
  /** `fern status`/`/fern status`'s own, richer receipt — includes leafletCount and mode, so dogfooding can tell whether exchanges are being recorded. */
  statusReceipt: string;
  activeFrondName: string | null;
  frondCount: number;
  strayCount: number;
  leafletCount: number;
  /** Of leafletCount, how many are a frond's opening (`/fern new`) rather than a prompt. */
  frondOpeningCount: number;
  mode: Mode;
  /** The active frond's brief, capped ~8KB (Notes truncated first). Omitted in observe mode — see docs/decisions.md. */
  brief?: string;
  /** On a frond other than the stem: the stem's brief ("" when empty) and its path, sharing the ~8KB budget with `brief`. Omitted when the stem is the active frond, and in observe mode. */
  stemBrief?: string;
  stemBriefPath?: string;
  /** True when the active frond is the stem, so a restore knows whether a second brief is expected. */
  activeIsStem: boolean;
  /** The active frond's brief path, project-relative — unlike `brief`, never mode-gated: a restore/focus note must be able to name where the brief lives even when its sections are still empty. See docs/decisions.md. */
  activeBriefPath: string | null;
  /** The active frond's accumulated touched-file count — not mode-gated, same reasoning as activeBriefPath. */
  activeFileCount: number;
  /** Whether Stage 0 has a usable embedding model. `degraded` means cue phrases and file overlap only. */
  embedder: EmbedderHealth;
}

const EMPTY_SECTIONS = {
  Goal: "",
  Decided: "",
  Open: "",
  Files: "",
  Notes: "",
  Recent: "",
};

export async function handleStatus(
  state: ProjectState,
  markRestored = false,
  health: EmbedderHealth = { state: "ok" },
): Promise<StatusResponse> {
  // SessionStart's own restore call opts into this — a signal
  // independent of whether Claude Code mints a new agentSessionId
  // across a resume/clear/compaction/fork (not confirmed either way);
  // the next /prompt call attaches the restored receipt and clears it.
  // `fern status`/other callers never pass this, so a manual status
  // check never queues a receipt nobody asked for. See docs/decisions.md.
  // Observe mode injects nothing on restore (spec §6), so it queues no
  // "restored" receipt either: that line would claim context that was not sent.
  const fronds = await state.store.listFronds(state.sessionId);
  const topicFronds = fronds.filter(
    (f) => f.parentId !== null && f.status !== "merged",
  );
  const activeId = state.routerState.activeFrondId;
  const activeFrondName = activeId
    ? (state.frondNames.get(activeId) ?? null)
    : null;
  const strayCount = countStrays(state);
  const leafletCount = countLeaflets(state);
  const frondOpeningCount = countFrondOpenings(state);

  const { session } = await state.store.getTree(state.sessionId);
  if (markRestored && session.mode !== "observe") {
    state.pendingRestoreReceipt = true;
  }

  // Token accounting (isolate-mode payload sizing) isn't built yet —
  // report 0/0 rather than inventing numbers. See docs/decisions.md.
  const receipt = statuslineReceipt(
    activeFrondName ?? "stem",
    topicFronds.length,
    strayCount,
    0,
    0,
  );
  const statusReceiptText = statusReceipt(
    activeFrondName ?? "stem",
    topicFronds.length,
    strayCount,
    leafletCount,
    session.mode,
    frondOpeningCount,
  );

  const activeFrondId = activeId ?? state.stemFrondId;
  const activeFrond = fronds.find((f) => f.id === activeFrondId);
  const activeBriefPath = activeFrond
    ? relative(state.projectPath, activeFrond.briefPath).replace(/\\/g, "/")
    : null;
  const activeFileCount = (
    state.routerState.fronds[activeFrondId]?.files ??
    state.routerState.stemFiles
  ).length;

  // Restore needs the stem too (spec §8: stem first, then the active
  // frond): the real work is often on the stem while the active frond is
  // new and empty. Both share one ~8KB budget; an empty brief is "".
  let brief: string | undefined;
  let stemBrief: string | undefined;
  let stemBriefPath: string | undefined;
  if (session.mode !== "observe" && activeFrond) {
    const activeSections = await readBrief(activeFrond.briefPath).catch(
      () => EMPTY_SECTIONS,
    );
    const stemFrond = fronds.find((f) => f.id === state.stemFrondId);
    if (activeSections && stemFrond && stemFrond.id !== activeFrond.id) {
      const stemSections = await readBrief(stemFrond.briefPath).catch(
        () => EMPTY_SECTIONS,
      );
      if (stemSections) {
        const fitted = truncateBriefsForContext(stemSections, activeSections);
        brief = fitted.active;
        stemBrief = fitted.stem;
        stemBriefPath = relative(
          state.projectPath,
          stemFrond.briefPath,
        ).replace(/\\/g, "/");
      }
    }
    if (brief === undefined && activeSections) {
      brief = truncateBriefForContext(activeSections);
    }
  }

  return {
    receipt,
    statusReceipt:
      health.state === "degraded"
        ? `${statusReceiptText}
${degradedReceipt(health.reason)}`
        : statusReceiptText,
    embedder: health,
    activeFrondName,
    frondCount: topicFronds.length,
    strayCount,
    leafletCount,
    frondOpeningCount,
    mode: session.mode,
    activeBriefPath,
    activeFileCount,
    activeIsStem: activeFrondId === state.stemFrondId,
    ...(brief !== undefined ? { brief } : {}),
    ...(stemBrief !== undefined && stemBriefPath !== undefined
      ? { stemBrief, stemBriefPath }
      : {}),
  };
}

export async function handleMode(
  state: ProjectState,
  mode: Mode,
): Promise<void> {
  await state.store.setMode(state.sessionId, mode);
  state.mode = mode;
}

export interface FrondBriefResponse {
  name: string;
  goal: string;
  decided: string;
  open: string;
  files: string;
  notes: string;
}

/** GET /frond/:name/brief — the real brief text, for an explicit targeted recall (the MCP frond_recall tool). Mode-gated like /prompt's focusNote and /status's brief: this tool is exposed to the model (not just the user), and spec §6 says observe mode changes no model input — unlike a CLI command, the model can call an MCP tool on its own. */
export async function handleFrondBrief(
  state: ProjectState,
  frondName: string,
): Promise<FrondBriefResponse> {
  if (state.mode === "observe") {
    throw new DaemonError(
      "Frond briefs aren't exposed to the model in observe mode — switch to suggest or isolate mode first.",
    );
  }

  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === frondName);
  if (!frond) throw new DaemonError(`No frond named "${frondName}".`);

  const sections = await readBrief(frond.briefPath);
  return {
    name: frond.name,
    goal: sections.Goal,
    decided: sections.Decided,
    open: sections.Open,
    files: sections.Files,
    notes: sections.Notes,
  };
}

export interface SearchResult {
  name: string;
  section: BriefSection;
  snippet: string;
}

const SNIPPET_CONTEXT_CHARS = 40;

/** GET /search?q= — a plain case-insensitive substring match over every frond's brief text (real markdown the user wrote/reviewed, not hashed leaflet content — see the no-raw-content rule in CLAUDE.md). Mode-gated for the same reason as handleFrondBrief: the model can call this MCP tool on its own, and observe mode must change no model input. */
export async function handleSearch(
  state: ProjectState,
  query: string,
): Promise<{ results: SearchResult[] }> {
  if (state.mode === "observe") {
    throw new DaemonError(
      "Frond search isn't exposed to the model in observe mode — switch to suggest or isolate mode first.",
    );
  }

  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [] };

  const fronds = await state.store.listFronds(state.sessionId);
  const results: SearchResult[] = [];

  for (const frond of fronds) {
    const sections = await readBrief(frond.briefPath).catch(() => null);
    if (!sections) continue;
    for (const section of BRIEF_SECTIONS) {
      const text = sections[section];
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS);
      const end = Math.min(
        text.length,
        idx + needle.length + SNIPPET_CONTEXT_CHARS,
      );
      results.push({
        name: frond.name,
        section,
        snippet: text.slice(start, end),
      });
    }
  }
  return { results };
}

/** GET /fronds — the same frond list /tree renders as ASCII, for callers (the MCP frond_list tool) that just want the data. */
export async function handleFronds(
  state: ProjectState,
): Promise<{ fronds: TreeFrond[] }> {
  const { fronds } = await handleTree(state);
  return { fronds };
}

/** GET /leaflets — fern ui's List view, one row per leaflet, windowed. */
export function handleLeaflets(
  state: ProjectState,
  page: { offset: number; limit: number },
) {
  return state.store.listLeafletsWithDecisions(state.sessionId, page);
}

/** GET /stats — fern ui's four stat tiles. `rootsUsed` and `ctxKeptOut` are fixed literals, not queries: `roots` is schema-only and unwritten (spec §15 — writing to roots is out of scope for launch) and isolate-mode token accounting isn't built yet. Composed here, not in the store, since they're daemon-level presentation facts, not derived data. */
export async function handleStats(state: ProjectState) {
  const stats = await state.store.getSessionStats(state.sessionId);
  return { ...stats, rootsUsed: 0 as const, ctxKeptOut: "n/a" as const };
}

const HEATMAP_MAX_COLUMNS = 60;

/** GET /heatmap — fern ui's Categories view topic-switching heat map, aggregated so a long session doesn't produce one column per turn. */
export function handleHeatmap(state: ProjectState) {
  return state.store.heatmapRows(state.sessionId, HEATMAP_MAX_COLUMNS);
}
