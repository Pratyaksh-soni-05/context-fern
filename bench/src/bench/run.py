"""Router evaluation metrics: action accuracy, F1 per action, over-carry,
wrong-return rate, latency percentiles.

Pure functions over already-joined prediction+truth rows (each row needs
at least action_truth, predicted_action, branch_id, predicted_branch_id,
latency_ms). This module is the orchestrator and report writer for
`bench eval`; the actual thresholds grid search runs in TypeScript (see
bench/ts/sweep.ts and docs/decisions.md for why) — bench/ts/metrics.ts is
an identical port of compute_metrics used there, kept honest by a
cross-language test against the same fixture (test_run.py /
test_run_metrics_cross_language).

combine rows are reported separately and excluded from the headline
action_accuracy: Stage 0 has no mechanism to predict combine in this PR
(see docs/decisions.md), so counting them would just be a permanent,
uninteresting miss baked into every other number.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class MetricsResult:
    action_accuracy: float
    f1_new: float
    f1_return: float
    f1_stray: float
    over_carry_rate: float
    wrong_return_rate: float
    latency_p50_ms: float
    latency_p95_ms: float
    n: int
    n_combine_excluded: int

    def to_dict(self) -> dict:
        return {
            "action_accuracy": self.action_accuracy,
            "f1_new": self.f1_new,
            "f1_return": self.f1_return,
            "f1_stray": self.f1_stray,
            "over_carry_rate": self.over_carry_rate,
            "wrong_return_rate": self.wrong_return_rate,
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
            "n": self.n,
            "n_combine_excluded": self.n_combine_excluded,
        }


def _percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * (pct / 100)
    f = int(k)
    c = min(f + 1, len(sorted_values) - 1)
    if f == c:
        return sorted_values[f]
    d0 = sorted_values[f] * (c - k)
    d1 = sorted_values[c] * (k - f)
    return d0 + d1


def _f1(rows: list[dict], action: str) -> float:
    tp = sum(1 for r in rows if r["predicted_action"] == action and r["action_truth"] == action)
    fp = sum(1 for r in rows if r["predicted_action"] == action and r["action_truth"] != action)
    fn = sum(1 for r in rows if r["predicted_action"] != action and r["action_truth"] == action)
    if tp + fp + fn == 0:
        return 1.0  # action never appears as truth or prediction: vacuously perfect
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def _over_carry_rate(rows: list[dict]) -> float:
    relevant = [r for r in rows if r["action_truth"] in ("new", "stray")]
    if not relevant:
        return 0.0
    carried = sum(1 for r in relevant if r["predicted_action"] == "continue")
    return carried / len(relevant)


def _wrong_return_rate(rows: list[dict]) -> float:
    returns = [r for r in rows if r["predicted_action"] == "return"]
    if not returns:
        return 0.0
    wrong = sum(1 for r in returns if r.get("predicted_branch_id") != r.get("branch_id"))
    return wrong / len(returns)


def compute_metrics(rows: list[dict]) -> MetricsResult:
    combine_rows = [r for r in rows if r["action_truth"] == "combine"]
    main_rows = [r for r in rows if r["action_truth"] != "combine"]

    correct = sum(1 for r in main_rows if r["predicted_action"] == r["action_truth"])
    accuracy = correct / len(main_rows) if main_rows else 0.0

    latencies = sorted(r["latency_ms"] for r in rows if r.get("latency_ms") is not None)

    return MetricsResult(
        action_accuracy=accuracy,
        f1_new=_f1(main_rows, "new"),
        f1_return=_f1(main_rows, "return"),
        f1_stray=_f1(main_rows, "stray"),
        over_carry_rate=_over_carry_rate(main_rows),
        wrong_return_rate=_wrong_return_rate(main_rows),
        latency_p50_ms=_percentile(latencies, 50),
        latency_p95_ms=_percentile(latencies, 95),
        n=len(main_rows),
        n_combine_excluded=len(combine_rows),
    )


REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_ENTRY = REPO_ROOT / "packages" / "cli" / "src" / "index.ts"


def run_route_replay(
    stream_file: Path, mode: str = "full", config_file: Path | None = None
) -> list[dict]:
    """Shells out to the real TS CLI (`fern route --replay`), which does
    genuine online/causal replay with the real embedder. Not part of the
    hermetic pytest suite (needs bun + the cached model) — exercised
    directly by `bench eval`."""
    args = ["bun", "run", str(CLI_ENTRY), "route", "--replay", str(stream_file), "--mode", mode]
    if config_file:
        args.extend(["--config", str(config_file)])
    result = subprocess.run(args, capture_output=True, text=True, cwd=REPO_ROOT)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"fern route --replay failed (mode={mode}): {result.returncode}")
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def join_predictions_with_truth(stream_file: Path, predictions: list[dict]) -> list[dict]:
    """Predictions already carry action_truth/branch_id (route --replay
    passes them through) alongside predicted_action/predicted_branch_id,
    so no separate join against the raw streams file is actually needed —
    this just renames for clarity at the call site."""
    rows = []
    for p in predictions:
        rows.append(
            {
                "stream_id": p["stream_id"],
                "turn_index": p["turn_index"],
                "variant": p["variant"],
                "action_truth": p["action_truth"],
                "predicted_action": p["predicted_action"],
                "branch_id": p.get("branch_id"),
                "predicted_branch_id": p.get("predicted_branch_id"),
                "latency_ms": p.get("latency_ms"),
            }
        )
    return rows
