"""Interleave scrubbed Claude Code sessions into synthetic streams with
ground-truth branch ids, for ReplayBench router evaluation (spec §12).

Each scrubbed session is one ground-truth branch: its main thread of
exchanges (transcript.py already excludes sidechains). Sessions are cut
into fixed-length segments, and segments from K sessions are interleaved
into one stream — so a realistic-length conversation produces many topic
transitions instead of just one hard cut.

Four variants:
- hard_cut: segments concatenated back to back, no transition marker.
- cue_phrase: the real first prompt of a segment gets a cue phrase
  prefixed (e.g. "ok, switching to <hint>: ") — no standalone synthetic turn.
- return_at_distance: a branch's segment reappears after exactly `d`
  intervening exchanges from other branches.
- combine: one synthetic final prompt, clearly marked as synthetic, whose
  ground truth needs two branches at once (`combine_with`).

Everything is driven off a single seeded random.Random per (variant, seed),
so the same (scrubbed_dir, k, seed, segment_len) always produces
byte-identical output.
"""

from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from bench.transcript import Exchange, parse_session

Variant = Literal["hard_cut", "cue_phrase", "return_at_distance", "combine"]
ALL_VARIANTS: tuple[Variant, ...] = ("hard_cut", "cue_phrase", "return_at_distance", "combine")

CUE_TEMPLATES = (
    "ok, switching to {hint}: ",
    "back to {hint}: ",
    "side question about {hint}: ",
    "let's return to {hint}: ",
)

DEFAULT_RETURN_DISTANCES = (2, 5, 9)


@dataclass(frozen=True)
class Segment:
    branch_id: str
    exchanges: tuple[Exchange, ...]


@dataclass(frozen=True)
class StreamTurn:
    stream_id: str
    turn_index: int
    branch_id: str
    action_truth: str
    variant: str
    turn: dict
    combine_with: tuple[str, ...] | None = None

    def to_json_line(self) -> str:
        payload = {
            "stream_id": self.stream_id,
            "turn_index": self.turn_index,
            "branch_id": self.branch_id,
            "action_truth": self.action_truth,
            "variant": self.variant,
            "turn": self.turn,
        }
        if self.combine_with is not None:
            payload["combine_with"] = list(self.combine_with)
        return json.dumps(payload, ensure_ascii=False)


def _topic_hint(exchanges: tuple[Exchange, ...], words: int = 4) -> str:
    if not exchanges:
        return "that"
    first_words = exchanges[0].prompt_text.split()[:words]
    return " ".join(first_words).lower() or "that"


def load_branch_segments(scrubbed_dir: Path, segment_len: int) -> dict[str, list[Segment]]:
    """One entry per session with >=1 exchange; session_id is the branch id."""
    branches: dict[str, list[Segment]] = {}
    for path in sorted(scrubbed_dir.glob("*.jsonl")):
        parsed = parse_session(path)
        if not parsed.exchanges or not parsed.session_id:
            continue
        exchanges = parsed.exchanges
        segments = [
            Segment(branch_id=parsed.session_id, exchanges=tuple(exchanges[i : i + segment_len]))
            for i in range(0, len(exchanges), segment_len)
        ]
        branches.setdefault(parsed.session_id, []).extend(segments)
    return branches


def _choose_branches(branches: dict[str, list[Segment]], k: int, rng: random.Random) -> list[str]:
    branch_ids = sorted(branches)
    if len(branch_ids) <= k:
        return branch_ids
    return rng.sample(branch_ids, k)


def _exchange_to_turn(exchange: Exchange) -> dict:
    return asdict(exchange)


def _synthetic_combine_exchange(session_id: str, hint_a: str, hint_b: str, index: int) -> Exchange:
    prompt = f"[synthetic] combine what we decided about {hint_a} and {hint_b}"
    return Exchange(
        session_id=session_id,
        index=index,
        prompt_text=prompt,
        assistant_text="",
        tool_calls=(),
        files_touched=(),
        size_chars=len(prompt),
    )


def _regroup(pairs: list[tuple[str, Exchange]]) -> list[Segment]:
    groups: list[Segment] = []
    if not pairs:
        return groups
    cur_bid, cur_exs = pairs[0][0], [pairs[0][1]]
    for bid, ex in pairs[1:]:
        if bid == cur_bid:
            cur_exs.append(ex)
        else:
            groups.append(Segment(cur_bid, tuple(cur_exs)))
            cur_bid, cur_exs = bid, [ex]
    groups.append(Segment(cur_bid, tuple(cur_exs)))
    return groups


def _flatten(
    stream_id: str,
    variant: Variant,
    ordered_segments: list[Segment],
    rng: random.Random,
) -> list[StreamTurn]:
    turns: list[StreamTurn] = []
    seen_branches: set[str] = set()
    turn_index = 0

    for seg_pos, segment in enumerate(ordered_segments):
        for ex_pos, exchange in enumerate(segment.exchanges):
            if ex_pos == 0:
                truth = "return" if segment.branch_id in seen_branches else "new"
                seen_branches.add(segment.branch_id)
            else:
                truth = "continue"

            turn_exchange = exchange
            if ex_pos == 0 and variant == "cue_phrase" and seg_pos > 0:
                hint = _topic_hint(segment.exchanges)
                template = CUE_TEMPLATES[rng.randrange(len(CUE_TEMPLATES))]
                cued_prompt = template.format(hint=hint) + exchange.prompt_text
                turn_exchange = Exchange(
                    session_id=exchange.session_id,
                    index=exchange.index,
                    prompt_text=cued_prompt,
                    assistant_text=exchange.assistant_text,
                    tool_calls=exchange.tool_calls,
                    files_touched=exchange.files_touched,
                    size_chars=len(cued_prompt) + len(exchange.assistant_text),
                )

            turns.append(
                StreamTurn(
                    stream_id=stream_id,
                    turn_index=turn_index,
                    branch_id=segment.branch_id,
                    action_truth=truth,
                    variant=variant,
                    turn=_exchange_to_turn(turn_exchange),
                )
            )
            turn_index += 1

    return turns


