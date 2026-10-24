"""`bench` CLI: scrub, splice, label, eval and sweep ReplayBench transcript
fixtures and Stage 0 router results."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from bench.label import build_eval_stream, label_session
from bench.run import REPO_ROOT, compute_metrics, join_predictions_with_truth, run_route_replay
from bench.scrub import scrub_directory
from bench.splice import ALL_VARIANTS, splice_to_file

MODES = ["full", "always-continue", "cue-only", "embeddings-only"]
SWEEP_SCRIPT = REPO_ROOT / "bench" / "ts" / "sweep.ts"


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

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
