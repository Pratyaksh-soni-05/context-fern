"""Interleave scrubbed Claude Code sessions into synthetic streams with
ground-truth frond ids, for ReplayBench router evaluation (spec §13).

Each scrubbed session is one ground-truth frond: its main thread of
exchanges (transcript.py already excludes sidechains). The output schema
keeps the field name `branch_id` for continuity (see docs/decisions.md)
even though product code calls this a frond. Sessions are cut into
fixed-length segments, and segments from K sessions are interleaved into
one stream — so a realistic-length conversation produces many topic
transitions instead of just one hard cut.

All variants for one seed draw from the same pool of qualifying sessions
(everything with at least `--min-exchanges` exchanges), so variants are
comparable rather than each happening to sample a different lucky or
unlucky subset. `--streams` generates that many streams per variant, each
from its own seeded draw of K sessions out of the shared pool.

Five variants:
- hard_cut: segments concatenated back to back, no transition marker.
- cue_phrase: the real first prompt of a segment gets a cue phrase
  prefixed (e.g. "ok, switching to <hint>: ") — no standalone synthetic turn.
- return_at_distance: a frond's segment reappears after exactly `d`
  intervening exchanges from other fronds.
- combine: one synthetic final prompt, clearly marked as synthetic, whose
  ground truth needs two fronds at once (`combine_with`).
- stray: synthetic single off-topic prompts (from the committed
  bench/data/strays.txt) spliced into an otherwise normal stream, truth
  "stray". Never the first or last row, never two in a row — see
  _insert_strays.

Everything is driven off a single seeded random.Random per
(variant, seed, stream index), so the same
(scrubbed_dir, k, seed, segment_len, min_exchanges, streams) always
produces byte-identical output, including the manifest.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Literal

from bench.transcript import Exchange, parse_session

Variant = Literal["hard_cut", "cue_phrase", "return_at_distance", "combine", "stray"]
ALL_VARIANTS: tuple[Variant, ...] = (
    "hard_cut",
    "cue_phrase",
    "return_at_distance",
    "combine",
    "stray",
)

CUE_TEMPLATES = (
    "ok, switching to {hint}: ",
    "back to {hint}: ",
    "side question about {hint}: ",
    "let's return to {hint}: ",
)

DEFAULT_RETURN_DISTANCES = (2, 5, 9)

DEFAULT_STRAYS_PATH = Path(__file__).resolve().parents[2] / "data" / "strays.txt"


@dataclass(frozen=True)
class Segment:
    branch_id: str
    exchanges: tuple[Exchange, ...]


@dataclass(frozen=True)
class StreamTurn:
    stream_id: str
    turn_index: int
    branch_id: str | None
    action_truth: str
    variant: str
    turn: dict
    combine_with: tuple[str, ...] | None = None
    synthetic: bool = False
    stray_from: str | None = None

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
        if self.synthetic:
            payload["synthetic"] = True
        if self.stray_from is not None:
            payload["stray_from"] = self.stray_from
        return json.dumps(payload, ensure_ascii=False)


def _topic_hint(exchanges: tuple[Exchange, ...], words: int = 4) -> str:
    if not exchanges:
        return "that"
    first_words = exchanges[0].prompt_text.split()[:words]
    return " ".join(first_words).lower() or "that"


def _load_exchanges_by_session(scrubbed_dir: Path) -> dict[str, list[Exchange]]:
    exchanges_by_session: dict[str, list[Exchange]] = {}
    for path in sorted(scrubbed_dir.glob("*.jsonl")):
        parsed = parse_session(path)
        if not parsed.exchanges or not parsed.session_id:
            continue
        exchanges_by_session.setdefault(parsed.session_id, []).extend(parsed.exchanges)
    return exchanges_by_session


def load_branch_segments(
    scrubbed_dir: Path, segment_len: int, min_exchanges: int = 1
) -> dict[str, list[Segment]]:
    """One entry per session with >= min_exchanges exchanges; session_id is the branch id."""
    branches: dict[str, list[Segment]] = {}
    for session_id, exchanges in sorted(_load_exchanges_by_session(scrubbed_dir).items()):
        if len(exchanges) < min_exchanges:
            continue
        segments = [
            Segment(branch_id=session_id, exchanges=tuple(exchanges[i : i + segment_len]))
            for i in range(0, len(exchanges), segment_len)
        ]
        branches[session_id] = segments
    return branches


def excluded_sessions(scrubbed_dir: Path, min_exchanges: int) -> list[str]:
    """Session ids present in scrubbed_dir but below min_exchanges, for reporting."""
    excluded = [
        sid
        for sid, exchanges in _load_exchanges_by_session(scrubbed_dir).items()
        if len(exchanges) < min_exchanges
    ]
    return sorted(excluded)


def load_strays(path: Path | None = None) -> list[str]:
    p = path or DEFAULT_STRAYS_PATH
    if not p.exists():
        return []
    lines = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return lines


def _choose_branches(branches: dict[str, list[Segment]], k: int, rng: random.Random) -> list[str]:
    branch_ids = sorted(branches)
    if len(branch_ids) <= k:
        return branch_ids
    return rng.sample(branch_ids, k)


def _exchange_to_turn(exchange: Exchange) -> dict:
    return asdict(exchange)


def _synthetic_exchange(session_id: str, prompt: str, index: int) -> Exchange:
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


def _merge_adjacent_same_branch(segments: list[Segment]) -> list[Segment]:
    """A pure shuffle can place two distinct segments of the same branch back
    to back by chance. That isn't a real topic return (nothing else happened
    in between), so merge them into one continuous segment rather than
    letting _flatten mint a zero-gap "return". Mirrors what _regroup already
    does for return_at_distance's filler material."""
    if not segments:
        return segments
    merged = [segments[0]]
    for seg in segments[1:]:
        if seg.branch_id == merged[-1].branch_id:
            merged[-1] = Segment(seg.branch_id, merged[-1].exchanges + seg.exchanges)
        else:
            merged.append(seg)
    return merged


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
    return _flatten(stream_id, variant, _merge_adjacent_same_branch(segments), rng)


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
        return _flatten(stream_id, "return_at_distance", _merge_adjacent_same_branch(segments), rng)

    filler, leftover = other_flat[:distance], other_flat[distance:]
    ordered = [primary_segments[0], *_regroup(filler), primary_segments[1]]
    rest = primary_segments[2:] + _regroup(leftover)
    rng.shuffle(rest)
    ordered.extend(rest)

    return _flatten(stream_id, "return_at_distance", _merge_adjacent_same_branch(ordered), rng)


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
    turns = _flatten(stream_id, "combine", _merge_adjacent_same_branch(segments), rng)

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
    prompt = f"[synthetic] combine what we decided about {hint_primary} and {hint_other}"
    synthetic = _synthetic_exchange(stream_id, prompt, index=len(turns))

    turns.append(
        StreamTurn(
            stream_id=stream_id,
            turn_index=len(turns),
            branch_id=primary,
            action_truth="combine",
            variant="combine",
            turn=_exchange_to_turn(synthetic),
            combine_with=(other,),
            synthetic=True,
        )
    )
    return turns


