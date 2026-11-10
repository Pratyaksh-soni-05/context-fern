// Spec §11's Categories view: "one card per frond, a strays card, a
// roots card, and a topic-switching heat map." The roots card is
// genuinely empty — nothing writes a Root row yet (spec §15 lists
// writing to roots as out of scope for launch) — so its count and
// cells are real zeros, not a placeholder. See docs/decisions.md.

import { pluralize } from "@context-fern/core";
import { useEffect, useState } from "react";
import { getFrondBrief, getHeatmap } from "../../api/client";
import type {
  FrondBriefResponse,
  HeatmapResponse,
  TreeFrond,
  UiLeaflet,
} from "../../api/types";
import {
  frondColorVar,
  frondInkVar,
  ROOT_COLOR_VAR,
  STEM_COLOR_VAR,
  STRAY_COLOR_VAR,
  STRAY_INK_VAR,
} from "../../design/frond-colors";
import type { Selection } from "../../design/selection";
import "./CategoriesView.css";

export interface CategoriesViewProps {
  projectPath: string;
  fronds: TreeFrond[];
  leaflets: UiLeaflet[];
  strayCount: number;
  rootsUsed: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

function isOn(selection: Selection, candidate: Selection): boolean {
  if (!selection) return false;
  if (selection.kind !== candidate?.kind) return false;
  if (selection.kind === "frond" && candidate?.kind === "frond") {
    return selection.id === candidate.id;
  }
  return true;
}

function rowColor(frondName: string, fronds: TreeFrond[]): string {
  if (frondName === "stem") return STEM_COLOR_VAR;
  if (frondName === "stray") return STRAY_COLOR_VAR;
  const frond = fronds.find((f) => f.name === frondName);
  return frond ? frondColorVar(frond.colorIndex) : "var(--off)";
}

function CellBar({
  cells,
  color,
}: {
  cells: (string | null)[];
  color: string;
}) {
  return (
    <span className="categories-view__card-cells">
      {cells.map((cell, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, purely decorative scale bar — position is the only identity these cells have.
          key={i}
          style={{ background: cell !== null ? color : "var(--off)" }}
        />
      ))}
    </span>
  );
}

export function CategoriesView({
  projectPath,
  fronds,
  leaflets,
  strayCount,
  rootsUsed,
  selection,
  onSelect,
}: CategoriesViewProps) {
  const [briefs, setBriefs] = useState<Map<string, FrondBriefResponse>>(
    new Map(),
  );
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHeatmap(projectPath)
      .then((res) => {
        if (!cancelled) setHeatmap(res);
      })
      .catch(() => {
        if (!cancelled) setHeatmap(null);
      });
    Promise.all(
      fronds.map((f) =>
        getFrondBrief(projectPath, f.name).then((b) => [f.name, b] as const),
      ),
    )
      .then((pairs) => {
        if (!cancelled) setBriefs(new Map(pairs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPath, fronds]);

  const cellsFor = (name: string): (string | null)[] =>
    heatmap?.rows.find((r) => r.frondName === name)?.cells ?? [];

  const strayEntries = leaflets.filter((l) => l.isStray);
  // `leaflets` is AppShell's graph-capped window (GRAPH_LEAFLET_CAP), not
  // every leaflet this session has ever had — `strayCount` (from /stats)
  // is the real, uncapped total, so a long session can genuinely have
  // more strays than are enumerable here. Show that honestly rather
  // than silently listing fewer than the header count claims.
  const missingStrayCount = Math.max(0, strayCount - strayEntries.length);
  const rootCells: (string | null)[] = Array.from({ length: 20 }, () => null);

  return (
    <section className="categories-view" aria-label="Topics in this fern">
      <div className="categories-view__grid">
        {fronds.map((frond) => {
          const brief = briefs.get(frond.name);
          const strayFromThis = leaflets.filter(
            (l) => l.isStray && l.strayFromFrondName === frond.name,
          ).length;
          const candidate: Selection = { kind: "frond", id: frond.id };
          return (
            <button
              type="button"
              key={frond.id}
              className="categories-view__card"
              data-on={isOn(selection, candidate)}
              style={{ borderTopColor: frondColorVar(frond.colorIndex) }}
              onClick={() =>
                onSelect(isOn(selection, candidate) ? null : candidate)
              }
            >
              <span className="categories-view__card-head">
                <span style={{ color: frondInkVar(frond.colorIndex) }}>
                  {frond.name}
                </span>
                <span className="categories-view__card-count">
                  {pluralize(frond.leafletCount, "leaflet")}
                  {strayFromThis > 0
                    ? ` · ${pluralize(strayFromThis, "stray")}`
                    : ""}
                  {frond.status === "merged" ? " · merged" : ""}
                </span>
              </span>
              <span className="categories-view__card-headline">
                {brief?.goal || "(no goal recorded yet)"}
              </span>
              <span className="categories-view__card-sub">
                Decided: {brief?.decided || "n/a"}
              </span>
              <CellBar
                cells={cellsFor(frond.name)}
                color={frondColorVar(frond.colorIndex)}
              />
            </button>
          );
        })}
        <button
          type="button"
          className="categories-view__card categories-view__card--dashed"
          data-on={isOn(selection, { kind: "strays" })}
          style={{ borderTopColor: STRAY_COLOR_VAR }}
          onClick={() =>
            onSelect(
              isOn(selection, { kind: "strays" }) ? null : { kind: "strays" },
            )
          }
        >
          <span className="categories-view__card-head">
            <span style={{ color: STRAY_INK_VAR }}>strays</span>
            <span className="categories-view__card-count">
              {strayCount} caught
            </span>
          </span>
          <span className="categories-view__card-headline">
            Off-topic questions, kept off every frond
          </span>
          {strayEntries.length > 0 ? (
            <ul className="categories-view__stray-list">
              {strayEntries.map((s) => (
                <li key={s.turn}>
                  <span className="categories-view__stray-turn">
                    turn {s.turn}
                  </span>
                  {" · from "}
                  {s.strayFromFrondName ?? "stem"}
                  {" · "}
                  {s.promptPreview ?? "text not kept"}
                </li>
              ))}
            </ul>
          ) : (
            <span className="categories-view__card-sub">None yet.</span>
          )}
          {missingStrayCount > 0 && (
            <span className="categories-view__card-sub">
              +{missingStrayCount} more not shown here — see List for the
              complete history.
            </span>
          )}
          <CellBar cells={cellsFor("stray")} color={STRAY_COLOR_VAR} />
        </button>
        <button
          type="button"
          className="categories-view__card categories-view__card--dotted"
          data-on={isOn(selection, { kind: "roots" })}
          style={{ borderTopColor: ROOT_COLOR_VAR }}
          onClick={() =>
            onSelect(
              isOn(selection, { kind: "roots" }) ? null : { kind: "roots" },
            )
          }
        >
          <span className="categories-view__card-head">
            <span style={{ color: "var(--text-3)" }}>roots</span>
            <span className="categories-view__card-count">
              {rootsUsed} used
            </span>
          </span>
          <span className="categories-view__card-headline">
            Memories from earlier sessions
          </span>
          <span className="categories-view__card-sub">None yet.</span>
          <CellBar cells={rootCells} color={ROOT_COLOR_VAR} />
        </button>
      </div>

      {heatmap && heatmap.rows.length > 0 && (
        <div className="categories-view__heatmap">
          <div className="categories-view__heatmap-head">
            <span>topic switching over the session</span>
            <span>{pluralize(heatmap.turnsPerCell, "turn")} per cell</span>
          </div>
          {heatmap.rows.map((row) => (
            <div className="categories-view__heatmap-row" key={row.frondName}>
              <span
                className="categories-view__heatmap-label"
                style={{ color: rowColor(row.frondName, fronds) }}
              >
                {row.frondName}
              </span>
              <span
                className="categories-view__heatmap-cells"
                style={{
                  gridTemplateColumns: `repeat(${row.cells.length}, minmax(0, 1fr))`,
                }}
              >
                {row.cells.map((cell, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, purely decorative scale bar — position is the only identity these cells have.
                    key={i}
                    style={{
                      background:
                        cell !== null
                          ? rowColor(row.frondName, fronds)
                          : "var(--off)",
                    }}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
