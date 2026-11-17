import { pluralize } from "@context-fern/core";
import { useEffect, useState } from "react";
import { getFrondBrief } from "../api/client";
import type { TreeFrond, UiLeaflet } from "../api/types";
import { UI_COMMAND } from "../constants";
import type { Selection } from "../design/selection";
import { FrondLegend } from "./FrondLegend";
import "./Inspector.css";

export interface InspectorProps {
  projectPath: string;
  fronds: TreeFrond[];
  leaflets: UiLeaflet[];
  strayCount: number;
  /** Leaflets that open a frond; part of the leaflet count, named in the headline. */
  frondOpenings?: number;
  rootsUsed: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onUndo: () => void;
  undoBusy: boolean;
}

interface DetailField {
  k: string;
  v: string;
}
interface Detail {
  kicker: string;
  title: string;
  fields: DetailField[];
}

export function Inspector({
  projectPath,
  fronds,
  leaflets,
  strayCount,
  frondOpenings = 0,
  rootsUsed,
  selection,
  onSelect,
  onUndo,
  undoBusy,
}: InspectorProps) {
  const [brief, setBrief] = useState<{
    name: string;
    goal: string;
    decided: string;
    open: string;
    files: string;
  } | null>(null);

  const frondName =
    selection?.kind === "frond"
      ? fronds.find((f) => f.id === selection.id)?.name
      : null;

  useEffect(() => {
    if (!frondName) {
      setBrief(null);
      return;
    }
    let cancelled = false;
    getFrondBrief(projectPath, frondName)
      .then((b) => {
        if (!cancelled) setBrief(b);
      })
      .catch(() => {
        if (!cancelled) setBrief(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, frondName]);

  const detail = buildDetail(
    selection,
    fronds,
    leaflets,
    strayCount,
    frondOpenings,
    brief,
  );

  return (
    <aside aria-label="Inspector" className="inspector">
      <div className="inspector__legend-heading">
        <span className="diamond" aria-hidden="true" />
        this fern
        <span className="dot-rule" aria-hidden="true" />
      </div>
      <div className="inspector__legend">
        <FrondLegend
          fronds={fronds}
          strayCount={strayCount}
          rootsUsed={rootsUsed}
          selection={selection}
          onSelect={onSelect}
        />
      </div>
      <div className="inspector__detail">
        <span className="inspector__kicker">{detail.kicker}</span>
        <span className="inspector__title">{detail.title}</span>
        {detail.fields.map((f) => (
          <div className="inspector__field" key={f.k}>
            <span className="inspector__field-key">{f.k}</span>
            <span className="inspector__field-value">{f.v}</span>
          </div>
        ))}
      </div>
      <div className="inspector__actions">
        <button
          type="button"
          className="inspector__undo"
          onClick={onUndo}
          disabled={undoBusy}
        >
          undo routing
        </button>
      </div>
    </aside>
  );
}

function buildDetail(
  selection: Selection,
  fronds: TreeFrond[],
  leaflets: UiLeaflet[],
  strayCount: number,
  frondOpenings: number,
  brief: { goal: string; decided: string; open: string; files: string } | null,
): Detail {
  if (selection?.kind === "leaflet") {
    const l = leaflets.find((x) => x.turn === selection.turn);
    if (!l) return emptyDetail(fronds, leaflets, frondOpenings);
    return {
      kicker: `turn ${String(l.turn).padStart(2, "0")} · ${l.isStray ? `stray from ${l.strayFromFrondName ?? "stem"}` : l.frondName}`,
      title: l.promptPreview ?? "n/a",
      fields: [
        {
          k: "routing",
          v: `${l.kind ?? "continue"} · ${l.confidence !== null ? `confidence ${l.confidence.toFixed(2)}` : (l.basis ?? "no score")}`,
        },
        {
          k: "context this turn",
          v: `${l.tokenCount} tokens${l.isStray ? " · answered without touching any frond" : ""}`,
        },
        { k: "files touched", v: String(l.filesTouchedCount) },
      ],
    };
  }
  if (selection?.kind === "frond") {
    const frond = fronds.find((f) => f.id === selection.id);
    if (!frond) return emptyDetail(fronds, leaflets, frondOpenings);
    return {
      kicker: `frond · ${frond.name}`,
      title: brief?.goal || "(no goal recorded yet)",
      fields: [
        { k: "decided", v: brief?.decided || "n/a" },
        { k: "open", v: brief?.open || "n/a" },
        { k: "files", v: brief?.files || "n/a" },
        { k: "leaflets", v: String(frond.leafletCount) },
      ],
    };
  }
  if (selection?.kind === "strays") {
    const strays = leaflets.filter((l) => l.isStray);
    // `leaflets` is AppShell's graph-capped window, not every leaflet
    // this session has ever had — `strayCount` (from /stats) is the
    // real, uncapped total. A long session can genuinely have more
    // strays than are enumerable here; say so rather than silently
    // listing fewer than the real count.
    const missing = Math.max(0, strayCount - strays.length);
    const fields: DetailField[] =
      strays.length > 0
        ? strays.map((s) => ({
            k: `turn ${s.turn} · from ${s.strayFromFrondName ?? "stem"}`,
            v: s.promptPreview ?? "text not kept",
          }))
        : [{ k: "none yet", v: "n/a" }];
    if (missing > 0) {
      fields.push({
        k: "not shown here",
        v: `${missing} more — see List for the complete history`,
      });
    }
    return {
      kicker: "strays · off-topic",
      title: "Answered, then kept off every frond",
      fields,
    };
  }
  if (selection?.kind === "roots") {
    return {
      kicker: "roots · memory",
      title: "No roots yet",
      fields: [{ k: "status", v: "writing roots isn't wired up yet" }],
    };
  }
  return emptyDetail(fronds, leaflets, frondOpenings);
}

/**
 * The default/fallback headline used to read "Nothing lost." — a
 * marketing claim, not computed from anything, and shown even for a
 * genuinely empty session (0 leaflets), where there's nothing yet *to*
 * lose. Replaced with a real, verifiable count straight from the same
 * `fronds`/`leaflets` props every other panel renders from: "No turns
 * yet." when there truly aren't any, "<n> leaflets · <n> fronds"
 * otherwise.
 */
function emptyDetail(
  fronds: TreeFrond[],
  leaflets: UiLeaflet[],
  frondOpenings: number,
): Detail {
  const hasData = leaflets.length > 0;
  // Matches the "fronds" stat tile's own definition (AppShell.tsx,
  // getSessionStats) — merged fronds excluded — so the two panels never
  // show two different frond counts for the same session.
  const activeFrondCount = fronds.filter((f) => f.status !== "merged").length;
  return {
    kicker: "session",
    title: hasData
      ? `${pluralize(leaflets.length, "leaflet")} · ${pluralize(activeFrondCount, "frond")}${frondOpenings > 0 ? ` · ${pluralize(frondOpenings, "frond opening")}` : ""}`
      : "No turns yet.",
    fields: hasData
      ? [
          {
            k: "how to read it",
            v: "The dark stem is the task. Each coloured frond is a topic; its leaflets are turns. Dashed orange shoots are off-topic questions.",
          },
          {
            k: "try",
            v: "Click a leaflet or a frond, or press replay to watch the session grow.",
          },
        ]
      : [
          {
            k: "how to read it",
            v: "The dark stem is the task. Each coloured frond is a topic; its leaflets are turns. Dashed orange shoots are off-topic questions.",
          },
          {
            k: "try",
            v: `Prompt the agent in this project — ${UI_COMMAND} fills in as you go.`,
          },
        ],
  };
}
