"""Unit tests for bench eval-stage2's pure helper functions in bench.cli —
the subprocess-shelling command functions themselves (_cmd_eval_stage2)
need bun + a running Ollama server, so they're exercised directly by
`bench eval-stage2`, not here."""

import json

from bench.cli import (
    DEFAULT_ESCALATION_HIGH,
    DEFAULT_ESCALATION_LOW,
    _band_sweep_for_gate,
    _count_lines,
    _load_checkpoint,
    _read_escalation_band,
    _read_journal_tokens,
    _row_id,
    _safe_model_name,
    _simulate_band,
    _stratified_sample_ids,
)


def _write_jsonl(path, rows):
    path.write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n",
        encoding="utf-8",
    )


def test_count_lines_ignores_blank_lines(tmp_path):
    path = tmp_path / "streams.jsonl"
    path.write_text("a\nb\n\nc\n\n", encoding="utf-8")
    assert _count_lines(path) == 3


def test_safe_model_name_strips_colons_and_dots():
    assert _safe_model_name("qwen3.5:9b") == "qwen3-5-9b"


def test_row_id_combines_stream_id_and_turn_index():
    assert _row_id({"stream_id": "s1", "turn_index": 7}) == "s1#7"


def test_load_checkpoint_missing_file_returns_empty_dict(tmp_path):
    assert _load_checkpoint(tmp_path / "missing.jsonl") == {}


def test_load_checkpoint_keys_by_row_id_and_later_lines_win(tmp_path):
    path = tmp_path / "checkpoint.jsonl"
    _write_jsonl(
        path,
        [
            {"stream_id": "s1", "turn_index": 0, "predicted_action": "continue"},
            {"stream_id": "s1", "turn_index": 1, "predicted_action": "new"},
            # a duplicate append for turn 0 (e.g. from a re-run) overwrites
            # the earlier value rather than creating a second entry
            {"stream_id": "s1", "turn_index": 0, "predicted_action": "stray"},
        ],
    )
    done = _load_checkpoint(path)
    assert set(done.keys()) == {"s1#0", "s1#1"}
    assert done["s1#0"]["predicted_action"] == "stray"
    assert done["s1#1"]["predicted_action"] == "new"


def test_stratified_sample_ids_represents_every_group_and_is_deterministic(tmp_path):
    path = tmp_path / "streams.jsonl"
    rows = []
    for i in range(10):
        rows.append(
            {"stream_id": "s1", "turn_index": i, "variant": "hard_cut", "action_truth": "continue"}
        )
    for i in range(10, 12):
        rows.append(
            {"stream_id": "s1", "turn_index": i, "variant": "hard_cut", "action_truth": "new"}
        )
    rows.append({"stream_id": "s2", "turn_index": 0, "variant": "stray", "action_truth": "stray"})
    _write_jsonl(path, rows)

    sample = _stratified_sample_ids(path, sample_size=6, seed=7)

    assert len(sample) == 6
    # the rare group (1 row total) must still be represented
    assert "s2#0" in sample
    # at least one "new" turn (2 rows total) must be represented
    assert any(tid in sample for tid in ("s1#10", "s1#11"))

    again = _stratified_sample_ids(path, sample_size=6, seed=7)
    assert sample == again

    different_seed = _stratified_sample_ids(path, sample_size=6, seed=8)
    assert different_seed != sample or len(different_seed) != len(sample)


def test_stratified_sample_ids_caps_at_available_rows(tmp_path):
    path = tmp_path / "streams.jsonl"
    _write_jsonl(
        path,
        [{"stream_id": "s1", "turn_index": 0, "variant": "v", "action_truth": "continue"}],
    )
    sample = _stratified_sample_ids(path, sample_size=500, seed=1)
    assert sample == ["s1#0"]


