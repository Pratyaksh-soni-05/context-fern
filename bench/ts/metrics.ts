// Identical port of bench/src/bench/run.py's compute_metrics, used by the
// threshold sweep's grid search (bench/ts/sweep.ts), which must stay in
// TypeScript — see docs/decisions.md on why decide() can't be ported.
// Kept honest against the Python version by metrics.test.ts and
// bench/tests/test_run.py loading the exact same fixture
// (bench/ts/fixtures/metrics-fixture.json).

export interface MetricsRow {
  action_truth: string;
  predicted_action: string;
  branch_id: string | null;
  predicted_branch_id: string | null;
  latency_ms: number | null;
}

export interface MetricsResult {
  actionAccuracy: number;
  f1New: number;
  f1Return: number;
  f1Stray: number;
  overCarryRate: number;
  wrongReturnRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  n: number;
  nCombineExcluded: number;
}

function percentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] as number;
  const k = (sortedValues.length - 1) * (pct / 100);
  const f = Math.floor(k);
  const c = Math.min(f + 1, sortedValues.length - 1);
  if (f === c) return sortedValues[f] as number;
  const d0 = (sortedValues[f] as number) * (c - k);
  const d1 = (sortedValues[c] as number) * (k - f);
  return d0 + d1;
}

function f1(rows: readonly MetricsRow[], action: string): number {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    if (r.predicted_action === action && r.action_truth === action) tp++;
    else if (r.predicted_action === action && r.action_truth !== action) fp++;
    else if (r.predicted_action !== action && r.action_truth === action) fn++;
  }
  if (tp + fp + fn === 0) return 1; // action never appears as truth or prediction
  if (tp === 0) return 0;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  return (2 * precision * recall) / (precision + recall);
}

function overCarryRate(rows: readonly MetricsRow[]): number {
  const relevant = rows.filter(
    (r) => r.action_truth === "new" || r.action_truth === "stray",
  );
  if (relevant.length === 0) return 0;
  const carried = relevant.filter(
    (r) => r.predicted_action === "continue",
  ).length;
  return carried / relevant.length;
}

function wrongReturnRate(rows: readonly MetricsRow[]): number {
  const returns = rows.filter((r) => r.predicted_action === "return");
  if (returns.length === 0) return 0;
  const wrong = returns.filter(
    (r) => r.predicted_branch_id !== r.branch_id,
  ).length;
  return wrong / returns.length;
}

export function computeMetrics(rows: readonly MetricsRow[]): MetricsResult {
  const combineRows = rows.filter((r) => r.action_truth === "combine");
  const mainRows = rows.filter((r) => r.action_truth !== "combine");

  const correct = mainRows.filter(
    (r) => r.predicted_action === r.action_truth,
  ).length;
  const accuracy = mainRows.length > 0 ? correct / mainRows.length : 0;

  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((l): l is number => l !== null && l !== undefined)
    .sort((a, b) => a - b);

  return {
    actionAccuracy: accuracy,
    f1New: f1(mainRows, "new"),
    f1Return: f1(mainRows, "return"),
    f1Stray: f1(mainRows, "stray"),
    overCarryRate: overCarryRate(mainRows),
    wrongReturnRate: wrongReturnRate(mainRows),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    n: mainRows.length,
    nCombineExcluded: combineRows.length,
  };
}
