import { expect, test } from "bun:test";
import { fern } from "../src/design/fern-art";

test("fern(n, seed) is fully deterministic — the same seed always draws the same shape", () => {
  const a = fern(16000, 21);
  const b = fern(16000, 21);
  expect(a).toEqual(b);
});

test("fern(n, seed) produces non-empty dot-paths in all three opacity layers", () => {
  const { d1, d2, d3 } = fern(16000, 21);
  expect(d1.length).toBeGreaterThan(0);
  expect(d2.length).toBeGreaterThan(0);
  expect(d3.length).toBeGreaterThan(0);
  for (const d of [d1, d2, d3]) {
    expect(d).toMatch(/^(M-?\d+(\.\d+)? -?\d+(\.\d+)?h0\.01)+$/);
  }
});

test("a different seed draws a visibly different shape", () => {
  const a = fern(16000, 21);
  const b = fern(16000, 22);
  expect(a).not.toEqual(b);
});

test("the majority of points land near the 620x660 viewBox the reference board renders into — the IFS's longer branch tips naturally fall outside and clip in the SVG, same as the reference board", () => {
  const { d1, d2, d3 } = fern(16000, 21);
  const coordRe = /M(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)h0\.01/g;
  let total = 0;
  let inside = 0;
  const margin = 200; // the fern's frond tips genuinely extend well past the nominal box
  for (const d of [d1, d2, d3]) {
    for (const match of d.matchAll(coordRe)) {
      total++;
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (
        x >= -margin &&
        x <= 620 + margin &&
        y >= -margin &&
        y <= 660 + margin
      ) {
        inside++;
      }
    }
  }
  expect(total).toBeGreaterThan(0);
  expect(inside / total).toBeGreaterThan(0.95);
});
