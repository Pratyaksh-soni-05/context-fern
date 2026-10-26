import { expect, test } from "bun:test";
import { computeMetrics, confusionCounts, type MetricsRow } from "./metrics";

const FIXTURE = new URL("./fixtures/metrics-fixture.json", import.meta.url);

async function loadRows(): Promise<MetricsRow[]> {
  return JSON.parse(await Bun.file(FIXTURE).text());
}

// Same fixture, same hand-computed expectations as bench/tests/test_run.py —
// this is the cross-language consistency check: if the Python and TS
// implementations ever drift, at least one of these two suites fails.

test("action accuracy excludes combine rows", async () => {
  const result = computeMetrics(await loadRows());
  expect(result.n).toBe(7);
  expect(result.nCombineExcluded).toBe(1);
  expect(result.actionAccuracy).toBeCloseTo(5 / 7, 9);
});

test("F1 for continue/new/return/stray match the hand-computed Python values", async () => {
  const result = computeMetrics(await loadRows());
  expect(result.f1Continue).toBeCloseTo(0.5, 9);
  expect(result.f1New).toBeCloseTo(2 / 3, 9);
  expect(result.f1Return).toBeCloseTo(1.0, 9);
  expect(result.f1Stray).toBeCloseTo(2 / 3, 9);
});

test("confusionCounts matches the hand-computed tp/fp/fn for continue and new", async () => {
  const rows = await loadRows();
  const mainRows = rows.filter((r) => r.action_truth !== "combine");
  expect(confusionCounts(mainRows, "continue")).toEqual({
    tp: 1,
    fp: 2,
    fn: 0,
  });
  expect(confusionCounts(mainRows, "new")).toEqual({ tp: 1, fp: 0, fn: 1 });
  expect(confusionCounts(mainRows, "stray")).toEqual({ tp: 1, fp: 0, fn: 1 });
  expect(confusionCounts(mainRows, "return")).toEqual({ tp: 2, fp: 0, fn: 0 });
});

test("over-carry and wrong-return rates match the hand-computed Python values", async () => {
  const result = computeMetrics(await loadRows());
  expect(result.overCarryRate).toBeCloseTo(0.5, 9);
  expect(result.wrongReturnRate).toBeCloseTo(0.5, 9);
});

test("latency percentiles match the hand-computed Python values", async () => {
  const result = computeMetrics(await loadRows());
  expect(result.latencyP50Ms).toBe(45);
  expect(result.latencyP95Ms).toBeGreaterThan(result.latencyP50Ms);
});

test("escalation rate and split stage0/stage2 latency percentiles match hand-computed values", async () => {
  const result = computeMetrics(await loadRows());
  // 2 of 8 rows actually escalated (rows with stage2_latency_ms a number,
  // not null) out of 8 rows that carry the field at all.
  expect(result.escalationRate).toBeCloseTo(2 / 8, 9);
  expect(result.latencyP50Stage0Ms).toBe(30);
  expect(result.latencyP95Stage0Ms).toBeCloseTo(76.5, 9);
  expect(result.latencyP50Stage2Ms).toBeCloseTo(29, 9);
  expect(result.latencyP95Stage2Ms).toBeCloseTo(38.9, 9);
});

test("escalation rate is 0 when no row carries a stage2_latency_ms field at all (plain Stage 0 output)", () => {
  const rows: MetricsRow[] = [
    {
      action_truth: "continue",
      predicted_action: "continue",
      branch_id: "a",
      predicted_branch_id: "a",
      latency_ms: 1,
    },
  ];
  expect(computeMetrics(rows).escalationRate).toBe(0);
});

test("F1 is vacuously perfect when an action never appears as truth or prediction", () => {
  const rows: MetricsRow[] = [
    {
      action_truth: "continue",
      predicted_action: "continue",
      branch_id: "a",
      predicted_branch_id: "a",
      latency_ms: 1,
    },
  ];
  const result = computeMetrics(rows);
  expect(result.f1New).toBe(1);
  expect(result.f1Return).toBe(1);
  expect(result.f1Stray).toBe(1);
});

test("F1 is zero when an action is never predicted but truth exists", () => {
  const rows: MetricsRow[] = [
    {
      action_truth: "new",
      predicted_action: "continue",
      branch_id: "a",
      predicted_branch_id: "a",
      latency_ms: 1,
    },
  ];
  expect(computeMetrics(rows).f1New).toBe(0);
});
