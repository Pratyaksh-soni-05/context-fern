import hashlib
import json
import random
from pathlib import Path

from bench.splice import (
    ALL_VARIANTS,
    build_combine,
    build_return_at_distance,
    excluded_sessions,
    load_branch_segments,
    splice,
    splice_to_file,
)

FIXTURES = Path(__file__).parent / "fixtures" / "splice_sessions"
STRAYS_MINI = Path(__file__).parent / "fixtures" / "strays_mini.txt"

CUE_MARKERS = ("switching to", "back to", "side question about", "let's return to")


def _assert_truth_invariants(turns):
    """Truth is a per-segment-boundary property, independent of shuffle order.

    Synthetic rows (stray, combine's final turn) are excluded by the caller
    before this is applied — they don't participate in segment-boundary truth.
    """
    seen = set()
    prev_branch = None
    for i, t in enumerate(turns):
        is_boundary = prev_branch is None or t.branch_id != prev_branch
        if is_boundary:
            expected = "return" if t.branch_id in seen else "new"
            msg = f"turn {i}: expected {expected}, got {t.action_truth}"
            assert t.action_truth == expected, msg
            seen.add(t.branch_id)
        else:
            assert t.action_truth == "continue", f"turn {i}: expected continue"
        prev_branch = t.branch_id


