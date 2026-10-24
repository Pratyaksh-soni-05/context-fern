import random
from pathlib import Path

from bench.splice import (
    build_combine,
    build_return_at_distance,
    load_branch_segments,
    splice,
    splice_to_file,
)

FIXTURES = Path(__file__).parent / "fixtures" / "splice_sessions"

CUE_MARKERS = ("switching to", "back to", "side question about", "let's return to")


def _assert_truth_invariants(turns):
    """Truth is a per-segment-boundary property, independent of shuffle order."""
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
