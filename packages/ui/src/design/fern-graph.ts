// The live, data-driven Fern view's geometry — ported from
// docs/design/blueprint/Prototype.dc.html's reference script (qb/qt/rot/
// geom/leaflets), not the static character-fern illustration in
// fern-art.ts. DESIGN.md: "Stem is a quadratic curve; each frond
// attaches at a fixed point on the stem, alternating sides, length
// grows with its leaflet count; leaflet nodes are spaced along the
// frond curve; stippled leaflets are dot paths... Strays shoot 52px out
// and 40px down from the leaflet they interrupted... Roots curve from
// the stem base to memory nodes below." Real roots never render here
// (nothing writes them yet — spec §15), but the geometry helpers below
// are written generally enough to support them once that ships.
//
// Element budget: stipple dots are batched into 2 opacity-bucket
// `<path>` elements per frond (one multi-point `d` string each), not
// one element per dot — the same trick the reference uses to stay
// under ~2000 SVG elements regardless of session length.

export type Point = readonly [number, number];

const STEM_START: Point = [460, 520];
const STEM_CONTROL: Point = [410, 290];
const STEM_END: Point = [480, 40];

/** A point at parameter `t` (0..1) along a quadratic Bezier a->b->c. */
export function quadraticPoint(a: Point, b: Point, c: Point, t: number): Point {
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
    u * u * a[1] + 2 * u * t * b[1] + t * t * c[1],
  ];
}

/** The unit tangent direction at parameter `t` along the same curve. */
export function quadraticTangent(
  a: Point,
  b: Point,
  c: Point,
  t: number,
): Point {
  const x = 2 * (1 - t) * (b[0] - a[0]) + 2 * t * (c[0] - b[0]);
  const y = 2 * (1 - t) * (b[1] - a[1]) + 2 * t * (c[1] - b[1]);
  const m = Math.sqrt(x * x + y * y) || 1;
  return [x / m, y / m];
}

export function rotate(v: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmt1(n: number): string {
  return n.toFixed(1);
}
function dotSegment(x: number, y: number): string {
  return `M${fmt1(x)} ${fmt1(y)}h0`;
}

/**
 * Batches many stippled "leaflet" dots along a curve into two opacity-
 * bucket path `d` strings — the element-budget trick (see module doc).
 * `stations` points are spaced along the curve; at each, a small cloud
 * of dots is scattered to either side, deterministically from `seed`.
 */
export function stippleDots(
  a: Point,
  b: Point,
  c: Point,
  stations: number,
  maxLen: number,
  minLen: number,
  seed: number,
): [string, string] {
  const r = mulberry32(seed);
  const d: [string, string] = ["", ""];
  for (let m = 0; m < stations; m++) {
    const u = 0.04 + (0.93 * m) / Math.max(stations - 1, 1);
    const p = quadraticPoint(a, b, c, u);
    const t = quadraticTangent(a, b, c, u);
    const len = maxLen * (1 - u) + minLen;
    for (const side of [-1, 1] as const) {
      const perp = rotate(t, side * 58);
      for (let j = 1; j <= 4; j++) {
        const f = j / 4;
        const x =
          p[0] + perp[0] * len * f + t[0] * len * 0.3 * f + (r() - 0.5) * 1.8;
        const y =
          p[1] + perp[1] * len * f + t[1] * len * 0.3 * f + (r() - 0.5) * 1.8;
        d[r() < 0.55 ? 0 : 1] += dotSegment(x, y);
      }
    }
  }
  return d;
}

export interface FrondPlacement {
  /** Attachment point along the stem, 0..1. */
  t: number;
  /** -1 (left) or 1 (right). */
  side: 1 | -1;
  /** Degrees off the stem's own tangent. */
  angleDeg: number;
  /** Max length at full growth — grows with leaflet count, DESIGN.md's "length grows with its leaflet count". */
  maxLength: number;
}

const BASE_LENGTH = 170;
const LENGTH_PER_LEAFLET = 14;
const MAX_LENGTH = 330;
const MIN_T = 0.18;
const MAX_T = 0.82;

/**
 * Procedurally places each frond along the stem — evenly spread
 * between MIN_T/MAX_T in creation order, alternating sides, length
 * scaled by leaflet count and capped. The reference board hardcodes
 * these per frond (t/side/ang/len in its FRONDS array); production
 * derives them from the real fronds list instead.
 */
export function placeFronds(
  fronds: readonly { leafletCount: number }[],
): FrondPlacement[] {
  const n = fronds.length;
  return fronds.map((f, i) => {
    const t =
      n <= 1 ? (MIN_T + MAX_T) / 2 : MIN_T + ((MAX_T - MIN_T) * i) / (n - 1);
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const maxLength = Math.min(
      MAX_LENGTH,
      BASE_LENGTH + f.leafletCount * LENGTH_PER_LEAFLET,
    );
    return { t, side, angleDeg: 22, maxLength };
  });
}

export interface FrondGeometry {
  start: Point;
  control: Point;
  end: Point;
  length: number;
}

/**
 * The frond's actual curve at the current growth (`visibleCount` of its
 * `totalCount` leaflets revealed, e.g. during replay) — grows from
 * ~32% to 100% of `maxLength` as leaflets accumulate, same curve shape
 * the reference uses.
 */
export function frondGeometry(
  placement: FrondPlacement,
  visibleCount: number,
  totalCount: number,
): FrondGeometry {
  const grown = totalCount > 0 ? visibleCount / totalCount : 1;
  const length = placement.maxLength * (0.32 + 0.68 * grown);
  const start = quadraticPoint(STEM_START, STEM_CONTROL, STEM_END, placement.t);
  const angle = (placement.angleDeg * Math.PI) / 180;
  const end: Point = [
    start[0] + placement.side * length * Math.cos(angle),
    start[1] - length * Math.sin(angle),
  ];
  const control: Point = [
    start[0] + placement.side * length * 0.5 * Math.cos(angle),
    start[1] - length * 0.5 * Math.sin(angle) - length * 0.1,
  ];
  return { start, control, end, length };
}

/** Evenly spaced points along a frond's curve, one per visible leaflet, for node placement. */
export function leafletPositions(geom: FrondGeometry, count: number): Point[] {
  const positions: Point[] = [];
  for (let k = 0; k < count; k++) {
    const u = (k + 1) / (count + 0.5);
    positions.push(quadraticPoint(geom.start, geom.control, geom.end, u));
  }
  return positions;
}

/** A stray's node: 52px out from, and 40px down from, the leaflet it interrupted — DESIGN.md's exact figures. */
export function strayPoint(interrupted: Point, side: 1 | -1): Point {
  return [interrupted[0] + side * 52, interrupted[1] + 40];
}

export const STEM_CURVE = {
  start: STEM_START,
  control: STEM_CONTROL,
  end: STEM_END,
};

/** The stem's own stippled dot-paths — same generator as a frond's, run once over the whole stem curve at a fixed station count. */
export function stemStipple(): [string, string] {
  return stippleDots(STEM_START, STEM_CONTROL, STEM_END, 34, 16, 7, 3);
}