def _insert_strays(
    turns: list[StreamTurn],
    strays_pool: list[str],
    stream_id: str,
    rng: random.Random,
) -> list[StreamTurn]:
    """Splice synthetic stray turns into an already-flattened stream.

    Inserting "before original index i" for i in [1, len(turns)-1] (never
    before index 0, never after the last index) automatically satisfies:
    never the first row, never the last row, and never two strays adjacent
    (each inserted stray sits before a distinct real turn, with at least
    one real turn between any two of them).
    """
    if len(turns) < 2 or not strays_pool:
        return turns

    num_strays = min(max(1, len(turns) // 8), len(turns) - 1, len(strays_pool))
    positions = set(rng.sample(range(1, len(turns)), num_strays))
    texts = rng.sample(strays_pool, num_strays)
    text_by_position = dict(zip(sorted(positions), texts))

    result: list[StreamTurn] = []
    for i, t in enumerate(turns):
        if i in text_by_position:
            prev_branch = result[-1].branch_id if result else None
            stray_exchange = _synthetic_exchange(stream_id, text_by_position[i], index=-1)
            result.append(
                StreamTurn(
                    stream_id=stream_id,
                    turn_index=0,  # renumbered below
                    branch_id=None,
                    action_truth="stray",
                    variant="stray",
                    turn=_exchange_to_turn(stray_exchange),
                    synthetic=True,
                    stray_from=prev_branch,
                )
            )
        result.append(t)

    return [replace(t, turn_index=i) for i, t in enumerate(result)]


def build_stray(
    stream_id: str,
    branches: dict[str, list[Segment]],
    k: int,
    strays_pool: list[str],
    rng: random.Random,
) -> list[StreamTurn]:
    chosen = _choose_branches(branches, k, rng)
    segments: list[Segment] = []
    for bid in chosen:
        segments.extend(branches[bid])
    rng.shuffle(segments)
    turns = _flatten(stream_id, "stray", _merge_adjacent_same_branch(segments), rng)
    return _insert_strays(turns, strays_pool, stream_id, rng)


def _build_one_stream(
    variant: Variant,
    stream_id: str,
    branches: dict[str, list[Segment]],
    k: int,
    strays_pool: list[str],
    rng: random.Random,
) -> list[StreamTurn]:
    if variant in ("hard_cut", "cue_phrase"):
        return build_shuffled(stream_id, variant, branches, k, rng)
    if variant == "return_at_distance":
        distance = DEFAULT_RETURN_DISTANCES[rng.randrange(len(DEFAULT_RETURN_DISTANCES))]
        return build_return_at_distance(stream_id, branches, k, distance, rng)
    if variant == "combine":
        return build_combine(stream_id, branches, k, rng)
    if variant == "stray":
        return build_stray(stream_id, branches, k, strays_pool, rng)
    raise ValueError(f"unknown variant: {variant}")


@dataclass
class SpliceResult:
    seed: int
    k: int
    min_exchanges: int
    streams: int
    segment_len: int
    pool_ids: list[str]
    excluded_ids: list[str]
    strays_path: Path
    turns_by_variant: dict[Variant, list[StreamTurn]]


def splice(
    scrubbed_dir: Path,
    k: int,
    variants: list[Variant],
    seed: int,
    segment_len: int = 4,
    min_exchanges: int = 1,
    streams: int = 1,
    strays_path: Path | None = None,
) -> dict[Variant, list[StreamTurn]]:
    """Back-compat-shaped entry point: returns just the per-variant turns.

    See splice_full() for the richer result (pool, exclusions, etc.) used
    to build the manifest.
    """
    return splice_full(
        scrubbed_dir, k, variants, seed, segment_len, min_exchanges, streams, strays_path
    ).turns_by_variant


def splice_full(
    scrubbed_dir: Path,
    k: int,
    variants: list[Variant],
    seed: int,
    segment_len: int = 4,
    min_exchanges: int = 1,
    streams: int = 1,
    strays_path: Path | None = None,
) -> SpliceResult:
    branches = load_branch_segments(scrubbed_dir, segment_len, min_exchanges)
    excluded = excluded_sessions(scrubbed_dir, min_exchanges)
    resolved_strays_path = strays_path or DEFAULT_STRAYS_PATH
    strays_pool = load_strays(resolved_strays_path) if "stray" in variants else []

    results: dict[Variant, list[StreamTurn]] = {}
    for variant in variants:
        variant_turns: list[StreamTurn] = []
        for i in range(streams):
            rng = random.Random(f"{seed}:{variant}:{i}")
            stream_id = f"stream-{variant}-{seed}-{i}"
            variant_turns.extend(
                _build_one_stream(variant, stream_id, branches, k, strays_pool, rng)
            )
        results[variant] = variant_turns

    return SpliceResult(
        seed=seed,
        k=k,
        min_exchanges=min_exchanges,
        streams=streams,
        segment_len=segment_len,
        pool_ids=sorted(branches),
        excluded_ids=excluded,
        strays_path=resolved_strays_path,
        turns_by_variant=results,
    )


def _truth_distribution(turns: list[StreamTurn]) -> dict[str, int]:
    dist: dict[str, int] = {}
    for t in turns:
        dist[t.action_truth] = dist.get(t.action_truth, 0) + 1
    return dist


def build_manifest(result: SpliceResult) -> dict:
    strays_sha256 = (
        hashlib.sha256(result.strays_path.read_bytes()).hexdigest()
        if result.strays_path.exists()
        else None
    )
    return {
        "seed": result.seed,
        "k": result.k,
        "min_exchanges": result.min_exchanges,
        "streams": result.streams,
        "segment_len": result.segment_len,
        "pool_size": len(result.pool_ids),
        "pool_session_ids_hashed": [
            hashlib.sha256(sid.encode("utf-8")).hexdigest()[:16] for sid in result.pool_ids
        ],
        "excluded_below_min_exchanges": len(result.excluded_ids),
        "strays_file_sha256": strays_sha256,
        "variants": {
            variant: {
                "streams": result.streams,
                "turns": len(turns),
                "truth_distribution": _truth_distribution(turns),
            }
            for variant, turns in result.turns_by_variant.items()
        },
    }


def splice_to_file(
    scrubbed_dir: Path,
    out_file: Path,
    k: int,
    variant_arg: str,
    seed: int,
    segment_len: int = 4,
    min_exchanges: int = 1,
    streams: int = 1,
    strays_path: Path | None = None,
) -> dict[str, int]:
    variants: list[Variant] = list(ALL_VARIANTS) if variant_arg == "all" else [variant_arg]  # type: ignore[list-item]
    result = splice_full(
        scrubbed_dir, k, variants, seed, segment_len, min_exchanges, streams, strays_path
    )

    out_file.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    with out_file.open("w", encoding="utf-8", newline="\n") as f:
        for variant in variants:
            turns = result.turns_by_variant.get(variant, [])
            counts[variant] = len(turns)
            for t in turns:
                f.write(t.to_json_line())
                f.write("\n")

    manifest_path = out_file.with_name(out_file.stem + ".manifest.json")
    manifest_path.write_text(
        json.dumps(build_manifest(result), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    return counts
