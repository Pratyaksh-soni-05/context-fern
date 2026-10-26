"""Metric-function tests against hand-computed values. See
bench/ts/metrics.ts for the identical port used by the threshold sweep,
and test_run_metrics_cross_language.py for the fixture both must agree on.

ROWS below is loaded from bench/ts/fixtures/metrics-fixture.json — the
SAME file bench/ts/metrics.test.ts loads — rather than hand-duplicated,
so the two languages can never silently drift onto different fixtures.
"""

import json
from pathlib import Path

from bench.run import compute_metrics, confusion_counts

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "ts" / "fixtures" / "metrics-fixture.json"
ROWS = json.loads(FIXTURE_PATH.read_text())


def test_action_accuracy_excludes_combine_rows():
    result = compute_metrics(ROWS)
    # 7 non-combine rows; correct: new/new, continue/continue, return/return,
    # return/return (action matches even though branch is wrong), stray/stray = 5
    # wrong: new->continue, stray->continue = 2
    assert result.n == 7
    assert result.n_combine_excluded == 1
    assert abs(result.action_accuracy - 5 / 7) < 1e-9


def test_f1_new_hand_computed():
    # truth=new: rows 0 (pred new, TP) and 2 (pred continue, FN). No other
    # row predicts "new". precision = 1/1 = 1, recall = 1/2 = 0.5
    # F1 = 2*1*0.5/(1+0.5) = 0.6666...
    result = compute_metrics(ROWS)
    assert abs(result.f1_new - 2 / 3) < 1e-9


def test_f1_continue_hand_computed():
    # truth=continue: only row 1 (pred continue, TP). "continue" is also
    # predicted for row 2 (truth new, FP) and row 6 (truth stray, FP).
    # precision = 1/3, recall = 1/1 -> F1 = 2*(1/3)*1/(1/3+1) = 0.5
    result = compute_metrics(ROWS)
    assert abs(result.f1_continue - 0.5) < 1e-9


def test_confusion_counts_hand_computed():
    main_rows = [r for r in ROWS if r["action_truth"] != "combine"]
    assert confusion_counts(main_rows, "continue") == {"tp": 1, "fp": 2, "fn": 0}
    assert confusion_counts(main_rows, "new") == {"tp": 1, "fp": 0, "fn": 1}
    assert confusion_counts(main_rows, "stray") == {"tp": 1, "fp": 0, "fn": 1}
    assert confusion_counts(main_rows, "return") == {"tp": 2, "fp": 0, "fn": 0}


def test_f1_return_hand_computed():
    # truth=return: rows 3,4, both predicted return (TP=2). No false positives
    # for "return" (nothing else predicts it). precision=1, recall=1 -> F1=1
    result = compute_metrics(ROWS)
    assert abs(result.f1_return - 1.0) < 1e-9


def test_f1_stray_hand_computed():
    # truth=stray: row 5 (pred stray, TP), row 6 (pred continue, FN).
    # precision = 1/1 = 1, recall = 1/2 = 0.5 -> F1 = 0.6666...
    result = compute_metrics(ROWS)
    assert abs(result.f1_stray - 2 / 3) < 1e-9


def test_over_carry_rate_hand_computed():
    # truth in {new, stray}: rows 0,2,5,6 (4 rows). Of those, predicted
    # "continue": rows 2 and 6 -> 2/4 = 0.5
    result = compute_metrics(ROWS)
    assert abs(result.over_carry_rate - 0.5) < 1e-9


def test_wrong_return_rate_hand_computed():
    # predicted "return": rows 3 (correct branch) and 4 (wrong branch) -> 1/2
    result = compute_metrics(ROWS)
    assert abs(result.wrong_return_rate - 0.5) < 1e-9


def test_latency_percentiles():
    result = compute_metrics(ROWS)
    # latencies across ALL 8 rows (combine included): 10..80
    assert result.latency_p50_ms == 45  # midpoint of sorted 10..80
    assert result.latency_p95_ms > result.latency_p50_ms


def test_escalation_rate_and_split_latency_percentiles_hand_computed():
    # 2 of 8 rows actually escalated (a numeric stage2_latency_ms, not
    # null) out of 8 rows that carry the field at all.
    result = compute_metrics(ROWS)
    assert abs(result.escalation_rate - 2 / 8) < 1e-9
    assert result.latency_p50_stage0_ms == 30
    assert abs(result.latency_p95_stage0_ms - 76.5) < 1e-9
    assert abs(result.latency_p50_stage2_ms - 29) < 1e-9
    assert abs(result.latency_p95_stage2_ms - 38.9) < 1e-9


def test_escalation_rate_is_zero_when_no_row_carries_the_field():
    rows = [
        {
            "action_truth": "continue",
            "predicted_action": "continue",
            "branch_id": "a",
            "predicted_branch_id": "a",
            "latency_ms": 1,
        },
    ]
    assert compute_metrics(rows).escalation_rate == 0.0


def test_f1_is_vacuously_perfect_when_an_action_never_appears():
    rows = [
        {
            "action_truth": "continue",
            "predicted_action": "continue",
            "branch_id": "a",
            "predicted_branch_id": "a",
            "latency_ms": 1,
        },
    ]
    result = compute_metrics(rows)
    assert result.f1_new == 1.0
    assert result.f1_return == 1.0
    assert result.f1_stray == 1.0
    assert result.over_carry_rate == 0.0
    assert result.wrong_return_rate == 0.0


def test_f1_is_zero_when_action_never_predicted_but_truth_exists():
    rows = [
        {
            "action_truth": "new",
            "predicted_action": "continue",
            "branch_id": "a",
            "predicted_branch_id": "a",
            "latency_ms": 1,
        },
    ]
    result = compute_metrics(rows)
    assert result.f1_new == 0.0