def _write_session(directory: Path, session_id: str, num_exchanges: int) -> None:
    lines = []
    for i in range(num_exchanges):
        lines.append(
            json.dumps(
                {
                    "type": "user",
                    "sessionId": session_id,
                    "isSidechain": False,
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": f"{session_id} message {i}"}],
                    },
                }
            )
        )
        lines.append(
            json.dumps(
                {
                    "type": "assistant",
                    "sessionId": session_id,
                    "isSidechain": False,
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
                }
            )
        )
    (directory / f"{session_id}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _make_pool(tmp_path: Path) -> Path:
    """5 qualifying sessions (>=6 exchanges) and 2 excluded ones (<6)."""
    d = tmp_path / "pool"
    d.mkdir()
    for i in range(1, 6):
        _write_session(d, f"q{i}", num_exchanges=6 + i)  # 7..11
    _write_session(d, "x1", num_exchanges=2)
    _write_session(d, "x2", num_exchanges=3)
    return d


# --- existing behaviour, unchanged fixtures, no min_exchanges/streams passed ---


def test_load_branch_segments_cuts_in_order():
    branches = load_branch_segments(FIXTURES, segment_len=2)
    assert set(branches) == {"branch-one", "branch-two", "branch-three"}
    one = branches["branch-one"]
    assert [len(s.exchanges) for s in one] == [2, 1]
    assert one[0].exchanges[0].prompt_text == "topic one message a"
    assert one[1].exchanges[0].prompt_text == "topic one message c"


def test_hard_cut_truth_matches_segment_boundaries():
    results = splice(FIXTURES, k=3, variants=["hard_cut"], seed=7, segment_len=2)
    turns = results["hard_cut"]
    assert len(turns) == 7  # 3 + 2 + 2 exchanges total
    _assert_truth_invariants(turns)
    assert [t.turn_index for t in turns] == list(range(7))


def test_cue_phrase_prefixes_segment_starts_except_the_very_first():
    results = splice(FIXTURES, k=3, variants=["cue_phrase"], seed=7, segment_len=2)
    turns = results["cue_phrase"]
    _assert_truth_invariants(turns)

    prev_branch = None
    for i, t in enumerate(turns):
        is_boundary = prev_branch is None or t.branch_id != prev_branch
        has_cue = any(marker in t.turn["prompt_text"] for marker in CUE_MARKERS)
        if is_boundary and i > 0:
            assert has_cue, f"turn {i} is a non-first segment boundary but has no cue"
        if not is_boundary:
            assert not has_cue
        prev_branch = t.branch_id
    assert not any(marker in turns[0].turn["prompt_text"] for marker in CUE_MARKERS)


def test_return_at_distance_exact_gap():
    branches = load_branch_segments(FIXTURES, segment_len=1)
    turns = build_return_at_distance(
        "s", branches, k=3, distance=2, rng=random.Random("fixed")
    )
    _assert_truth_invariants(turns)

    one_positions = [i for i, t in enumerate(turns) if t.branch_id == "branch-one"]
    assert len(one_positions) >= 2
    gap = one_positions[1] - one_positions[0] - 1
    assert gap == 2
    assert turns[one_positions[1]].action_truth == "return"


def test_combine_appends_one_synthetic_turn_needing_two_branches():
    branches = load_branch_segments(FIXTURES, segment_len=2)
    turns = build_combine("s", branches, k=3, rng=random.Random("fixed"))

    last = turns[-1]
    assert last.action_truth == "combine"
    assert last.turn["prompt_text"].startswith("[synthetic]")
    assert last.synthetic is True
    assert last.combine_with is not None
    assert len(last.combine_with) == 1
    assert last.combine_with[0] != last.branch_id
    assert {last.branch_id, last.combine_with[0]} <= {"branch-one", "branch-two", "branch-three"}

    # every non-synthetic turn still obeys normal segment-boundary truth
    _assert_truth_invariants(turns[:-1])


def test_same_seed_is_byte_identical_different_seed_is_not(tmp_path: Path):
    out_a = tmp_path / "a.jsonl"
    out_b = tmp_path / "b.jsonl"
    out_c = tmp_path / "c.jsonl"

    splice_to_file(FIXTURES, out_a, k=3, variant_arg="all", seed=7, segment_len=2)
    splice_to_file(FIXTURES, out_b, k=3, variant_arg="all", seed=7, segment_len=2)
    splice_to_file(FIXTURES, out_c, k=3, variant_arg="all", seed=99, segment_len=2)

    assert out_a.read_bytes() == out_b.read_bytes()
    assert out_a.read_bytes() != out_c.read_bytes()


# --- new: min-exchanges filter, shared pool, streams, stray, manifest ---


def test_min_exchanges_excludes_short_sessions_and_counts_them(tmp_path: Path):
    pool_dir = _make_pool(tmp_path)

    branches = load_branch_segments(pool_dir, segment_len=4, min_exchanges=6)
    assert set(branches) == {"q1", "q2", "q3", "q4", "q5"}

    excluded = excluded_sessions(pool_dir, min_exchanges=6)
    assert excluded == ["x1", "x2"]


def test_variants_share_one_pool_and_never_draw_excluded_sessions(tmp_path: Path):
    pool_dir = _make_pool(tmp_path)

    results = splice(
        pool_dir,
        k=2,
        variants=["hard_cut", "combine", "return_at_distance"],
        seed=11,
        segment_len=3,
        min_exchanges=6,
        streams=4,
    )

    seen_branches: set[str] = set()
    for turns in results.values():
        for t in turns:
            if t.branch_id is not None:
                seen_branches.add(t.branch_id)
            if t.combine_with:
                seen_branches.update(t.combine_with)

    assert seen_branches <= {"q1", "q2", "q3", "q4", "q5"}
    assert not seen_branches & {"x1", "x2"}


def test_streams_n_generates_n_streams_per_variant(tmp_path: Path):
    pool_dir = _make_pool(tmp_path)

    results = splice(
        pool_dir, k=2, variants=["hard_cut"], seed=3, segment_len=4,
        min_exchanges=6, streams=5,
    )
    stream_ids = {t.stream_id for t in results["hard_cut"]}
    assert len(stream_ids) == 5


def test_stray_insertion_rules_and_truth(tmp_path: Path):
    pool_dir = _make_pool(tmp_path)

    results = splice(
        pool_dir, k=3, variants=["stray"], seed=5, segment_len=4,
        min_exchanges=6, streams=1, strays_path=STRAYS_MINI,
    )
    turns = results["stray"]
    stray_positions = [i for i, t in enumerate(turns) if t.action_truth == "stray"]

    assert stray_positions, "expected at least one stray in this stream"
    assert 0 not in stray_positions, "a stray must never be the first row"
    assert (len(turns) - 1) not in stray_positions, "a stray must never be the last row"
    assert all(b - a > 1 for a, b in zip(stray_positions, stray_positions[1:])), (
        "no two strays back to back"
    )

    for i in stray_positions:
        t = turns[i]
        assert t.branch_id is None
        assert t.synthetic is True
        assert t.stray_from == turns[i - 1].branch_id
        assert t.turn["prompt_text"]  # drawn from the strays file, non-empty

    # non-stray rows still obey ordinary segment-boundary truth
    non_stray = [t for t in turns if t.action_truth != "stray"]
    _assert_truth_invariants(non_stray)


def test_stray_in_all_variants_list():
    assert "stray" in ALL_VARIANTS


def test_manifest_is_deterministic_and_traces_strays_file(tmp_path: Path):
    pool_dir = _make_pool(tmp_path)
    out_a = tmp_path / "a.jsonl"
    out_b = tmp_path / "b.jsonl"

    splice_to_file(
        pool_dir, out_a, k=2, variant_arg="all", seed=42, segment_len=4,
        min_exchanges=6, streams=3, strays_path=STRAYS_MINI,
    )
    splice_to_file(
        pool_dir, out_b, k=2, variant_arg="all", seed=42, segment_len=4,
        min_exchanges=6, streams=3, strays_path=STRAYS_MINI,
    )

    manifest_a = json.loads(out_a.with_name(out_a.stem + ".manifest.json").read_text())
    manifest_b = json.loads(out_b.with_name(out_b.stem + ".manifest.json").read_text())
    assert manifest_a == manifest_b

    assert manifest_a["seed"] == 42
    assert manifest_a["min_exchanges"] == 6
    assert manifest_a["streams"] == 3
    assert manifest_a["pool_size"] == 5
    assert manifest_a["excluded_below_min_exchanges"] == 2
    assert len(manifest_a["pool_session_ids_hashed"]) == 5
    assert all(len(h) == 16 for h in manifest_a["pool_session_ids_hashed"])
    assert "q1" not in manifest_a["pool_session_ids_hashed"]  # hashed, not raw

    expected_hash = hashlib.sha256(STRAYS_MINI.read_bytes()).hexdigest()
    assert manifest_a["strays_file_sha256"] == expected_hash

    for variant in ALL_VARIANTS:
        assert variant in manifest_a["variants"]
        assert manifest_a["variants"][variant]["streams"] == 3
        assert "truth_distribution" in manifest_a["variants"][variant]
