import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@context-fern/core";
import type { OracleRow } from "./sweep";
import {
  buildThresholdGrid,
  gridSearch,
  leaveOneSessionOut,
  objective,
  predictRow,
  sessionsOf,
} from "./sweep";

function row(overrides: Partial<OracleRow>): OracleRow {
  return {
    stream_id: "s1",
    turn_index: 0,
    action_truth: "continue",
    branch_id: "session-a",
    variant: "hard_cut",
    signals: {
      promptEmbedding: new Float32Array([1, 0]),
      mentionedFiles: [],
      stemCosine: 0,
      frondSignals: [],
      hasCue: { new: false, return: false, stray: false },
      isShortQuestion: false,
    },
    activeFrondId: "session-a",
    hasAnyFrond: true,
    ...overrides,
  };
}

test("buildThresholdGrid only ever produces newMax strictly below continueMin", () => {
  const grid = buildThresholdGrid();
  expect(grid.length).toBeGreaterThan(0);
  for (const t of grid) {
    expect(t.newMax).toBeLessThan(t.continueMin);
  }
});

test("objective rewards F1 and penalizes over-carry — hand computed", () => {
  const metrics = {
    actionAccuracy: 0,
    f1New: 0.8,
    f1Return: 0.6,
    f1Stray: 1.0,
    overCarryRate: 0.2,
    wrongReturnRate: 0,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    n: 0,
    nCombineExcluded: 0,
  };
  // (0.8+0.6+1.0)/3 - 0.2*0.5 = 0.8 - 0.1 = 0.7
  expect(objective(metrics)).toBeCloseTo(0.7, 9);
});

test("minimalState reconstructs enough shape for decide() to see the active frond's signal", () => {
  const r = row({
    activeFrondId: "session-a",
    hasAnyFrond: true,
    signals: {
      promptEmbedding: new Float32Array([1, 0]),
      mentionedFiles: [],
      stemCosine: 0,
      frondSignals: [
        { frondId: "session-a", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
      ],
      hasCue: { new: false, return: false, stray: false },
      isShortQuestion: false,
    },
  });
  const decision = predictRow(r, DEFAULT_CONFIG);
  expect(decision.predicted_action).toBe("continue");
});

test("predictRow's predicted_branch_id is the oracle frond id directly (no mapping needed)", () => {
  const r = row({
    branch_id: "session-b",
    activeFrondId: "session-a",
    hasAnyFrond: true,
    signals: {
      promptEmbedding: new Float32Array([1, 0]),
      mentionedFiles: [],
      stemCosine: 0,
      frondSignals: [
        { frondId: "session-a", cosine: 0.02, fileOverlap: 0, combined: 0.014 },
        { frondId: "session-b", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
      ],
      hasCue: { new: false, return: false, stray: false },
      isShortQuestion: false,
    },
  });
  const prediction = predictRow(r, DEFAULT_CONFIG);
  expect(prediction.predicted_action).toBe("return");
  expect(prediction.predicted_branch_id).toBe("session-b");
});

test("sessionsOf collects distinct non-null branch ids only", () => {
  const rows = [
    row({ branch_id: "session-a" }),
    row({ branch_id: "session-b" }),
    row({ branch_id: "session-a" }),
    row({ branch_id: null }), // stray
  ];
  expect(sessionsOf(rows)).toEqual(["session-a", "session-b"]);
});

test("leave-one-session-out: dev and test never share a session; strays appear in both", () => {
  const rows = [
    row({ branch_id: "session-a", turn_index: 0 }),
    row({ branch_id: "session-b", turn_index: 1 }),
    row({ branch_id: "session-c", turn_index: 2 }),
    row({ branch_id: null, turn_index: 3 }), // stray
  ];

  const folds = leaveOneSessionOut(rows);
  expect(folds).toHaveLength(3);

  for (const fold of folds) {
    const devSessions = new Set(
      fold.dev.map((r) => r.branch_id).filter((b): b is string => b !== null),
    );
    const testSessions = new Set(
      fold.test.map((r) => r.branch_id).filter((b): b is string => b !== null),
    );

    // disjointness: no session appears on both sides
    for (const s of devSessions) expect(testSessions.has(s)).toBe(false);
    expect(devSessions.has(fold.heldOutSession)).toBe(false);
    expect(testSessions.has(fold.heldOutSession)).toBe(true);

    // the stray row (branch_id null) appears in both
    expect(fold.dev.some((r) => r.branch_id === null)).toBe(true);
    expect(fold.test.some((r) => r.branch_id === null)).toBe(true);
  }
});

test("gridSearch returns a threshold set and its metrics, not just a bare number", () => {
  const rows = [
    row({
      action_truth: "continue",
      branch_id: "session-a",
      activeFrondId: "session-a",
      signals: {
        promptEmbedding: new Float32Array([1, 0]),
        mentionedFiles: [],
        stemCosine: 0,
        frondSignals: [
          { frondId: "session-a", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
        ],
        hasCue: { new: false, return: false, stray: false },
        isShortQuestion: false,
      },
    }),
  ];
  const smallGrid = buildThresholdGrid().slice(0, 20);
  const result = gridSearch(
    rows,
    smallGrid,
    DEFAULT_CONFIG.weights,
    DEFAULT_CONFIG.cues,
  );

  expect(result.thresholds).toBeDefined();
  expect(Number.isFinite(result.score)).toBe(true);
  expect(result.metrics.n).toBe(1);
});
