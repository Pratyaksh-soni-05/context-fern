// Shared selection state for the Fern view / inspector / legend — the
// one thing clicking a leaflet, a frond, "strays" or "roots" sets, and
// what drives 18% selection-dimming on everything else.

export type Selection =
  | { kind: "stem" }
  | { kind: "frond"; id: string }
  | { kind: "strays" }
  | { kind: "roots" }
  | { kind: "leaflet"; turn: number }
  | null;

/** The dimming opacity applied to anything not part of the current selection — DESIGN.md's figure. */
export const DIM_OPACITY = 0.18;
