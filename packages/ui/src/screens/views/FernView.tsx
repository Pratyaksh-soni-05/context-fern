// Spec §11's Fern view: "stem, coloured fronds with stippled leaflets,
// leaflet nodes, dashed orange strays, dashed root lines and nodes,
// dotted graft links." Reference behaviour (replay, growth slider,
// strays/roots toggles, selection/dimming): Prototype.dc.html. Roots
// never render here — nothing writes real Root rows yet (spec §15).

import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeFrond, UiLeaflet } from "../../api/types";
import {
  type FrondGeometry,
  frondGeometry,
  leafletPositions,
  type Point,
  placeFronds,
  STEM_CURVE,
  stemStipple,
  stippleDots,
  strayPoint,
} from "../../design/fern-graph";
import {
  frondColorVar,
  frondInkVar,
  STEM_COLOR_VAR,
  STRAY_COLOR_VAR,
  STRAY_INK_VAR,
} from "../../design/frond-colors";
import { DIM_OPACITY, type Selection } from "../../design/selection";
import "./FernView.css";

const REPLAY_INTERVAL_MS = 500;

/** Activates on Enter/Space, matching native button semantics — for the SVG hit-target circles below, which carry role="button" since <circle> has no native interactive semantics of its own. */
function onKeyDownActivate(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

interface FrondRuntime {
  frond: TreeFrond;
  placement: ReturnType<typeof placeFronds>[number];
  leaflets: UiLeaflet[]; // this frond's own leaflets, turn-ascending
}

export interface FernViewProps {
  fronds: TreeFrond[];
  leaflets: UiLeaflet[]; // every leaflet, turn-ascending (capped — see api/client.ts's getLeaflets call site)
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function FernView({
  fronds,
  leaflets,
  selection,
  onSelect,
}: FernViewProps) {
  const totalTurns = leaflets.length;
  const [growth, setGrowth] = useState(totalTurns);
  const [playing, setPlaying] = useState(false);
  const [showStrays, setShowStrays] = useState(true);
  const [showRoots, setShowRoots] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );

  // Growth follows the real data size — a session that grows between
  // polls (or on first load) should default to "fully grown", not get
  // stuck at whatever an earlier, smaller totalTurns happened to be.
  useEffect(() => {
    setGrowth(totalTurns);
  }, [totalTurns]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function togglePlay(): void {
    if (playing) {
      if (timerRef.current) clearInterval(timerRef.current);
      setPlaying(false);
      return;
    }
    const start = growth >= totalTurns ? 1 : growth;
    setGrowth(start);
    setPlaying(true);
    timerRef.current = setInterval(() => {
      setGrowth((g) => {
        if (g + 1 > totalTurns) {
          if (timerRef.current) clearInterval(timerRef.current);
          setPlaying(false);
          return g;
        }
        return g + 1;
      });
    }, REPLAY_INTERVAL_MS);
  }

  // Merged fronds still render (dimmed graft line), just not selectable
  // as "active" — every real frond in `fronds` is placed, regardless of
  // status.
  const runtimes: FrondRuntime[] = useMemo(() => {
    const placements = placeFronds(
      fronds.map((f) => ({ leafletCount: f.leafletCount })),
    );
    return fronds.map((frond, i) => ({
      frond,
      placement: placements[i] ?? {
        t: 0.5,
        side: 1 as const,
        angleDeg: 22,
        maxLength: 200,
      },
      leaflets: leaflets.filter((l) => l.frondName === frond.name),
    }));
  }, [fronds, leaflets]);

  const selectedFrondId = selection?.kind === "frond" ? selection.id : null;
  const dimAll = selection !== null;

  function dimOpacity(isSelected: boolean): number {
    if (!dimAll) return 1;
    return isSelected ? 1 : DIM_OPACITY;
  }

  // Positions keyed by turn, filled in while laying out each frond and
  // the stem — used afterward for stray/graft lines, which need a
  // specific leaflet's (x, y).
  const posByTurn = new Map<number, Point>();

  const stemDots = useMemo(() => stemStipple(), []);
  const stemOpacity = dimOpacity(selection?.kind === "stem");

  const frondElements: React.ReactNode[] = [];
  const labelElements: React.ReactNode[] = [];

  for (const rt of runtimes) {
    const visible = rt.leaflets.filter(
      (l) => l.turn < growth || l.turn === growth,
    );
    // keep rendering a resting frond's shape even with zero visible
    // leaflets yet, so the legend/graph stay in sync as growth rewinds
    if (visible.length === 0) continue;

    const geom: FrondGeometry = frondGeometry(
      rt.placement,
      visible.length,
      rt.leaflets.length,
    );
    const positions = leafletPositions(geom, visible.length);
    visible.forEach((l, i) => {
      const p = positions[i];
      if (p) posByTurn.set(l.turn, p);
    });

    const color = frondColorVar(rt.frond.colorIndex);
    const isSelected = selectedFrondId === rt.frond.id;
    const opacity = dimOpacity(isSelected);
    const stations = Math.round(8 + 18 * (geom.length / 330));
    const [d1, d2] = stippleDots(
      geom.start,
      geom.control,
      geom.end,
      stations,
      20 * (0.55 + (0.45 * geom.length) / 330),
      4,
      40 + rt.placement.t * 1000,
    );

    frondElements.push(
      <path
        key={`stipple-a-${rt.frond.id}`}
        d={d1}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        opacity={0.35 * opacity}
      />,
      <path
        key={`stipple-b-${rt.frond.id}`}
        d={d2}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        opacity={0.75 * opacity}
      />,
      <path
        key={`curve-${rt.frond.id}`}
        d={`M${geom.start[0].toFixed(1)} ${geom.start[1].toFixed(1)}Q${geom.control[0].toFixed(1)} ${geom.control[1].toFixed(1)} ${geom.end[0].toFixed(1)} ${geom.end[1].toFixed(1)}`}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        opacity={(rt.frond.status === "merged" ? 0.55 : 1) * opacity}
      />,
    );
    labelElements.push(
      <text
        key={`label-${rt.frond.id}`}
        x={geom.end[0] + rt.placement.side * 12}
        y={geom.end[1] + 4}
        fill={frondInkVar(rt.frond.colorIndex)}
        fontFamily="var(--font-mono)"
        fontSize={12}
        textAnchor={rt.placement.side > 0 ? "start" : "end"}
        opacity={opacity}
      >
        {rt.frond.name}
        {rt.frond.status === "merged" ? " · merged" : ""} · {visible.length}
      </text>,
    );

    // Graft link: a merged frond's last leaflet ties back toward the stem.
    if (rt.frond.status === "merged" && visible.length === rt.leaflets.length) {
      const last = positions[positions.length - 1];
      const back: Point = [430, 330]; // a fixed mid-stem point, matching the reference's back-tie target
      if (last) {
        frondElements.push(
          <path
            key={`graft-${rt.frond.id}`}
            d={`M${last[0].toFixed(1)} ${last[1].toFixed(1)}L${back[0]} ${back[1]}`}
            fill="none"
            stroke={color}
            strokeWidth={1.1}
            strokeDasharray="1 4"
            opacity={0.9 * opacity}
          />,
        );
      }
    }

    frondElements.push(
      ...visible.map((l, i) => {
        const p = positions[i];
        if (!p) return null;
        const isLast = l.turn === totalTurns;
        const isLeafletSelected =
          selection?.kind === "leaflet" && selection.turn === l.turn;
        const nodeOpacity =
          dimAll && !isSelected && !isLeafletSelected ? DIM_OPACITY : 1;
        return (
          <g key={`node-${l.turn}`}>
            <circle
              cx={p[0]}
              cy={p[1]}
              r={isLeafletSelected ? 7 : 4.3}
              fill={color}
              stroke={
                isLeafletSelected || isLast ? "var(--ink)" : "var(--surface)"
              }
              strokeWidth={isLeafletSelected || isLast ? 2 : 1.5}
              opacity={nodeOpacity}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: <button> can't appear as SVG graphics content — role="button" on a <circle>, with tabIndex and a keydown handler, is the standard accessible pattern for an interactive SVG shape. */}
            <circle
              cx={p[0]}
              cy={p[1]}
              r={11}
              fill="#000"
              fillOpacity={0}
              style={{ cursor: "pointer" }}
              role="button"
              tabIndex={0}
              aria-label={`Turn ${l.turn}: ${l.promptPreview ?? `${l.kind ?? "continue"} on ${l.frondName}`}`}
              onClick={() => onSelect({ kind: "leaflet", turn: l.turn })}
              onKeyDown={onKeyDownActivate(() =>
                onSelect({ kind: "leaflet", turn: l.turn }),
              )}
            >
              <title>
                turn {l.turn}:{" "}
                {l.promptPreview ?? `${l.kind ?? "continue"} on ${l.frondName}`}
              </title>
            </circle>
          </g>
        );
      }),
    );
  }

  // Strays — only those within the current growth.
  const strayElements: React.ReactNode[] = [];
  if (showStrays) {
    const lastTurnByFrondName = new Map<string, number>();
    for (const l of leaflets) {
      if (l.turn > growth) break;
      if (!l.isStray) {
        lastTurnByFrondName.set(l.frondName, l.turn);
        continue;
      }
      const parentName = l.strayFromFrondName;
      let anchor: Point | null = null;
      let side: 1 | -1 = -1;
      if (parentName === "stem" || !parentName) {
        anchor = [460, 420];
      } else {
        const parentTurn = lastTurnByFrondName.get(parentName);
        anchor =
          parentTurn !== undefined ? (posByTurn.get(parentTurn) ?? null) : null;
        const parentRt = runtimes.find((rt) => rt.frond.name === parentName);
        side = parentRt ? parentRt.placement.side : -1;
      }
      if (!anchor) continue;
      const tip = strayPoint(anchor, side);
      const isSelected = selection?.kind === "strays";
      const isLeafletSelected =
        selection?.kind === "leaflet" && selection.turn === l.turn;
      const opacity =
        dimAll && !isSelected && !isLeafletSelected ? DIM_OPACITY : 1;
      strayElements.push(
        <g key={`stray-${l.turn}`}>
          <path
            d={`M${anchor[0].toFixed(1)} ${anchor[1].toFixed(1)}L${tip[0].toFixed(1)} ${tip[1].toFixed(1)}`}
            fill="none"
            stroke={STRAY_COLOR_VAR}
            strokeWidth={1.4}
            strokeDasharray="4 3"
            opacity={opacity}
          />
          <circle
            cx={tip[0]}
            cy={tip[1]}
            r={isLeafletSelected ? 7 : 4.5}
            fill="var(--surface)"
            stroke={STRAY_COLOR_VAR}
            strokeWidth={1.6}
            opacity={opacity}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: <button> can't appear as SVG graphics content — see the other hit-target circle above for the full rationale. */}
          <circle
            cx={tip[0]}
            cy={tip[1]}
            r={11}
            fill="#000"
            fillOpacity={0}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            aria-label={`Turn ${l.turn} (stray): ${l.promptPreview ?? "off-topic"}`}
            onClick={() => onSelect({ kind: "leaflet", turn: l.turn })}
            onKeyDown={onKeyDownActivate(() =>
              onSelect({ kind: "leaflet", turn: l.turn }),
            )}
          >
            <title>
              turn {l.turn} (stray): {l.promptPreview ?? "off-topic"}
            </title>
          </circle>
          <text
            x={tip[0] + side * 9}
            y={tip[1] + 4}
            fill={STRAY_INK_VAR}
            fontFamily="var(--font-mono)"
            fontSize={10.5}
            textAnchor={side > 0 ? "start" : "end"}
            opacity={opacity}
          >
            stray
          </text>
        </g>,
      );
    }
  }

  const turnPad = growth < 10 ? `0${growth}` : String(growth);

  return (
    <section className="fern-view" aria-label="Context fern">
      <div className="fern-view__toolbar">
        <span className="fern-view__title">
          <span className="diamond" aria-hidden="true" />
          The fern · every turn, connected
        </span>
        <div className="fern-view__toggles">
          <button
            type="button"
            className="fern-view__toggle"
            data-active={showStrays}
            onClick={() => setShowStrays((v) => !v)}
            aria-pressed={showStrays}
          >
            strays
          </button>
          <button
            type="button"
            className="fern-view__toggle"
            data-active={showRoots}
            onClick={() => setShowRoots((v) => !v)}
            aria-pressed={showRoots}
          >
            roots
          </button>
          <button
            type="button"
            className="fern-view__toggle"
            onClick={() => onSelect(null)}
          >
            show all
          </button>
        </div>
      </div>

      <div className="fern-view__canvas">
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 920 600"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Session fern: the stem is the task, each coloured frond is a topic, leaflets are turns, dashed orange shoots are off-topic questions"
        >
          <path
            d={stemDots[0]}
            fill="none"
            stroke={STEM_COLOR_VAR}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.22 * stemOpacity}
          />
          <path
            d={stemDots[1]}
            fill="none"
            stroke={STEM_COLOR_VAR}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.5 * stemOpacity}
          />
          <path
            d={`M${STEM_CURVE.start[0]} ${STEM_CURVE.start[1]}Q${STEM_CURVE.control[0]} ${STEM_CURVE.control[1]} ${STEM_CURVE.end[0]} ${STEM_CURVE.end[1]}`}
            fill="none"
            stroke={STEM_COLOR_VAR}
            strokeWidth={1.8}
            opacity={0.95 * stemOpacity}
          />
          {frondElements}
          {strayElements}
          {labelElements}
        </svg>
      </div>

      <div className="fern-view__replay">
        <button type="button" className="fern-view__play" onClick={togglePlay}>
          {playing ? "pause" : "replay"}
        </button>
        <label htmlFor="fern-growth" className="fern-view__growth-label">
          growth
        </label>
        <input
          id="fern-growth"
          type="range"
          min={totalTurns > 0 ? 1 : 0}
          max={Math.max(totalTurns, 1)}
          step={1}
          value={growth}
          onChange={(e) => setGrowth(Number(e.target.value))}
          className="fern-view__slider"
        />
        <span className="fern-view__turn-count">
          {totalTurns === 0 ? "0 / 0" : `turn ${turnPad} / ${totalTurns}`}
        </span>
      </div>
    </section>
  );
}