def test_simulate_band_keeps_in_band_rows_and_reverts_out_of_band_rows():
    rows = [
        {
            "predicted_action": "stray",  # the (forced) Stage 2 answer
            "stage0_predicted_action": "continue",
            "stage0_confidence": 0.3,  # inside [0.2, 0.4]
        },
        {
            "predicted_action": "new",  # the (forced) Stage 2 answer
            "stage0_predicted_action": "continue",
            "stage0_confidence": 0.9,  # outside [0.2, 0.4]
        },
    ]
    simulated = _simulate_band(rows, 0.2, 0.4)
    assert simulated[0]["predicted_action"] == "stray"  # in-band: keeps Stage 2's answer
    assert simulated[1]["predicted_action"] == "continue"  # out-of-band: reverts to Stage 0


def test_band_sweep_for_gate_finds_the_lowest_escalation_band_that_clears_both_bars():
    # 10 "new" truths: 9 need escalation (stage0 got them wrong, confidence
    # 0.9) to be fixed by the (forced) Stage 2 answer; 1 Stage 0 already
    # gets right regardless (confidence 0.05, outside every candidate band
    # tested here). 10 "stray" truths, all fixed by escalation at
    # confidence 0.9 too. A band covering 0.9 clears both F1 gates;
    # anything that excludes 0.9 does not.
    rows = []
    for i in range(9):
        rows.append(
            {
                "action_truth": "new",
                "predicted_action": "new",
                "stage0_predicted_action": "continue",
                "stage0_confidence": 0.9,
                "branch_id": f"b{i}",
                "predicted_branch_id": f"b{i}",
            }
        )
    rows.append(
        {
            "action_truth": "new",
            "predicted_action": "new",
            "stage0_predicted_action": "new",
            "stage0_confidence": 0.05,
            "branch_id": "b9",
            "predicted_branch_id": "b9",
        }
    )
    for i in range(10):
        rows.append(
            {
                "action_truth": "stray",
                "predicted_action": "stray",
                "stage0_predicted_action": "continue",
                "stage0_confidence": 0.9,
                "branch_id": None,
                "predicted_branch_id": None,
            }
        )

    band = _band_sweep_for_gate(rows)
    assert band is not None
    assert band["low"] <= 0.9 <= band["high"]
    assert band["f1_new"] >= 0.85
    assert band["f1_stray"] >= 0.80


def test_band_sweep_for_gate_returns_none_when_no_band_clears_the_bars():
    # Stage 0 and Stage 2 agree on every row and both are wrong half the
    # time — no band can fix a disagreement that doesn't exist.
    rows = [
        {
            "action_truth": "new",
            "predicted_action": "continue",
            "stage0_predicted_action": "continue",
            "stage0_confidence": 0.5,
            "branch_id": "a",
            "predicted_branch_id": "a",
        }
        for _ in range(10)
    ]
    assert _band_sweep_for_gate(rows) is None


def test_read_journal_tokens_averages_across_entries(tmp_path):
    path = tmp_path / "journal.jsonl"
    _write_jsonl(
        path,
        [
            {"inputTokens": 100, "outputTokens": 10},
            {"inputTokens": 200, "outputTokens": 20},
        ],
    )
    n, avg_in, avg_out = _read_journal_tokens(path)
    assert n == 2
    assert avg_in == 150
    assert avg_out == 15


def test_read_journal_tokens_missing_file_returns_zeros(tmp_path):
    n, avg_in, avg_out = _read_journal_tokens(tmp_path / "missing.jsonl")
    assert (n, avg_in, avg_out) == (0, 0.0, 0.0)


def test_read_escalation_band_defaults_without_a_config_file():
    assert _read_escalation_band(None) == (DEFAULT_ESCALATION_LOW, DEFAULT_ESCALATION_HIGH)


def test_read_escalation_band_reads_toml_section(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("[escalation]\nlow = 0.2\nhigh = 0.6\n", encoding="utf-8")
    assert _read_escalation_band(path) == (0.2, 0.6)
