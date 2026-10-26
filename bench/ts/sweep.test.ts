import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@context-fern/core";
import { computeMetrics, type MetricsRow } from "./metrics";
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

test("objective is macroF1 over continue/new/return/stray minus a 2x-weighted false-new/stray cost — hand computed", () => {
  // 2 correct continues, 1 correct new, 1 missed new (FN, truth new ->
  // predicted continue, costs 1x), 1 false new (FP, truth continue ->
  // predicted new, costs 2x), 1 correct stray. No return rows at all,
  // so f1Return is vacuously 1.
  const rows: MetricsRow[] = [
    {
      action_truth: "continue",
      predicted_action: "continue",
      branch_id: "a",
      predicted_branch_id: "a",
      latency_ms: null,
    },
    {
      action_truth: "continue",
      predicted_action: "continue",
      branch_id: "a",
      predicted_branch_id: "a",
      latency_ms: null,
    },
    {
      action_truth: "new",
      predicted_action: "new",
      branch_id: "b",
      predicted_branch_id: "b",
      latency_ms: null,
    },
    {
      action_truth: "new",
      predicted_action: "continue",
      branch_id: "c",
      predicted_branch_id: "a",
      latency_ms: null,
    },
    {
      action_truth: "continue",
      predicted_action: "new",
      branch_id: "a",
      predicted_branch_id: "d",
      latency_ms: null,
    },
    {
      action_truth: "stray",
      predicted_action: "stray",
      branch_id: null,
      predicted_branch_id: null,
      latency_ms: null,
    },
  ];
  const metrics = computeMetrics(rows);
  // f1Continue = 2/3 (tp=2,fp=1,fn=1), f1New = 1/2 (tp=1,fp=1,fn=1),
  // f1Stray = 1 (tp=1,fp=0,fn=0), f1Return = 1 (vacuous, never appears).
  // macroF1 = (2/3 + 1/2 + 1 + 1) / 4 = 19/24
  // cost = (2*(fp_new=1 + fp_stray=0) + (fn_new=1 + fn_stray=0)) / n=6 = 3/6 = 1/2
  // objective = 19/24 - 1/2 = 7/24
  expect(objective(rows, metrics)).toBeCloseTo(7 / 24, 9);
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
