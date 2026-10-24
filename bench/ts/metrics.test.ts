import { expect, test } from "bun:test";
import { computeMetrics, type MetricsRow } from "./metrics";

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

test("F1 for new/return/stray match the hand-computed Python values", async () => {
  const result = computeMetrics(await loadRows());
  expect(result.f1New).toBeCloseTo(2 / 3, 9);
  expect(result.f1Return).toBeCloseTo(1.0, 9);
  expect(result.f1Stray).toBeCloseTo(2 / 3, 9);
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
