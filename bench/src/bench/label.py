"""Interactive terminal labeller for natural-switch ground truth, plus a
loader that turns a labelled session into an eval stream shaped like
splice.py's output.

The labelling loop (`run_labeller`) is a pure-ish function: it takes
`input_fn`/`print_fn` instead of calling `input()`/`print()` directly, and
an `on_label` callback instead of writing to disk itself. This is what
makes it testable by simulating keypresses — see bench/tests/test_label.py.
The real `bench label` command is a thin wrapper around it that wires
stdin/stdout and an append-only JSONL writer.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from bench.transcript import Exchange, parse_session

PROMPT_CHARS = 300


@dataclass(frozen=True)
class LabelEvent:
    index: int
    label: str  # "continue" | "new" | "return" | "stray"
    topic: str | None = None  # topic name, set for "new" and "return"

    def to_json(self) -> dict:
        d: dict = {"index": self.index, "label": self.label}
        if self.topic is not None:
            d["topic"] = self.topic
        return d


def session_hash(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


def load_labels(path: Path) -> dict[int, LabelEvent]:
    """Last line wins per index (append-only journal semantics)."""
    labels: dict[int, LabelEvent] = {}
    if not path.exists():
        return labels
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        labels[obj["index"]] = LabelEvent(
            index=obj["index"], label=obj["label"], topic=obj.get("topic")
        )
    return labels


def known_topics(labels: dict[int, LabelEvent]) -> list[str]:
    seen: list[str] = []
    for ev in sorted(labels.values(), key=lambda e: e.index):
        if ev.topic and ev.topic not in seen:
            seen.append(ev.topic)
    return seen


def format_exchange(exchange: Exchange) -> str:
    text = exchange.prompt_text[:PROMPT_CHARS]
    files = ", ".join(t.path for t in exchange.files_touched) or "(none)"
    return f"{text}\nfiles touched: {files}"


def run_labeller(
    exchanges: list[Exchange],
    initial_labels: dict[int, LabelEvent],
    input_fn: Callable[[str], str],
    print_fn: Callable[[str], None],
    on_label: Callable[[LabelEvent], None],
) -> dict[int, LabelEvent]:
    labels = dict(initial_labels)
    topics = known_topics(labels)
    total = len(exchanges)
    i = max(labels) + 1 if labels else 0

    while 0 <= i < total:
        exchange = exchanges[i]
        print_fn(f"--- exchange {i + 1}/{total} · {len(labels)} labeled so far ---")
        print_fn(format_exchange(exchange))
        choice = input_fn("c=continue n=new r=return s=stray b=back> ").strip().lower()

        if choice == "b":
            i = max(0, i - 1)
            continue
        if choice == "c":
            event = LabelEvent(index=i, label="continue")
        elif choice == "n":
            name = input_fn("name this topic: ").strip()
            if name and name not in topics:
                topics.append(name)
            event = LabelEvent(index=i, label="new", topic=name or None)
        elif choice == "r":
            if not topics:
                print_fn("no earlier topics yet")
                continue
            for idx, name in enumerate(topics, start=1):
                print_fn(f"  {idx}. {name}")
            pick = input_fn("pick topic number> ").strip()
            try:
                topic = topics[int(pick) - 1]
            except (ValueError, IndexError):
                print_fn("invalid choice")
                continue
            event = LabelEvent(index=i, label="return", topic=topic)
        elif choice == "s":
            event = LabelEvent(index=i, label="stray")
        else:
            print_fn("unrecognized choice")
            continue

        labels[i] = event
        on_label(event)
        i += 1

    return labels


def label_session(session_path: Path, labels_dir: Path | None = None) -> Path:
    """Real CLI entry point: wires run_labeller to stdin/stdout and an
    append-only JSONL file, resuming from wherever that file left off."""
    parsed = parse_session(session_path)
    session_id = parsed.session_id or session_path.stem
    labels_dir = labels_dir or (Path(__file__).resolve().parents[2] / "data" / "labels")
    labels_dir.mkdir(parents=True, exist_ok=True)
    labels_path = labels_dir / f"{session_hash(session_id)}.jsonl"

    existing = load_labels(labels_path)

    with labels_path.open("a", encoding="utf-8") as f:
        def on_label(event: LabelEvent) -> None:
            f.write(json.dumps(event.to_json(), ensure_ascii=False))
            f.write("\n")
            f.flush()

        run_labeller(parsed.exchanges, existing, input, print, on_label)

    return labels_path


def _active_topic_before(labels: dict[int, LabelEvent], index: int) -> str | None:
    for i in range(index - 1, -1, -1):
        event = labels.get(i)
        if event and event.topic:
            return event.topic
    return None


def build_eval_stream(session_path: Path, labels_path: Path) -> list[dict]:
    """Turn a labelled session into eval-stream rows shaped like splice.py's
    output: {turn_index, branch_id, action_truth, variant: "natural", turn}.
    Unlabelled exchanges are skipped rather than guessed."""
    parsed = parse_session(session_path)
    labels = load_labels(labels_path)

    rows: list[dict] = []
    for i, exchange in enumerate(parsed.exchanges):
        event = labels.get(i)
        if event is None:
            continue
        if event.label == "stray":
            branch_id = None
        elif event.topic:
            branch_id = event.topic
        else:
            branch_id = _active_topic_before(labels, i)
        rows.append(
            {
                "turn_index": i,
                "branch_id": branch_id,
                "action_truth": event.label,
                "variant": "natural",
                "turn": asdict(exchange),
            }
        )
    return rows