def build_shuffled(
    stream_id: str,
    variant: Variant,
    branches: dict[str, list[Segment]],
    k: int,
    rng: random.Random,
) -> list[StreamTurn]:
    """hard_cut and cue_phrase: every chosen branch's segments, shuffled."""
    chosen = _choose_branches(branches, k, rng)
    segments: list[Segment] = []
    for bid in chosen:
        segments.extend(branches[bid])
    rng.shuffle(segments)
    return _flatten(stream_id, variant, segments, rng)


def build_return_at_distance(
    stream_id: str,
    branches: dict[str, list[Segment]],
    k: int,
    distance: int,
    rng: random.Random,
) -> list[StreamTurn]:
    chosen = _choose_branches(branches, k, rng)
    if not chosen:
        return []
    primary = chosen[0]
    primary_segments = list(branches[primary])

    other_flat: list[tuple[str, Exchange]] = []
    for bid in chosen[1:]:
        for seg in branches[bid]:
            other_flat.extend((bid, ex) for ex in seg.exchanges)
    rng.shuffle(other_flat)

    if len(primary_segments) < 2 or len(other_flat) < distance:
        # not enough material to stage a real return at distance d —
        # degrade to a plain shuffle rather than failing the run.
        segments = primary_segments + _regroup(other_flat)
        rng.shuffle(segments)
        return _flatten(stream_id, "return_at_distance", segments, rng)

    filler, leftover = other_flat[:distance], other_flat[distance:]
    ordered = [primary_segments[0], *_regroup(filler), primary_segments[1]]
    rest = primary_segments[2:] + _regroup(leftover)
    rng.shuffle(rest)
    ordered.extend(rest)

    return _flatten(stream_id, "return_at_distance", ordered, rng)


def build_combine(
    stream_id: str,
    branches: dict[str, list[Segment]],
    k: int,
    rng: random.Random,
) -> list[StreamTurn]:
    chosen = _choose_branches(branches, k, rng)
    segments: list[Segment] = []
    for bid in chosen:
        segments.extend(branches[bid])
    rng.shuffle(segments)
    turns = _flatten(stream_id, "combine", segments, rng)

    if len(chosen) < 2:
        return turns  # not enough branches to combine; degrade gracefully

    recent: list[str] = []
    for t in reversed(turns):
        if t.branch_id not in recent:
            recent.append(t.branch_id)
        if len(recent) == 2:
            break
    primary, other = recent[0], recent[1]

    hint_primary = _topic_hint(branches[primary][0].exchanges)
    hint_other = _topic_hint(branches[other][0].exchanges)
    synthetic = _synthetic_combine_exchange(stream_id, hint_primary, hint_other, index=len(turns))

    turns.append(
        StreamTurn(
            stream_id=stream_id,
            turn_index=len(turns),
            branch_id=primary,
            action_truth="combine",
            variant="combine",
            turn=_exchange_to_turn(synthetic),
            combine_with=(other,),
        )
    )
    return turns


def splice(
    scrubbed_dir: Path,
    k: int,
    variants: list[Variant],
    seed: int,
    segment_len: int = 4,
) -> dict[Variant, list[StreamTurn]]:
    branches = load_branch_segments(scrubbed_dir, segment_len)
    results: dict[Variant, list[StreamTurn]] = {}

    for variant in variants:
        rng = random.Random(f"{seed}:{variant}")
        stream_id = f"stream-{variant}-{seed}"
        if variant in ("hard_cut", "cue_phrase"):
            results[variant] = build_shuffled(stream_id, variant, branches, k, rng)
        elif variant == "return_at_distance":
            distance = DEFAULT_RETURN_DISTANCES[rng.randrange(len(DEFAULT_RETURN_DISTANCES))]
            results[variant] = build_return_at_distance(stream_id, branches, k, distance, rng)
        elif variant == "combine":
            results[variant] = build_combine(stream_id, branches, k, rng)

    return results


def splice_to_file(
    scrubbed_dir: Path,
    out_file: Path,
    k: int,
    variant_arg: str,
    seed: int,
    segment_len: int = 4,
) -> dict[str, int]:
    variants: list[Variant] = list(ALL_VARIANTS) if variant_arg == "all" else [variant_arg]  # type: ignore[list-item]
    results = splice(scrubbed_dir, k, variants, seed, segment_len)

    out_file.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    with out_file.open("w", encoding="utf-8", newline="\n") as f:
        for variant in variants:
            turns = results.get(variant, [])
            counts[variant] = len(turns)
            for t in turns:
                f.write(t.to_json_line())
                f.write("\n")
    return counts
