import { expect, test } from "bun:test";
import {
  frondGeometry,
  leafletPositions,
  placeFronds,
  quadraticPoint,
  quadraticTangent,
  rotate,
  stemStipple,
  stippleDots,
  strayPoint,
} from "../src/design/fern-graph";

test("quadraticPoint returns the endpoints at t=0 and t=1", () => {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [50, 100];
  const c: [number, number] = [100, 0];
  expect(quadraticPoint(a, b, c, 0)).toEqual([0, 0]);
  expect(quadraticPoint(a, b, c, 1)).toEqual([100, 0]);
});

test("quadraticTangent returns a unit vector", () => {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [50, 100];
  const c: [number, number] = [100, 0];
  const [x, y] = quadraticTangent(a, b, c, 0.5);
  expect(Math.sqrt(x * x + y * y)).toBeCloseTo(1, 5);
});

test("rotate by 0 degrees is a no-op, by 180 degrees negates", () => {
  const v: [number, number] = [1, 0];
  const r0 = rotate(v, 0);
  expect(r0[0]).toBeCloseTo(1, 5);
  expect(r0[1]).toBeCloseTo(0, 5);
  const r180 = rotate(v, 180);
  expect(r180[0]).toBeCloseTo(-1, 5);
  expect(r180[1]).toBeCloseTo(0, 5);
});

test("stippleDots is deterministic for a given seed and produces two non-empty buckets", () => {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [50, 100];
  const c: [number, number] = [100, 0];
  const first = stippleDots(a, b, c, 10, 20, 5, 42);
  const second = stippleDots(a, b, c, 10, 20, 5, 42);
  expect(first).toEqual(second);
  expect(first[0].length).toBeGreaterThan(0);
  expect(first[1].length).toBeGreaterThan(0);
});

test("stippleDots differs for a different seed", () => {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [50, 100];
  const c: [number, number] = [100, 0];
  const s1 = stippleDots(a, b, c, 10, 20, 5, 1);
  const s2 = stippleDots(a, b, c, 10, 20, 5, 2);
  expect(s1).not.toEqual(s2);
});

test("placeFronds alternates sides and spreads t evenly across fronds", () => {
  const placements = placeFronds([
    { leafletCount: 2 },
    { leafletCount: 2 },
    { leafletCount: 2 },
    { leafletCount: 2 },
  ]);
  expect(placements.map((p) => p.side)).toEqual([1, -1, 1, -1]);
  const ts = placements.map((p) => p.t);
  expect(ts[0]).toBeLessThan(ts[1] ?? 0);
  expect(ts[1]).toBeLessThan(ts[2] ?? 0);
  expect(ts[2]).toBeLessThan(ts[3] ?? 0);
});

test("placeFronds never crashes with zero or one frond", () => {
  expect(placeFronds([])).toEqual([]);
  expect(placeFronds([{ leafletCount: 1 }])).toHaveLength(1);
});

test("placeFronds grows maxLength with leaflet count, capped at MAX_LENGTH", () => {
  const [small, big] = placeFronds([
    { leafletCount: 1 },
    { leafletCount: 1000 },
  ]);
  expect(small?.maxLength).toBeLessThan(big?.maxLength ?? 0);
  expect(big?.maxLength).toBeLessThanOrEqual(330);
});

test("frondGeometry grows toward maxLength as visibleCount approaches totalCount", () => {
  const [placement] = placeFronds([{ leafletCount: 10 }]);
  if (!placement) throw new Error("no placement");
  const early = frondGeometry(placement, 1, 10);
  const full = frondGeometry(placement, 10, 10);
  expect(early.length).toBeLessThan(full.length);
  expect(full.length).toBeCloseTo(placement.maxLength, 5);
});

test("leafletPositions returns one point per requested count, all distinct", () => {
  const [placement] = placeFronds([{ leafletCount: 5 }]);
  if (!placement) throw new Error("no placement");
  const geom = frondGeometry(placement, 5, 5);
  const positions = leafletPositions(geom, 5);
  expect(positions).toHaveLength(5);
  const keys = new Set(positions.map((p) => `${p[0]},${p[1]}`));
  expect(keys.size).toBe(5);
});

test("strayPoint shoots 52px out and 40px down from the interrupted leaflet, per DESIGN.md", () => {
  const interrupted: [number, number] = [100, 200];
  expect(strayPoint(interrupted, 1)).toEqual([152, 240]);
  expect(strayPoint(interrupted, -1)).toEqual([48, 240]);
});

test("stemStipple is deterministic and non-empty", () => {
  const a = stemStipple();
  const b = stemStipple();
  expect(a).toEqual(b);
  expect(a[0].length).toBeGreaterThan(0);
});
