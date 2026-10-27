// GET /tree, GET /status, POST /mode — the smaller endpoints. /tree
// returns structured data; the CLI does the ASCII rendering (TTY/color
// detection is a terminal concern, not the daemon's).

import type { Mode } from "@context-fern/core";
import type { ProjectState } from "./project-registry";
import { statuslineReceipt } from "./receipts";

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
  receipt: string;
  activeFrondName: string | null;
  frondCount: number;
  strayCount: number;
  mode: Mode;
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

  return {
    receipt,
    activeFrondName,
    frondCount: topicFronds.length,
    strayCount,
    mode: session.mode,
  };
}

export async function handleMode(
  state: ProjectState,
  mode: Mode,
): Promise<void> {
  await state.store.setMode(state.sessionId, mode);
}
