"""`bench` CLI: scrub and splice ReplayBench transcript fixtures."""

from __future__ import annotations

import argparse
from pathlib import Path

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
    counts = splice_to_file(
        Path(args.scrubbed_dir),
        Path(args.out_file),
        k=args.k,
        variant_arg=args.variant,
        seed=args.seed,
        segment_len=args.segment_len,
    )
    for variant in sorted(counts):
        print(f"{variant}\t{counts[variant]} turns")
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
    splice_parser.add_argument(
        "--variant", default="all", choices=["all", *ALL_VARIANTS]
    )
    splice_parser.add_argument("--seed", type=int, default=0)
    splice_parser.add_argument("--segment-len", type=int, default=4)
    splice_parser.set_defaults(func=_cmd_splice)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
