import { expect, test } from "bun:test";
import { applyDecision, emptyState } from "../../src/router/state";
import type {
  FrondState,
  RouterDecision,
  RouterState,
} from "../../src/router/types";

function decision(partial: Partial<RouterDecision>): RouterDecision {
  return {
    action: "continue",
    target: null,
    confidence: 1,
    signals: [],
    stage: 0,
    ...partial,
  };
}

function frondOf(state: RouterState, id: string): FrondState {
  const frond = state.fronds[id];
  if (!frond) throw new Error(`expected frond ${id} to exist`);
  return frond;
}

test("new creates a fresh active frond and rests the previous one", () => {
  let state = emptyState();
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [1, 0],
    ["a.ts"],
    "frond-1",
  );

  expect(state.activeFrondId).toBe("frond-1");
  expect(frondOf(state, "frond-1").centroid).toEqual([1, 0]);
  expect(frondOf(state, "frond-1").count).toBe(1);
  expect(frondOf(state, "frond-1").files).toEqual(["a.ts"]);
  expect(frondOf(state, "frond-1").status).toBe("active");

  state = applyDecision(
    state,
    decision({ action: "new" }),
    [0, 1],
    ["b.ts"],
    "frond-2",
  );
  expect(state.activeFrondId).toBe("frond-2");
  expect(frondOf(state, "frond-1").status).toBe("resting");
  expect(frondOf(state, "frond-2").status).toBe("active");
});

test("continue updates the active frond's running mean and file set", () => {
  let state = emptyState();
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [2, 4],
    [],
    "frond-1",
  );
  state = applyDecision(
    state,
    decision({ action: "continue", target: "frond-1" }),
    [4, 8],
    ["x.py"],
  );

  expect(frondOf(state, "frond-1").centroid).toEqual([3, 6]); // mean of [2,4] and [4,8]
  expect(frondOf(state, "frond-1").count).toBe(2);
  expect(frondOf(state, "frond-1").files).toEqual(["x.py"]);
  expect(state.activeFrondId).toBe("frond-1");
});

test("return reactivates the target frond, rests the previously-active one, and updates target state", () => {
  let state = emptyState();
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [1, 0],
    ["a.ts"],
    "frond-1",
  );
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [0, 1],
    ["b.ts"],
    "frond-2",
  );

  state = applyDecision(
    state,
    decision({ action: "return", target: "frond-1" }),
    [1, 2],
    ["c.ts"],
  );

  expect(state.activeFrondId).toBe("frond-1");
  expect(frondOf(state, "frond-1").status).toBe("active");
  expect(frondOf(state, "frond-1").files).toEqual(["a.ts", "c.ts"]);
  expect(frondOf(state, "frond-2").status).toBe("resting");
});

test("combine updates only the primary target, not the `with` frond", () => {
  let state = emptyState();
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [1, 0],
    [],
    "frond-1",
  );
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [0, 1],
    [],
    "frond-2",
  );
  const before2 = frondOf(state, "frond-2");

  state = applyDecision(
    state,
    decision({ action: "combine", target: "frond-1", with: "frond-2" }),
    [5, 5],
    ["combined.ts"],
  );

  expect(state.activeFrondId).toBe("frond-1");
  expect(frondOf(state, "frond-1").files).toContain("combined.ts");
  // frond-2 rests (only one frond is ever active), but its own content
  // (centroid/count/files) is untouched by the combine.
  expect(frondOf(state, "frond-2").status).toBe("resting");
  expect(frondOf(state, "frond-2").centroid).toEqual(before2.centroid);
  expect(frondOf(state, "frond-2").count).toBe(before2.count);
  expect(frondOf(state, "frond-2").files).toEqual(before2.files);
});

test("stray is a complete no-op on state", () => {
  let state = emptyState();
  state = applyDecision(
    state,
    decision({ action: "new" }),
    [1, 0],
    ["a.ts"],
    "frond-1",
  );
  const before: RouterState = JSON.parse(JSON.stringify(state));

  const after = applyDecision(
    state,
    decision({ action: "stray" }),
    [9, 9],
    ["should-not-appear.ts"],
  );

  expect(after).toEqual(before);
});

test("new without a supplied frond id throws rather than silently inventing one", () => {
  const state = emptyState();
  expect(() =>
    applyDecision(state, decision({ action: "new" }), [1, 0], []),
  ).toThrow();
});
