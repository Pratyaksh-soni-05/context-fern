// Spec §11's App screen: icon rail, header (view switch + mode pill),
// main panel, inspector, four stat tiles, Fern/List/Categories views.

import { PRODUCT_NAME } from "@context-fern/core";
import { useCallback, useEffect, useState } from "react";
import {
  getFronds,
  getLeaflets,
  getStats,
  getStatus,
  postMode,
  postUndo,
} from "../api/client";
import type { Mode, TreeFrond, UiLeaflet, UiStats } from "../api/types";
import { IconRail, type View } from "../components/IconRail";
import { Inspector } from "../components/Inspector";
import { ModePill } from "../components/ModePill";
import { StatTile } from "../components/StatTile";
import { DEFAULT_DAEMON_PORT } from "../constants";
import type { Selection } from "../design/selection";
import { CategoriesView } from "./views/CategoriesView";
import { FernView } from "./views/FernView";
import { ListView } from "./views/ListView";
import "./AppShell.css";

export interface AppShellProps {
  projectPath: string;
  projectName: string;
}

const VIEW_LABELS: Record<View, string> = {
  fern: "Fern",
  list: "List",
  categories: "Categories",
};

// The wordmark italicizes the second word only — split from PRODUCT_NAME
// rather than hard-coded, so the one place the brand name lives stays
// packages/core/src/brand.ts (see CLAUDE.md).
const [WORDMARK_FIRST, WORDMARK_SECOND] = PRODUCT_NAME.split(" ");

// A single page, not yet paginated in the graph — see docs/decisions.md
// on the ~2000 SVG element budget; this cap (500 leaflets x ~2 elements
// each, plus a small, fixed per-frond overhead) stays comfortably under
// it. The List view (commit 4) is the complete, windowed source of
// truth for sessions longer than this.
const GRAPH_LEAFLET_CAP = 500;

export function AppShell({ projectPath, projectName }: AppShellProps) {
  const [view, setView] = useState<View>("fern");
  const [fronds, setFronds] = useState<TreeFrond[]>([]);
  const [leaflets, setLeaflets] = useState<UiLeaflet[]>([]);
  const [leafletsTotal, setLeafletsTotal] = useState(0);
  const [stats, setStats] = useState<UiStats | null>(null);
  const [mode, setMode] = useState<Mode>("suggest");
  const [selection, setSelection] = useState<Selection>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [frondsRes, firstPage, statsRes, statusRes] = await Promise.all([
        getFronds(projectPath),
        getLeaflets(projectPath, 0, GRAPH_LEAFLET_CAP),
        getStats(projectPath),
        getStatus(projectPath),
      ]);

      // The graph shows the most RECENT leaflets, not the oldest —
      // offset 0 only gives the oldest page, so a second fetch at the
      // tail-end offset is needed once a session exceeds the cap.
      const leafletsRes =
        firstPage.total > GRAPH_LEAFLET_CAP
          ? await getLeaflets(
              projectPath,
              firstPage.total - GRAPH_LEAFLET_CAP,
              GRAPH_LEAFLET_CAP,
            )
          : firstPage;

      setFronds(frondsRes.fronds);
      setLeaflets(leafletsRes.leaflets);
      setLeafletsTotal(leafletsRes.total);
      setStats(statsRes);
      setMode(statusRes.mode);
      setError(null);
    } catch {
      setError("Couldn't load this project's data.");
    }
  }, [projectPath]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleModeChange(next: Mode): Promise<void> {
    setMode(next); // optimistic — matches the pill's instant-feedback intent
    try {
      await postMode(projectPath, next);
    } catch {
      reload(); // revert to the real server state on failure
    }
  }

  async function handleUndo(): Promise<void> {
    setUndoBusy(true);
    try {
      await postUndo(projectPath);
      reload();
    } finally {
      setUndoBusy(false);
    }
  }

  const mergedCount = fronds.filter((f) => f.status === "merged").length;
  const activeFrondCount = fronds.filter((f) => f.status !== "merged").length;

  return (
    <div className="app-shell">
      <IconRail view={view} onChangeView={setView} />
      <div className="app-shell__main">
        <header className="app-shell__header">
          <div className="app-shell__wordmark-group">
            <span className="app-shell__wordmark">
              {WORDMARK_FIRST} <em>{WORDMARK_SECOND}</em>
            </span>
            <span className="app-shell__path">{projectName}</span>
          </div>
          <div
            role="tablist"
            aria-label="View"
            className="app-shell__view-switch"
          >
            {(["fern", "list", "categories"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className="app-shell__view-tab"
                data-active={view === v}
                onClick={() => setView(v)}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
          <div className="app-shell__header-right">
            <ModePill mode={mode} onChange={handleModeChange} />
            <span className="app-shell__localhost">
              localhost:{window.location.port || DEFAULT_DAEMON_PORT}
            </span>
          </div>
        </header>

        {error && (
          <p role="alert" className="app-shell__error">
            {error}
          </p>
        )}

        <div className="app-shell__body">
          {view === "fern" && (
            <FernView
              fronds={fronds}
              leaflets={leaflets}
              selection={selection}
              onSelect={setSelection}
            />
          )}
          {view === "list" && (
            <ListView
              projectPath={projectPath}
              fronds={fronds}
              selection={selection}
              onSelect={setSelection}
            />
          )}
          {view === "categories" && (
            <CategoriesView
              projectPath={projectPath}
              fronds={fronds}
              leaflets={leaflets}
              strayCount={stats?.strayCount ?? 0}
              rootsUsed={stats?.rootsUsed ?? 0}
              selection={selection}
              onSelect={setSelection}
            />
          )}
          <Inspector
            projectPath={projectPath}
            fronds={fronds}
            leaflets={leaflets}
            strayCount={stats?.strayCount ?? 0}
            rootsUsed={stats?.rootsUsed ?? 0}
            selection={selection}
            onSelect={setSelection}
            onUndo={handleUndo}
            undoBusy={undoBusy}
          />
        </div>

        <div className="app-shell__stats">
          <StatTile
            label="kept out of this turn"
            note="isolate"
            value="n/a"
            color="var(--text-2)"
            filledFraction={0}
          />
          <StatTile
            label="fronds"
            note={`${mergedCount} merged`}
            value={String(activeFrondCount)}
            color="var(--ink)"
            // The value shown is real; the bar's 0..1 scale (/8) is a
            // fixed, undocumented-elsewhere display cap for a "typical"
            // session's frond count, not a real maximum — StatTile
            // itself clamps past 1, so a bigger session just shows a
            // full bar rather than overflowing.
            filledFraction={activeFrondCount / 8}
          />
          <StatTile
            label="strays caught"
            note="off-topic"
            value={String(stats?.strayCount ?? 0)}
            color="var(--stray-ink)"
            // Same fixed display-scale caveat as the fronds tile above (/10 here).
            filledFraction={(stats?.strayCount ?? 0) / 10}
          />
          <StatTile
            label="undo rate"
            note="routing"
            value={
              stats?.undo ? `${stats.undo.count} of ${stats.undo.of}` : "n/a"
            }
            color="var(--text-2)"
            filledFraction={stats?.undo ? stats.undo.count / stats.undo.of : 0}
          />
        </div>
        {leafletsTotal > GRAPH_LEAFLET_CAP && (
          <p className="app-shell__truncation-note">
            Showing the most recent {GRAPH_LEAFLET_CAP} of {leafletsTotal}{" "}
            leaflets in the Fern view — see List for the complete history.
          </p>
        )}
      </div>
    </div>
  );
}
