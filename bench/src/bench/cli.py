"""`bench` CLI: scrub, splice, label, eval and sweep ReplayBench transcript
fixtures and Stage 0 router results."""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
import tomllib
from pathlib import Path

from bench.label import build_eval_stream, label_session
from bench.run import (
    CLI_ENTRY,
    REPO_ROOT,
    compute_metrics,
    join_predictions_with_truth,
    run_route_replay,
)
from bench.scrub import scrub_directory
from bench.splice import ALL_VARIANTS, splice_to_file

MODES = ["full", "always-continue", "cue-only", "embeddings-only"]
SWEEP_SCRIPT = REPO_ROOT / "bench" / "ts" / "sweep.ts"
STAGE2_SAMPLE_SCRIPT = REPO_ROOT / "bench" / "ts" / "stage2-sample.ts"

# Default two specified by the maintainer (already pulled locally);
# qwen3.5:9b added after checking Ollama's library turned up a newer
# (~2026-10, 256K context) <=14B instruct-capable model — see
# docs/decisions.md, not guessed from training data.
DEFAULT_STAGE2_MODELS = ["qwen3:8b", "gemma3:12b", "qwen3.5:9b"]
DEFAULT_ESCALATION_LOW = 0.25
DEFAULT_ESCALATION_HIGH = 0.5
DAY30_GATE_F1_NEW = 0.85
DAY30_GATE_F1_STRAY = 0.80
DAY30_GATE_ESCALATION = 0.10


def _cmd_scrub(args: argparse.Namespace) -> int:
    counts, skipped = scrub_directory(Path(args.in_dir), Path(args.out_dir))

    for label in sorted(counts):
        print(f"{label}\t{counts[label]}")

    if skipped:
        total = sum(len(notes) for notes in skipped.values())
        print(f"-- {total} unparsable line(s) across {len(skipped)} file(s) --")
        for path, notes in skipped.items():
            for note in notes:
                print(f"{path.name}:{note.line}: {note.reason}")

    return 0


def _cmd_splice(args: argparse.Namespace) -> int:
    out_file = Path(args.out_file)
    strays_path = Path(args.strays_file) if args.strays_file else None
    counts = splice_to_file(
        Path(args.scrubbed_dir),
        out_file,
        k=args.k,
        variant_arg=args.variant,
        seed=args.seed,
        segment_len=args.segment_len,
        min_exchanges=args.min_exchanges,
        streams=args.streams,
        strays_path=strays_path,
    )
    for variant in sorted(counts):
        print(f"{variant}\t{counts[variant]} turns")

    manifest_path = out_file.with_name(out_file.stem + ".manifest.json")
    print(f"manifest\t{manifest_path}")
    return 0


def _cmd_label(args: argparse.Namespace) -> int:
    labels_path = label_session(Path(args.scrubbed_file))
    print(f"labels saved to {labels_path}")
    return 0


def _cmd_label_export(args: argparse.Namespace) -> int:
    rows = build_eval_stream(Path(args.scrubbed_file), Path(args.labels_file))
    out_file = Path(args.out_file)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with out_file.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False))
            f.write("\n")
    print(f"{len(rows)} labelled turns -> {out_file}")
    return 0


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _run_all_modes(stream_file: Path, config_file: Path | None = None) -> dict[str, list[dict]]:
    per_mode: dict[str, list[dict]] = {}
    for mode in MODES:
        predictions = run_route_replay(stream_file, mode=mode, config_file=config_file)
        per_mode[mode] = join_predictions_with_truth(stream_file, predictions)
    return per_mode


def _print_table(title: str, rows_by_mode: dict[str, list[dict]]) -> None:
    print(f"\n=== {title} ===")
    print(
        f"{'mode':<18}{'n':>6}{'acc':>8}{'f1_new':>8}{'f1_ret':>8}{'f1_stray':>9}"
        f"{'over_carry':>12}{'wrong_ret':>11}{'p50_ms':>9}{'p95_ms':>9}"
    )
    for mode in MODES:
        rows = rows_by_mode.get(mode)
        if not rows:
            continue
        m = compute_metrics(rows)
        print(
            f"{mode:<18}{m.n:>6}{_pct(m.action_accuracy):>8}{_pct(m.f1_new):>8}"
            f"{_pct(m.f1_return):>8}{_pct(m.f1_stray):>9}{_pct(m.over_carry_rate):>12}"
            f"{_pct(m.wrong_return_rate):>11}{m.latency_p50_ms:>9.1f}{m.latency_p95_ms:>9.1f}"
        )
        if m.n_combine_excluded:
            note = (
                f"({m.n_combine_excluded} combine row(s) excluded — Stage 0 never predicts combine)"
            )
            print(f"{'':<18}{note}")


