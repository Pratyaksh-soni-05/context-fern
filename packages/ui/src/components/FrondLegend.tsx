// A flat, single-select list of mutually-exclusive filters (stem, each
// frond, strays, roots) — ARIA's listbox/option pattern, not "tree"
// (there's no expand/collapse or nesting here, so role="tree" would be
// the wrong widget). Roving tabindex: one tab stop for the whole list,
// Up/Down/Home/End move focus among options, matching the WAI-ARIA
// Listbox authoring practice. See docs/decisions.md.

import { type KeyboardEvent, useRef } from "react";
import type { TreeFrond } from "../api/types";
import {
  frondColorVar,
  ROOT_COLOR_VAR,
  STEM_COLOR_VAR,
  STRAY_COLOR_VAR,
} from "../design/frond-colors";
import type { Selection } from "../design/selection";
import "./FrondLegend.css";

export interface FrondLegendProps {
  fronds: TreeFrond[];
  strayCount: number;
  rootsUsed: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

interface LegendItem {
  key: string;
  candidate: Selection;
  swatchColor: string;
  swatchStyle?: "dashed" | "dotted";
  name: string;
  count?: number;
}

function isOn(selection: Selection, candidate: Selection): boolean {
  if (!selection) return false;
  if (selection.kind !== candidate?.kind) return false;
  if (selection.kind === "frond" && candidate?.kind === "frond") {
    return selection.id === candidate.id;
  }
  return true;
}

export function FrondLegend({
  fronds,
  strayCount,
  rootsUsed,
  selection,
  onSelect,
}: FrondLegendProps) {
  const topicFronds = fronds.filter((f) => f.status !== "merged");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const items: LegendItem[] = [
    {
      key: "stem",
      candidate: { kind: "stem" },
      swatchColor: STEM_COLOR_VAR,
      name: "main · stem",
    },
    ...topicFronds.map((frond) => ({
      key: frond.id,
      candidate: { kind: "frond", id: frond.id } as Selection,
      swatchColor: frondColorVar(frond.colorIndex),
      name: frond.name,
      count: frond.leafletCount,
    })),
    {
      key: "strays",
      candidate: { kind: "strays" },
      swatchColor: STRAY_COLOR_VAR,
      swatchStyle: "dashed",
      name: "strays",
      count: strayCount,
    },
    {
      key: "roots",
      candidate: { kind: "roots" },
      swatchColor: ROOT_COLOR_VAR,
      swatchStyle: "dotted",
      name: "roots",
      count: rootsUsed,
    },
  ];

  const activeIndex = items.findIndex((it) => isOn(selection, it.candidate));
  const focusIndex = Math.max(activeIndex, 0);

  function focusItem(index: number): void {
    refs.current[index]?.focus();
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem((index + 1) % items.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem((index - 1 + items.length) % items.length);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      className="frond-legend"
      role="listbox"
      aria-label="This fern's fronds"
    >
      {items.map((item, index) => {
        const on = isOn(selection, item.candidate);
        return (
          <div key={item.key} role="presentation">
            <button
              type="button"
              ref={(el) => {
                refs.current[index] = el;
              }}
              role="option"
              aria-selected={on}
              tabIndex={index === focusIndex ? 0 : -1}
              className="frond-legend__row"
              data-on={on}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onClick={() => onSelect(on ? null : item.candidate)}
            >
              <span
                className={`frond-legend__swatch${item.swatchStyle ? ` frond-legend__swatch--${item.swatchStyle}` : ""}`}
                style={{ borderColor: item.swatchColor }}
              />
              <span className="frond-legend__name">{item.name}</span>
              {item.count !== undefined && (
                <span className="frond-legend__count">{item.count}</span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
