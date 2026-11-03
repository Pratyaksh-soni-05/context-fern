import { expect, test } from "bun:test";
import { renderTree } from "../src/tree-render";

// NO_COLOR + non-TTY stdout in test runs means useColor() is already
// false — these assertions check the plain-text shape, which is what
// matters: the exact box-drawing characters and column alignment from
// docs/design/blueprint/Install.dc.html's First-run board.

test("renders the exact ASCII shape from the First-run board, with real (not sample) roots data", () => {
  const out = renderTree({
    stemName: "main",
    fronds: [
      {
        name: "auth-refactor",
        status: "active",
        leafletCount: 7,
        colorIndex: 0,
      },
      {
        name: "docker-build",
        status: "resting",
        leafletCount: 4,
        colorIndex: 1,
      },
      { name: "flaky-test", status: "merged", leafletCount: 3, colorIndex: 2 },
      { name: "readme", status: "resting", leafletCount: 2, colorIndex: 3 },
    ],
    strayCount: 3,
  });

  expect(out).toBe(
    [
      "main ─┬─ auth-refactor  ●●●●●●●  active",
      "      ├─ docker-build   ●●●●",
      "      ├─ flaky-test     ●●●  merged",
      "      ├─ readme         ●●",
      "      └╌ strays         ○○○",
      "roots: 0 memories",
    ].join("\n"),
  );
});

test("roots pluralizes 'memory' correctly at exactly 1", () => {
  const out = renderTree({
    stemName: "main",
    fronds: [],
    strayCount: 0,
    rootsCount: 1,
  });
  expect(out).toBe(["main ─┬─ strays  ", "roots: 1 memory"].join("\n"));
});

test("an empty fern (just the stem) attaches the strays row directly", () => {
  const out = renderTree({ stemName: "main", fronds: [], strayCount: 0 });
  expect(out).toBe(["main ─┬─ strays  ", "roots: 0 memories"].join("\n"));
});

test("column width adapts to the longest frond name", () => {
  const out = renderTree({
    stemName: "x",
    fronds: [
      {
        name: "a-very-long-topic-name",
        status: "active",
        leafletCount: 1,
        colorIndex: 0,
      },
    ],
    strayCount: 0,
  });
  const lines = out.split("\n");
  expect(lines[0]).toBe("x ─┬─ a-very-long-topic-name  ●  active");
});
