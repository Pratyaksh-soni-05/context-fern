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
import { truncateBriefForContext } from "./brief-context";
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
  mode: Mode;
  /** The active frond's brief, capped ~8KB (Notes truncated first). Omitted in observe mode — see docs/decisions.md. */
  brief?: string;
  /** The active frond's brief path, project-relative — unlike `brief`, never mode-gated: a restore/focus note must be able to name where the brief lives even when its sections are still empty. See docs/decisions.md. */
  activeBriefPath: string | null;
  /** The active frond's accumulated touched-file count — not mode-gated, same reasoning as activeBriefPath. */
  activeFileCount: number;
}

export async function handleStatus(
  state: ProjectState,
): Promise<StatusResponse> {
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

  const { session } = await state.store.getTree(state.sessionId);

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

  let brief: string | undefined;
  if (session.mode !== "observe" && activeFrond) {
    const sections = await readBrief(activeFrond.briefPath).catch(() => null);
    if (sections) brief = truncateBriefForContext(sections);
  }

  return {
    receipt,
    statusReceipt: statusReceiptText,
    activeFrondName,
    frondCount: topicFronds.length,
    strayCount,
    leafletCount,
    mode: session.mode,
    activeBriefPath,
    activeFileCount,
    ...(brief !== undefined ? { brief } : {}),
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
