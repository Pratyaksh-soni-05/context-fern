// Response shapes mirrored from packages/daemon/src/handlers.ts and
// packages/daemon/src/project-registry-file.ts — kept as plain types
// here (not imported directly) since packages/ui must never depend on
// packages/daemon at the bundler/runtime level; it only talks to it
// over HTTP (CLAUDE.md: "ui talks to the daemon over its localhost
// HTTP API only").

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  sessionCount: number;
}

export interface TreeFrond {
  id: string;
  name: string;
  status: "active" | "resting" | "merged";
  colorIndex: number;
  leafletCount: number;
}

export type DecisionAction =
  | "continue"
  | "new"
  | "return"
  | "combine"
  | "stray"
  | "merge";

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

export interface UiStats {
  frondCount: number;
  strayCount: number;
  frondOpenings: number;
  rootsUsed: number;
  undo: { count: number; of: number } | null;
  ctxKeptOut: "n/a";
}

export interface HeatmapRow {
  frondName: string;
  cells: (string | null)[];
}

export interface HeatmapResponse {
  rows: HeatmapRow[];
  turnsPerCell: number;
}

export type Mode = "observe" | "suggest" | "isolate";

export interface StatusResponse {
  activeFrondName: string | null;
  frondCount: number;
  strayCount: number;
  leafletCount: number;
  mode: Mode;
}

export interface FrondBriefResponse {
  name: string;
  goal: string;
  decided: string;
  open: string;
  files: string;
  notes: string;
}
