import json
from pathlib import Path

from bench.label import (
    LabelEvent,
    build_eval_stream,
    known_topics,
    load_labels,
    run_labeller,
    session_hash,
)
from bench.transcript import parse_session

FIXTURE = Path(__file__).parent / "fixtures" / "label_session.jsonl"


def _make_io(responses):
    it = iter(responses)
    printed: list[str] = []

    def input_fn(_prompt: str) -> str:
        return next(it)

    def print_fn(line: str) -> None:
        printed.append(line)

    return input_fn, print_fn, printed


def test_full_session_basic_sequence():
    exchanges = parse_session(FIXTURE).exchanges
    saved: list[LabelEvent] = []
    responses = iter(
        [
            "n",
            "auth-refactor",  # 0: new
            "c",  # 1: continue
            "s",  # 2: stray
            "r",
            "1",  # 3: return to topic #1 (auth-refactor)
            "n",
            "docker-build",  # 4: new
        ]
    )
    input_fn, print_fn, printed = _make_io(list(responses))

    labels = run_labeller(exchanges, {}, input_fn, print_fn, saved.append)

    assert [e.label for e in saved] == ["new", "continue", "stray", "return", "new"]
    assert labels[0] == LabelEvent(index=0, label="new", topic="auth-refactor")
    assert labels[1] == LabelEvent(index=1, label="continue")
    assert labels[2] == LabelEvent(index=2, label="stray")
    assert labels[3] == LabelEvent(index=3, label="return", topic="auth-refactor")
    assert labels[4] == LabelEvent(index=4, label="new", topic="docker-build")


def test_progress_is_shown_with_index_total_and_running_count():
    exchanges = parse_session(FIXTURE).exchanges[:2]
    input_fn, print_fn, printed = _make_io(["c", "c"])

    run_labeller(exchanges, {}, input_fn, print_fn, lambda _e: None)

    assert any("1/2" in line and "0 labeled" in line for line in printed)
    assert any("2/2" in line and "1 labeled" in line for line in printed)


def test_back_then_relabel_keeps_the_last_decision():
    exchanges = parse_session(FIXTURE).exchanges[:3]
    saved: list[LabelEvent] = []
    # label 0 as continue, label 1 as stray, go back, relabel 1 as continue, then label 2
    input_fn, print_fn, _ = _make_io(["c", "s", "b", "c", "s"])

    labels = run_labeller(exchanges, {}, input_fn, print_fn, saved.append)

    assert [(e.index, e.label) for e in saved] == [
        (0, "continue"),
        (1, "stray"),
        (1, "continue"),
        (2, "stray"),
    ]
    assert labels[1].label == "continue"  # last decision wins


def test_resume_rebuilds_known_topics_from_existing_labels():
    exchanges = parse_session(FIXTURE).exchanges
    existing = {
        0: LabelEvent(index=0, label="new", topic="auth-refactor"),
        1: LabelEvent(index=1, label="continue"),
    }
    saved: list[LabelEvent] = []
    # resumes at index 2; stray, then return (must be able to pick "auth-refactor"
    # even though this run never created it), then new
    input_fn, print_fn, printed = _make_io(["s", "r", "1", "n", "docker-build"])

    labels = run_labeller(exchanges, existing, input_fn, print_fn, saved.append)

    assert [e.index for e in saved] == [2, 3, 4]
    assert labels[3] == LabelEvent(index=3, label="return", topic="auth-refactor")
    assert any("auth-refactor" in line for line in printed)  # topic list was shown


def test_load_labels_last_line_wins(tmp_path: Path):
    path = tmp_path / "s.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"index": 0, "label": "new", "topic": "auth"}),
                json.dumps({"index": 1, "label": "stray"}),
                json.dumps({"index": 0, "label": "continue"}),  # overwrite index 0
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    labels = load_labels(path)
    assert labels[0] == LabelEvent(index=0, label="continue")
    assert labels[1] == LabelEvent(index=1, label="stray")


def test_known_topics_preserves_first_seen_order():
    labels = {
        0: LabelEvent(index=0, label="new", topic="auth-refactor"),
        1: LabelEvent(index=1, label="continue"),
        2: LabelEvent(index=2, label="new", topic="docker-build"),
        3: LabelEvent(index=3, label="return", topic="auth-refactor"),
    }
    assert known_topics(labels) == ["auth-refactor", "docker-build"]


def test_session_hash_deterministic_and_distinct():
    a = session_hash("session-one")
    b = session_hash("session-one")
    c = session_hash("session-two")
    assert a == b
    assert a != c
    assert len(a) == 16


def test_build_eval_stream_infers_continue_topic_and_marks_stray(tmp_path: Path):
    labels_path = tmp_path / "labels.jsonl"
    labels_path.write_text(
        "\n".join(
            [
                json.dumps({"index": 0, "label": "new", "topic": "auth-refactor"}),
                json.dumps({"index": 1, "label": "continue"}),
                json.dumps({"index": 2, "label": "stray"}),
                json.dumps({"index": 3, "label": "return", "topic": "auth-refactor"}),
                # index 4 left unlabelled on purpose
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    rows = build_eval_stream(FIXTURE, labels_path)

    assert [r["turn_index"] for r in rows] == [0, 1, 2, 3]
    assert all(r["stream_id"] == "label-session-one" for r in rows)
    assert rows[0]["branch_id"] == "auth-refactor"
    assert rows[0]["action_truth"] == "new"
    assert rows[1]["branch_id"] == "auth-refactor"  # continue inherits
    assert rows[1]["action_truth"] == "continue"
    assert rows[2]["branch_id"] is None  # stray
    assert rows[2]["action_truth"] == "stray"
    assert rows[3]["branch_id"] == "auth-refactor"
    assert rows[3]["action_truth"] == "return"
    assert all(r["variant"] == "natural" for r in rows)