def _avg_f1(rows: list[dict]) -> float:
    m = compute_metrics(rows)
    return (m.f1_new + m.f1_return + m.f1_stray) / 3


def _cmd_eval(args: argparse.Namespace) -> int:
    streams_file = Path(args.streams_file)
    config_file = Path(args.config) if args.config else None

    per_mode = _run_all_modes(streams_file, config_file)

    variants = sorted({r["variant"] for rows in per_mode.values() for r in rows})
    for variant in variants:
        by_mode = {
            mode: [r for r in rows if r["variant"] == variant] for mode, rows in per_mode.items()
        }
        _print_table(f"variant: {variant}", by_mode)

    cue_avg = _avg_f1(per_mode["cue-only"])
    emb_avg = _avg_f1(per_mode["embeddings-only"])
    full_avg = _avg_f1(per_mode["full"])
    leading = "cue phrases" if cue_avg >= emb_avg else "embedding similarity"
    print(f"\nSignal carrying most of the result: {leading}")
    print(f"  cue-only avg F1={cue_avg:.3f}")
    print(f"  embeddings-only avg F1={emb_avg:.3f}")
    print(f"  full avg F1={full_avg:.3f}")

    if args.natural:
        natural_file = Path(args.natural)
        print("\n" + "=" * 60)
        print("HEADLINE: natural-label stream (real hand-labelled ground truth)")
        print("=" * 60)
        natural_per_mode = _run_all_modes(natural_file, config_file)
        _print_table("natural", natural_per_mode)
    else:
        print("\n(no --natural file given; no hand-labelled headline number to report)")

    return 0


