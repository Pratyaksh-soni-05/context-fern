"""`bench` CLI: scrub, splice, and label ReplayBench transcript fixtures."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from bench.label import build_eval_stream, label_session
from bench.scrub import scrub_directory
from bench.splice import ALL_VARIANTS, splice_to_file


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

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
