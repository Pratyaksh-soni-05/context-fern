// The character fern — Context Fern's static brand illustration (not
// the live, data-driven graph in FernView). Ported verbatim from
// docs/design/blueprint/Start.dc.html's reference script: a classic
// Barnsley fern IFS driven by a seeded mulberry32 PRNG, so the same
// seed always draws the same fern — deterministic, no randomness at
// render time. See docs/design/DESIGN.md's "character fern" section
// and docs/decisions.md.

export type Point = [number, number];

/** mulberry32 — a small, fast, seedable PRNG; not cryptographic, and not meant to be. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The four affine transforms of the classic Barnsley fern IFS: stem, two leaflet pairs, and the main frond-curl case. */
function barnsleyTransform(i: number, p: Point): Point {
  const [x, y] = p;
  if (i === 0) return [0, 0.16 * y];
  if (i === 1) return [0.85 * x + 0.04 * y, -0.04 * x + 0.85 * y + 1.6];
  if (i === 2) return [0.2 * x - 0.26 * y, 0.23 * x + 0.22 * y + 1.6];
  return [-0.15 * x + 0.28 * y, 0.26 * x + 0.24 * y + 0.44];
}

export interface CharacterFernArt {
  /** Three opacity-layered dot-path `d` attributes (low, mid, high density), for a viewBox="0 0 620 660" SVG. */
  d1: string;
  d2: string;
  d3: string;
}

/**
 * Runs the IFS `n + 20` times (first 20 discarded as burn-in, since the
 * orbit needs a few steps to land near the attractor), maps each point
 * to pixel space, snaps to a 6px grid to dedupe, and buckets every
 * surviving point into one of three opacity layers via a random
 * threshold — produces the same three-path shape every time for a
 * given seed.
 */
export function fern(n: number, seed: number): CharacterFernArt {
  const r = rng(seed);
  let p: Point = [0, 0];
  const d: [string, string, string] = ["", "", ""];
  const seen = new Set<string>();

  for (let i = 0; i < n + 20; i++) {
    const q = r();
    const k = q < 0.01 ? 0 : q < 0.86 ? 1 : q < 0.93 ? 2 : 3;
    p = barnsleyTransform(k, p);
    if (i < 20) continue;

    const x = 120 + (p[0] + 2.2) * 112;
    const y = 700 - p[1] * 78;
    const gx = Math.round(x / 6) * 6;
    const gy = Math.round(y / 6) * 6;
    const key = `${gx},${gy}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const b = r();
    const bucket = b < 0.3 ? 0 : b < 0.7 ? 1 : 2;
    d[bucket] += `M${gx} ${gy}h0.01`;
  }

  return { d1: d[0], d2: d[1], d3: d[2] };
}