def _write_thresholds_toml(path: Path, thresholds: dict, manifest_sha256: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Written by `bench sweep`. Draft thresholds from a grid search,",
        "# NOT a maintainer-approved shipped default — see CLAUDE.md.",
        "",
        "[thresholds]",
        f"continue_min = {thresholds['continueMin']}",
        f"new_max = {thresholds['newMax']}",
        f"return_min = {thresholds['returnMin']}",
        f"stray_max_similarity = {thresholds['strayMaxSimilarity']}",
        f"stray_max_prompt_words = {thresholds['strayMaxPromptWords']}",
        "",
    ]
    if manifest_sha256:
        lines.extend(["[manifest]", f'sha256 = "{manifest_sha256}"', ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def _cmd_sweep(args: argparse.Namespace) -> int:
    streams_file = Path(args.streams_file)
    result = subprocess.run(
        ["bun", "run", str(SWEEP_SCRIPT), str(streams_file)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return 1

    report = json.loads(result.stdout)

    print(f"pool sessions: {len(report['pool_sessions'])}")
    print("\nleave-one-session-out folds:")
    print(f"{'held out':<40}{'test_score':>12}")
    for fold in report["loso"]["folds"]:
        print(f"{fold['held_out_session']:<40}{fold['test_score']:>12.4f}")
    print(f"\nmean test score: {report['loso']['mean_test_score']:.4f}")
    print(f"worst test score: {report['loso']['worst_test_score']:.4f}")
    print(
        "(mean/worst above are the honest generalization estimate — NOT the "
        "same thing as the final thresholds below, which use all sessions)"
    )

    final_thresholds = report["final"]["thresholds"]
    n_sessions = len(report["pool_sessions"])
    print(f"\nfinal thresholds (all {n_sessions} sessions as dev): {final_thresholds}")

    manifest_path = (
        Path(args.manifest)
        if args.manifest
        else streams_file.with_name(streams_file.stem + ".manifest.json")
    )
    manifest_sha256 = None
    if manifest_path.exists():
        import hashlib

        manifest_sha256 = hashlib.sha256(manifest_path.read_bytes()).hexdigest()

    out_path = Path(args.out) if args.out else REPO_ROOT / "bench" / "results" / "thresholds.toml"
    _write_thresholds_toml(out_path, final_thresholds, manifest_sha256)
    print(f"\nwrote {out_path}")

    return 0


def _read_escalation_band(config_file: Path | None) -> tuple[float, float]:
    if not config_file or not config_file.exists():
        return DEFAULT_ESCALATION_LOW, DEFAULT_ESCALATION_HIGH
    with config_file.open("rb") as f:
        data = tomllib.load(f)
    escalation = data.get("escalation", {})
    return (
        escalation.get("low", DEFAULT_ESCALATION_LOW),
        escalation.get("high", DEFAULT_ESCALATION_HIGH),
    )


def _count_lines(path: Path) -> int:
    with path.open(encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def _stratified_sample_ids(streams_file: Path, sample_size: int, seed: int) -> list[str]:
    """Stratifies by (variant, action_truth) so rare classes (new/return/
    stray) are represented even at a small sample size — a flat random
    sample would barely include any of them, since they're a small
    fraction of real turns."""
    groups: dict[tuple[str, str], list[str]] = {}
    with streams_file.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            key = (row["variant"], row["action_truth"])
            turn_id = f"{row['stream_id']}#{row['turn_index']}"
            groups.setdefault(key, []).append(turn_id)

    rng = random.Random(seed)
    keys = sorted(groups.keys())
    if not keys:
        return []
    target_per_group = max(1, sample_size // len(keys))

    sample: list[str] = []
    leftovers: list[str] = []
    for key in keys:
        ids = groups[key][:]
        rng.shuffle(ids)
        sample.extend(ids[:target_per_group])
        leftovers.extend(ids[target_per_group:])

    shortfall = sample_size - len(sample)
    if shortfall > 0 and leftovers:
        rng.shuffle(leftovers)
        sample.extend(leftovers[:shortfall])

    rng.shuffle(sample)
    return sample[:sample_size]


def _safe_model_name(model: str) -> str:
    return model.replace(":", "-").replace(".", "-")


def _read_journal_tokens(journal_file: Path) -> tuple[int, float, float]:
    if not journal_file.exists():
        return 0, 0.0, 0.0
    lines = [line for line in journal_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return 0, 0.0, 0.0
    entries = [json.loads(line) for line in lines]
    avg_in = sum(e["inputTokens"] for e in entries) / len(entries)
    avg_out = sum(e["outputTokens"] for e in entries) / len(entries)
    return len(entries), avg_in, avg_out


def _print_stage2_model_table(rows_by_model: dict[str, list[dict]]) -> None:
    print(
        f"\n{'model':<16}{'n':>6}{'f1_new':>8}{'f1_ret':>8}{'f1_stray':>9}"
        f"{'escalation':>11}{'p50_s0':>8}{'p95_s0':>8}{'p50_s2':>8}{'p95_s2':>8}"
    )
    for model, rows in rows_by_model.items():
        m = compute_metrics(rows)
        print(
            f"{model:<16}{m.n:>6}{_pct(m.f1_new):>8}{_pct(m.f1_return):>8}{_pct(m.f1_stray):>9}"
            f"{_pct(m.escalation_rate):>11}{m.latency_p50_stage0_ms:>8.1f}"
            f"{m.latency_p95_stage0_ms:>8.1f}{m.latency_p50_stage2_ms:>8.1f}"
            f"{m.latency_p95_stage2_ms:>8.1f}"
        )


def _simulate_band(rows: list[dict], low: float, high: float) -> list[dict]:
    """Given sample rows that were ALL forced to escalate (so both the
    Stage 0 and Stage 2 outcome are known for every row), slices them as
    if only rows with stage0_confidence in [low, high] had escalated —
    everywhere else uses Stage 0's own (pre-escalation) action instead.
    Valid (not an approximation) because Stage 0 ran causally across the
    whole dataset regardless of which rows were forced to escalate, so
    this doesn't rewrite any upstream state — see docs/decisions.md."""
    simulated = []
    for r in rows:
        conf = r.get("stage0_confidence")
        if conf is not None and low <= conf <= high:
            simulated.append(r)
        else:
            simulated.append(
                {**r, "predicted_action": r.get("stage0_predicted_action", r["predicted_action"])}
            )
    return simulated


_BAND_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]


def _band_sweep_for_gate(rows: list[dict]) -> dict | None:
    """Among a small grid of candidate [low, high] escalation bands,
    finds the one with the smallest escalation rate that still clears
    both day-30 F1 bars on this sample. None if no candidate band does."""
    best = None
    for low in _BAND_GRID:
        for high in _BAND_GRID:
            if high < low:
                continue
            simulated = _simulate_band(rows, low, high)
            m = compute_metrics(simulated)
            escalated = sum(
                1
                for r in rows
                if r.get("stage0_confidence") is not None and low <= r["stage0_confidence"] <= high
            )
            escalation_rate = escalated / len(rows) if rows else 0.0
            if m.f1_new >= DAY30_GATE_F1_NEW and m.f1_stray >= DAY30_GATE_F1_STRAY:
                if best is None or escalation_rate < best["escalation_rate"]:
                    best = {
                        "low": low,
                        "high": high,
                        "escalation_rate": escalation_rate,
                        "f1_new": m.f1_new,
                        "f1_stray": m.f1_stray,
                    }
    return best


def _row_id(row: dict) -> str:
    return f"{row['stream_id']}#{row['turn_index']}"


def _load_checkpoint(path: Path) -> dict[str, dict]:
    """Reads a `stage2-sample-<model>.jsonl` checkpoint file (if it
    exists) into {row_id: row}. Later lines for the same id overwrite
    earlier ones, so this naturally dedups if a line were ever appended
    twice."""
    done_rows: dict[str, dict] = {}
    if not path.exists():
        return done_rows
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                row = json.loads(line)
                done_rows[_row_id(row)] = row
    return done_rows


def _run_stage2_sample(
    streams_file: Path,
    model: str,
    sample_ids_path: Path,
    checkpoint_path: Path,
    journal_file: Path,
    *,
    ollama_url: str | None = None,
    limit: int | None = None,
    timeout_ms: int = 60_000,
    retries: int = 1,
    embedding_cache: Path | None = None,
    log_file: Path | None = None,
) -> None:
    """Shells out to bench/ts/stage2-sample.ts — the probe-only sample
    runner (see docs/decisions.md for why the old `route --mode stage2
    --sample-ids` path was replaced: it could silently escalate every
    in-band turn in the whole dataset, not just the sampled ones, and
    buffered its entire output in memory with no incremental output at
    all). The script checkpoints every row to `checkpoint_path` itself
    as it completes; this just relays its progress lines to stdout/log
    and raises if it exits non-zero. stderr is merged into stdout so a
    chatty subprocess can't deadlock either side."""
    args = [
        "bun",
        "run",
        str(STAGE2_SAMPLE_SCRIPT),
        str(streams_file),
        "--model",
        model,
        "--sample-ids",
        str(sample_ids_path),
        "--checkpoint",
        str(checkpoint_path),
        "--journal",
        str(journal_file),
        "--timeout-ms",
        str(timeout_ms),
        "--retries",
        str(retries),
    ]
    if ollama_url:
        args.extend(["--ollama-url", ollama_url])
    if limit is not None:
        args.extend(["--limit", str(limit)])
    if embedding_cache:
        args.extend(["--embedding-cache", str(embedding_cache)])

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=REPO_ROOT,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            print(f"  [sample:{model}] {line}", flush=True)
            continue
        if isinstance(parsed, dict) and parsed.get("progress"):
            msg = (
                f"[sample:{model}] {parsed['done']}/{parsed['total']} done "
                f"(succeeded={parsed.get('succeeded')}, failed={parsed.get('failed')}), "
                f"avg_latency_ms={parsed['avg_latency_ms']}, "
                f"elapsed={parsed['elapsed_min']}m, eta={parsed['eta_min']}m"
            )
            print(f"  {msg}", flush=True)
            _log_line(log_file, msg)
        else:
            print(f"  [sample:{model}] {line}", flush=True)

    returncode = proc.wait()
    if returncode != 0:
        raise RuntimeError(f"stage2-sample.ts failed (model={model}): {returncode}")


def _run_route_replay_streaming(
    stream_file: Path,
    mode: str = "full",
    config_file: Path | None = None,
    *,
    model: str | None = None,
    ollama_url: str | None = None,
    journal_file: Path | None = None,
    label: str = "",
    log_file: Path | None = None,
) -> list[dict]:
    """Like run_route_replay, but reads the subprocess's stdout line by
    line and prints/logs periodic progress instead of blocking silently
    until the whole pass exits — `run_route_replay`'s `subprocess.run(
    capture_output=True)` buffers everything until the process ends,
    which made a multi-minute Stage 2 run indistinguishable from a hang.
    stderr is merged into stdout (not a second PIPE nobody drains) so a
    chatty subprocess can't deadlock either side. For sampling a subset
    of turns, use bench/ts/stage2-sample.ts instead (see docs/decisions.md
    on why this path can't safely target a subset on its own)."""
    args = ["bun", "run", str(CLI_ENTRY), "route", "--replay", str(stream_file), "--mode", mode]
    if config_file:
        args.extend(["--config", str(config_file)])
    if model:
        args.extend(["--model", model])
    if ollama_url:
        args.extend(["--ollama-url", ollama_url])
    if journal_file:
        args.extend(["--journal", str(journal_file)])

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=REPO_ROOT,
        bufsize=1,
    )
    predictions: list[dict] = []
    escalated = 0
    start = time.monotonic()
    assert proc.stdout is not None

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            # a stray non-JSON line from the merged stderr stream — surface it, don't crash
            print(f"  [{label}] (stderr) {line}", flush=True)
            continue
        predictions.append(row)
        if row.get("stage2_latency_ms") is not None:
            escalated += 1

        turns_done = len(predictions)
        if turns_done % 5000 == 0:
            elapsed = time.monotonic() - start
            msg = (
                f"[{label}] {turns_done} turns processed ({escalated} escalated), "
                f"elapsed={elapsed / 60:.1f}m"
            )
            print(f"  {msg}", flush=True)
            _log_line(log_file, msg)

    returncode = proc.wait()
    if returncode != 0:
        raise RuntimeError(f"fern route --replay failed (mode={mode}): {returncode}")
    return predictions


def _split_by_stream(streams_file: Path, out_dir: Path) -> list[str]:
    """Splits a streams.jsonl into one file per stream_id under out_dir
    (only if not already split), returns the sorted stream_id list —
    the unit a long full-dataset Stage 2 run checkpoints on."""
    out_dir.mkdir(parents=True, exist_ok=True)
    by_stream: dict[str, list[str]] = {}
    with streams_file.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            stream_id = json.loads(line)["stream_id"]
            by_stream.setdefault(stream_id, []).append(line)
    for stream_id, lines in by_stream.items():
        safe = stream_id.replace("/", "_")
        split_file = out_dir / f"{safe}.jsonl"
        if not split_file.exists():
            split_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sorted(by_stream.keys())


def _log_line(log_file: Path | None, msg: str) -> None:
    if log_file is None:
        return
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with log_file.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} {msg}\n")


def _run_full_stage2_resumable(
    streams_file: Path,
    model: str,
    config_file: Path | None,
    ollama_url: str | None,
    results_dir: Path,
    log_file: Path | None = None,
) -> list[dict]:
    """Runs the full dataset one stream at a time, writing each stream's
    predictions to its own output file as soon as it's done. Safe to
    interrupt (Ctrl-C, crash, reboot) and re-run this exact command —
    already-completed streams (their output file already exists) are
    skipped, not redone."""
    safe_model = _safe_model_name(model)
    split_dir = results_dir / "stage2-full-split"
    out_dir = results_dir / f"stage2-full-output-{safe_model}"
    out_dir.mkdir(parents=True, exist_ok=True)
    journal_file = results_dir / f"stage2-full-journal-{safe_model}.jsonl"

    stream_ids = _split_by_stream(streams_file, split_dir)
    total = len(stream_ids)
    already_done = sum(
        1 for sid in stream_ids if (out_dir / f"{sid.replace('/', '_')}.jsonl").exists()
    )
    if already_done:
        msg = f"resuming: {already_done}/{total} streams already completed from a prior run"
        print(msg)
        _log_line(log_file, msg)

    start = time.monotonic()
    done = already_done
    for stream_id in stream_ids:
        safe = stream_id.replace("/", "_")
        out_file = out_dir / f"{safe}.jsonl"
        if out_file.exists():
            continue

        predictions = _run_route_replay_streaming(
            split_dir / f"{safe}.jsonl",
            mode="stage2",
            config_file=config_file,
            model=model,
            ollama_url=ollama_url,
            journal_file=journal_file,
            label=f"full:{model}:{stream_id}",
            log_file=log_file,
        )
        out_file.write_text("\n".join(json.dumps(p) for p in predictions) + "\n", encoding="utf-8")
        done += 1
        elapsed = time.monotonic() - start
        rate = elapsed / max(1, done - already_done)
        eta = rate * (total - done)
        msg = (
            f"[{done}/{total}] stream {stream_id} done "
            f"(elapsed {elapsed / 60:.1f}m, eta {eta / 60:.1f}m)"
        )
        print(msg, flush=True)
        _log_line(log_file, msg)

    all_predictions: list[dict] = []
    for stream_id in stream_ids:
        safe = stream_id.replace("/", "_")
        for line in (out_dir / f"{safe}.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                all_predictions.append(json.loads(line))
    return all_predictions


def _cmd_eval_stage2(args: argparse.Namespace) -> int:
    streams_file = Path(args.streams_file)
    config_file = Path(args.config) if args.config else None
    models = args.models.split(",") if args.models else DEFAULT_STAGE2_MODELS
    results_dir = REPO_ROOT / "bench" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    log_file = results_dir / "eval-stage2.log"

    print(f"model lineup: {', '.join(models)}")
    total_turns = _count_lines(streams_file)
    print(f"full dataset: {total_turns} turns")

    sample_ids = _stratified_sample_ids(streams_file, args.sample_size, args.seed)
    sample_ids_path = results_dir / "stage2-sample-ids.json"
    sample_ids_path.write_text(json.dumps(sample_ids), encoding="utf-8")
    print(f"stratified sample: {len(sample_ids)} turns -> {sample_ids_path}")

    escalation_low, escalation_high = _read_escalation_band(config_file)

    # Stage 0's own signals/confidence don't depend on which Ollama model
    # Stage 2 uses, so this one cheap (no LLM calls) full-dataset pass is
    # shared across every model's projection AND doubles as the
    # authoritative "Stage 0 alone" baseline for the final report below —
    # no need to run it twice.
    print("\nStage 0 alone over the full dataset (shared baseline + projection input)...")
    stage0_predictions = _run_route_replay_streaming(
        streams_file,
        mode="full",
        config_file=config_file,
        label="full:stage0-alone",
        log_file=log_file,
    )
    stage0_rows = join_predictions_with_truth(streams_file, stage0_predictions)
    latencies = [r["latency_ms"] for r in stage0_rows if r.get("latency_ms") is not None]
    avg_stage0_ms = sum(latencies) / len(latencies) if latencies else 0.0
    confidences = [r["confidence"] for r in stage0_rows if r.get("confidence") is not None]
    in_band = [c for c in confidences if escalation_low <= c <= escalation_high]
    full_escalation_estimate = len(in_band) / len(confidences) if confidences else 0.0
    print(
        f"full-dataset escalation-band estimate: {_pct(full_escalation_estimate)} of turns "
        f"naturally fall in [{escalation_low}, {escalation_high}]"
    )

    embedding_cache = results_dir / "embeddings-cache.bin"
    rows_by_model: dict[str, list[dict]] = {}
    projections: dict[str, dict] = {}

    if args.skip_sample and not args.model:
        print("--skip-sample requires --model (no sample comparison to pick a default from)")
        return 1
    if args.skip_sample:
        print(f"\n--skip-sample given; going straight to the full run for {args.model}.")
    models_to_sample = [] if args.skip_sample else models

    for model in models_to_sample:
        safe_name = _safe_model_name(model)
        journal_file = results_dir / f"stage2-sample-journal-{safe_name}.jsonl"
        checkpoint_path = results_dir / f"stage2-sample-{safe_name}.jsonl"

        done_rows = _load_checkpoint(checkpoint_path)
        msg = f"sample run for {model}: {len(done_rows)}/{len(sample_ids)} already checkpointed"
        print(f"\n{msg}")
        _log_line(log_file, msg)

        _run_stage2_sample(
            streams_file,
            model,
            sample_ids_path,
            checkpoint_path,
            journal_file,
            ollama_url=args.ollama_url,
            embedding_cache=embedding_cache,
            log_file=log_file,
        )

        # checkpoint_path now holds every sampled row this model has ever
        # completed (appended as each one finished) — re-read it fully.
        raw_sample_rows: list[dict] = []
        with checkpoint_path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    raw_sample_rows.append(json.loads(line))
        sampled_rows = join_predictions_with_truth(streams_file, raw_sample_rows)
        rows_by_model[model] = sampled_rows

        escalated_sample = [r for r in sampled_rows if r.get("stage2_latency_ms") is not None]
        avg_stage2_ms = (
            sum(r["stage2_latency_ms"] for r in escalated_sample) / len(escalated_sample)
            if escalated_sample
            else 0.0
        )

        _n_calls, avg_in, avg_out = _read_journal_tokens(journal_file)

        projected_stage2_hours = (
            (avg_stage2_ms * full_escalation_estimate * total_turns) / 1000 / 3600
        )
        projected_stage0_hours = (avg_stage0_ms * total_turns) / 1000 / 3600

        projections[model] = {
            "full_escalation_estimate": full_escalation_estimate,
            "avg_input_tokens": avg_in,
            "avg_output_tokens": avg_out,
            "projected_hours": projected_stage2_hours + projected_stage0_hours,
        }

    if models_to_sample:
        print(
            "\n=== per-model comparison on the stratified sample (every row forced to escalate) ==="
        )
        _print_stage2_model_table(rows_by_model)

        print("\n=== full-dataset projection per model (no dollar cost — local Ollama) ===")
        print(f"{'model':<16}{'est. escalation':>16}{'avg in/out tok':>16}{'projected time':>16}")
        for model, p in projections.items():
            tokens = f"{p['avg_input_tokens']:.0f}/{p['avg_output_tokens']:.0f}"
            print(
                f"{model:<16}{_pct(p['full_escalation_estimate']):>16}{tokens:>16}"
                f"{p['projected_hours']:.2f}h".rjust(16)
            )

    chosen_model = args.model or max(rows_by_model, key=lambda m: _avg_f1(rows_by_model[m]))
    print(f"\nchosen model for the full run: {chosen_model} (override with --model)")

    if args.skip_full:
        print("--skip-full given; stopping after the sample comparison/projection.")
        return 0

    if chosen_model in projections:
        proj_hours = projections[chosen_model]["projected_hours"]
        print(
            f"projected full-dataset time for {chosen_model}: {proj_hours:.2f}h "
            f"(threshold: {args.max_hours}h)"
        )
        if proj_hours > args.max_hours:
            print(f"note: projected time exceeds the {args.max_hours}h threshold — running anyway.")
    else:
        print(f"(--skip-sample: no fresh projection computed for {chosen_model})")
    print(
        "running the full dataset as a resumable, per-stream-checkpointed job "
        "— safe to interrupt (Ctrl-C) and re-run this exact command to resume."
    )
    predictions = _run_full_stage2_resumable(
        streams_file, chosen_model, config_file, args.ollama_url, results_dir, log_file
    )

    full_rows = join_predictions_with_truth(streams_file, predictions)
    # stage0_rows was already computed once, up front — Stage 0's output
    # doesn't depend on which Stage 2 model is being evaluated, so no
    # need to run it a second time here.

    # Persisted so later analyses (e.g. cross-referencing the ceiling-check
    # sample) don't need to re-run the whole pipeline to get raw per-turn
    # predictions again.
    safe_chosen = _safe_model_name(chosen_model)
    (results_dir / "stage2-full-rows-stage0.jsonl").write_text(
        "\n".join(json.dumps(r) for r in stage0_rows) + "\n", encoding="utf-8"
    )
    (results_dir / f"stage2-full-rows-gated-{safe_chosen}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in full_rows) + "\n", encoding="utf-8"
    )

    print("\n=== FULL DATASET: Stage 0 alone vs Stage 0+2 gated (real, authoritative) ===")
    variants = sorted({r["variant"] for r in full_rows})
    for variant in variants:
        by_mode = {
            "stage0-alone": [r for r in stage0_rows if r["variant"] == variant],
            f"stage0+2-{chosen_model}": [r for r in full_rows if r["variant"] == variant],
        }
        _print_stage2_model_table(by_mode)

    full_metrics = compute_metrics(full_rows)
    gate_new = full_metrics.f1_new >= DAY30_GATE_F1_NEW
    gate_stray = full_metrics.f1_stray >= DAY30_GATE_F1_STRAY
    gate_escalation = full_metrics.escalation_rate <= DAY30_GATE_ESCALATION
    print("\n=== Honest read against spec §16 (day-30 gate) ===")
    print(
        f"F1 new    : {full_metrics.f1_new:.3f} (gate >= {DAY30_GATE_F1_NEW}) -> "
        f"{'PASS' if gate_new else 'FAIL'}"
    )
    print(
        f"F1 stray  : {full_metrics.f1_stray:.3f} (gate >= {DAY30_GATE_F1_STRAY}) -> "
        f"{'PASS' if gate_stray else 'FAIL'}"
    )
    print(
        f"escalation: {full_metrics.escalation_rate:.3f} (gate <= {DAY30_GATE_ESCALATION}) -> "
        f"{'PASS' if gate_escalation else 'FAIL'}"
    )

    if not (gate_new and gate_stray and gate_escalation):
        band = _band_sweep_for_gate(rows_by_model[chosen_model])
        if band:
            print(
                f"\nOn the stratified sample, the smallest escalation band clearing both "
                f"F1 bars is [{band['low']}, {band['high']}] "
                f"(escalation rate {_pct(band['escalation_rate'])}, "
                f"F1 new {band['f1_new']:.3f}, F1 stray {band['f1_stray']:.3f})."
            )
        else:
            print(
                "\nNo escalation band in the swept grid clears both F1 bars on the "
                "sample — the gap looks like more than an escalation-rate problem."
            )

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench")
    sub = parser.add_subparsers(dest="command", required=True)

    scrub_parser = sub.add_parser("scrub", help="Scrub secrets/PII from JSONL transcripts")
    scrub_parser.add_argument("in_dir")
    scrub_parser.add_argument("out_dir")
    scrub_parser.set_defaults(func=_cmd_scrub)

    splice_parser = sub.add_parser("splice", help="Interleave scrubbed sessions into streams")
    splice_parser.add_argument("scrubbed_dir")
    splice_parser.add_argument("out_file")
    splice_parser.add_argument("--k", type=int, default=3)
    splice_parser.add_argument("--variant", default="all", choices=["all", *ALL_VARIANTS])
    splice_parser.add_argument("--seed", type=int, default=0)
    splice_parser.add_argument("--segment-len", type=int, default=4)
    splice_parser.add_argument("--min-exchanges", type=int, default=6)
    splice_parser.add_argument("--streams", type=int, default=50)
    splice_parser.add_argument("--strays-file", default=None)
    splice_parser.set_defaults(func=_cmd_splice)

    label_parser = sub.add_parser(
        "label", help="Interactively label natural topic switches in a scrubbed session"
    )
    label_parser.add_argument("scrubbed_file")
    label_parser.set_defaults(func=_cmd_label)

    label_export_parser = sub.add_parser(
        "label-export", help="Turn a labelled session into an eval stream"
    )
    label_export_parser.add_argument("scrubbed_file")
    label_export_parser.add_argument("labels_file")
    label_export_parser.add_argument("out_file")
    label_export_parser.set_defaults(func=_cmd_label_export)

    eval_parser = sub.add_parser("eval", help="Score Stage 0 (and baselines) against ground truth")
    eval_parser.add_argument("streams_file")
    eval_parser.add_argument("--natural", default=None, help="A bench label-export eval stream")
    eval_parser.add_argument("--config", default=None, help="A fern router config TOML file")
    eval_parser.set_defaults(func=_cmd_eval)

    sweep_parser = sub.add_parser(
        "sweep", help="Grid-search router thresholds (dev/test split by session, LOSO)"
    )
    sweep_parser.add_argument("streams_file")
    sweep_parser.add_argument("--manifest", default=None, help="Path to the splice manifest.json")
    sweep_parser.add_argument("--out", default=None, help="Where to write thresholds.toml")
    sweep_parser.set_defaults(func=_cmd_sweep)

    eval_stage2_parser = sub.add_parser(
        "eval-stage2",
        help="Sample + time-project, then run Stage 0+2 (local Ollama) against ground truth",
    )
    eval_stage2_parser.add_argument("streams_file")
    eval_stage2_parser.add_argument("--config", default=None, help="A fern router config TOML file")
    eval_stage2_parser.add_argument("--sample-size", type=int, default=500)
    eval_stage2_parser.add_argument("--seed", type=int, default=7)
    eval_stage2_parser.add_argument(
        "--models",
        default=None,
        help="Comma-separated model list for the sample comparison, default: "
        + ",".join(DEFAULT_STAGE2_MODELS),
    )
    eval_stage2_parser.add_argument(
        "--model",
        default=None,
        help="Force this model for the full run instead of the sample's pick",
    )
    eval_stage2_parser.add_argument("--ollama-url", default=None)
    eval_stage2_parser.add_argument("--max-hours", type=float, default=3.0)
    eval_stage2_parser.add_argument(
        "--skip-full",
        action="store_true",
        help="Stop after the sample comparison/projection, don't run the full dataset",
    )
    eval_stage2_parser.add_argument(
        "--skip-sample",
        action="store_true",
        help="Skip the sample comparison entirely and go straight to the full run "
        "(requires --model; use when you already have real sample results)",
    )
    eval_stage2_parser.set_defaults(func=_cmd_eval_stage2)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
