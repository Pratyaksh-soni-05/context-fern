// Spec §11's List view: "one row per exchange: turn, frond, kind,
// prompt, context cells, confidence." Windowed (not virtualized) —
// `/leaflets` is paginated server-side, and this view only ever holds
// one page's worth of rows in the DOM at a time, so a session with
// thousands of leaflets never renders them all at once. This is also
// the one place every leaflet is reachable, independent of the Fern
// graph's own ~500-leaflet cap for the SVG element budget — see
// docs/decisions.md.

import { useEffect, useState } from "react";
import { getLeaflets } from "../../api/client";
import type { DecisionAction, TreeFrond, UiLeaflet } from "../../api/types";
import { frondColorVar } from "../../design/frond-colors";
import type { Selection } from "../../design/selection";
import "./ListView.css";

const PAGE_SIZE = 50;
// Presentational only — real isolate-mode context-payload accounting
// isn't built yet (the ctx-kept-out stat tile says "n/a" for the same
// reason); tokenCount itself is real, this just scales it into a
// handful of filled/empty cells rather than claiming a precise figure.
const CONTEXT_CELLS = 12;
const TOKENS_PER_CELL = 200;

const KIND_COLOR_VAR: Record<DecisionAction, string> = {
  new: "var(--frond-4-ink)",
  return: "var(--frond-1-ink)",
  continue: "var(--text-3)",
  combine: "var(--frond-2-ink)",
  merge: "var(--frond-3-ink)",
  stray: "var(--stray-ink)",
};

export interface ListViewProps {
  projectPath: string;
  fronds: TreeFrond[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function ListView({
  projectPath,
  fronds,
  selection,
  onSelect,
}: ListViewProps) {
  const [page, setPage] = useState(0);
  const [leaflets, setLeaflets] = useState<UiLeaflet[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeaflets(projectPath, page * PAGE_SIZE, PAGE_SIZE)
      .then((res) => {
        if (cancelled) return;
        setLeaflets(res.leaflets);
        setTotal(res.total);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load leaflets.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, page]);

  const frondColor = (frondName: string): string => {
    const frond = fronds.find((f) => f.name === frondName);
    return frond ? frondColorVar(frond.colorIndex) : "var(--stem)";
  };

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <section className="list-view" aria-label="Every turn, in order">
      <div className="list-view__header">
        <span>turn</span>
        <span>frond</span>
        <span>kind</span>
        <span>prompt</span>
        <span>context</span>
        <span>basis</span>
      </div>
      {error && (
        <p role="alert" className="list-view__error">
          {error}
        </p>
      )}
      <div className="list-view__rows">
        {leaflets.map((l) => {
          const isSelected =
            selection?.kind === "leaflet" && selection.turn === l.turn;
          const filled = Math.min(
            CONTEXT_CELLS,
            Math.ceil(l.tokenCount / TOKENS_PER_CELL),
          );
          const frondText = l.isStray
            ? `stray ← ${l.strayFromFrondName ?? "stem"}`
            : l.frondName;
          return (
            <button
              type="button"
              key={l.turn}
              className="list-view__row"
              data-selected={isSelected}
              onClick={() => onSelect({ kind: "leaflet", turn: l.turn })}
            >
              <span className="list-view__turn">
                {String(l.turn).padStart(2, "0")}
              </span>
              <span className="list-view__frond">
                <span
                  className="list-view__dot"
                  style={{
                    background: l.isStray
                      ? "transparent"
                      : frondColor(l.frondName),
                    borderColor: l.isStray
                      ? "var(--stray)"
                      : frondColor(l.frondName),
                    borderStyle: l.isStray ? "dashed" : "solid",
                  }}
                />
                <span className="list-view__frond-name" title={frondText}>
                  {frondText}
                </span>
              </span>
              <span
                style={{
                  color: l.kind ? KIND_COLOR_VAR[l.kind] : "var(--text-3)",
                }}
              >
                {l.kind ?? "continue"}
              </span>
              <span className="list-view__prompt">
                {l.promptPreview ?? "n/a"}
              </span>
              <span
                className="list-view__context"
                role="img"
                aria-label={`${l.tokenCount} tokens`}
              >
                {Array.from({ length: CONTEXT_CELLS }, (_, i) => {
                  const on = i < filled;
                  return (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, purely decorative scale bar — position is the only identity these cells have.
                      key={i}
                      className="list-view__context-cell"
                      data-on={on}
                      style={
                        on ? { background: frondColor(l.frondName) } : undefined
                      }
                    />
                  );
                })}
              </span>
              <span className="list-view__conf">
                {l.confidence !== null
                  ? l.confidence.toFixed(2)
                  : (l.basis ?? "—")}
              </span>
            </button>
          );
        })}
      </div>
      <div className="list-view__pagination">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          previous
        </button>
        <span>
          {rangeStart}–{rangeEnd} of {total}
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
          disabled={page >= lastPage}
        >
          next
        </button>
      </div>
    </section>
  );
}
