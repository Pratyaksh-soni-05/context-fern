import json
from pathlib import Path

from bench.scrub import scrub_directory

FIXTURES = Path(__file__).parent / "fixtures"


def _run(tmp_path: Path, denylist_path: Path | None = None):
    out_dir = tmp_path / "out"
    counts, skipped = scrub_directory(FIXTURES, out_dir, denylist_path=denylist_path)
    lines = (out_dir / "scrub_cases.jsonl").read_text(encoding="utf-8").splitlines()
    records = [json.loads(line) for line in lines]
    return records, counts, skipped


def _text(record: dict) -> str:
    content = record["message"]["content"]
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "tool_result":
            for b in block.get("content", []):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
    return "".join(parts)


def test_emails_indexed_and_scoped_per_session(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    gamma_text = _text(records[0])
    assert "<EMAIL:1>" in gamma_text
    assert gamma_text.count("<EMAIL:1>") == 2  # alice@example.com appears twice
    assert "<EMAIL:2>" in gamma_text  # bob@example.com
    assert "alice@example.com" not in gamma_text
    assert "bob@example.com" not in gamma_text

    tool_result_text = _text(records[2])
    assert "<EMAIL:3>" in tool_result_text  # dave@example.com, third in this session

    delta_text = _text(records[3])
    assert "<EMAIL:1>" in delta_text  # same literal address, different session -> fresh index 1
    assert "alice@example.com" not in delta_text


def test_ip_and_url_host_allowlist(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    text = _text(records[0])
    assert "10.0.0.5" not in text
    assert "<IP>" in text
    assert "https://github.com/org/repo" in text  # allowlisted, untouched
    assert "https://example.com/internal/dash" not in text
    assert "https://<HOST>/internal/dash" in text


def test_secret_patterns_including_newline_evasion(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    text = _text(records[1])
    assert "sk-ant-" not in text
    assert "ABCDEFGHIJKLMNOPQRSTUVWX" not in text
    assert "KLMNOPQRSTUVWX" not in text  # the newline-split fragment must not survive
    assert "ANTHROPIC_API_KEY=<SECRET:anthropic>" in text
    assert text.count("<SECRET:anthropic>") == 3

    tool_result_text = _text(records[2])
    assert "Bearer <SECRET:bearer>" in tool_result_text
    assert "abcdefghijklmnop1234" not in tool_result_text


def test_thinking_block_dropped_entirely(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    content = records[1]["message"]["content"]
    assert all(block.get("type") != "thinking" for block in content)
    assert not any("internal reasoning" in json.dumps(block) for block in content)


def test_structured_path_fields_relativized(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    assert records[0]["cwd"] == "<PATH:/repo>"
    assert records[1]["cwd"] == "<PATH:/repo>"

    tool_use = next(b for b in records[1]["message"]["content"] if b.get("type") == "tool_use")
    assert tool_use["input"]["file_path"] == "<PATH:/repo/src/auth.ts>"


def test_windows_path_relativized_and_relative_path_untouched(tmp_path: Path):
    records, counts, _ = _run(tmp_path)
    assert records[3]["cwd"] == "<PATH:/repo>"
    text = _text(records[3])
    assert "C:\\Users\\alice\\project" not in text
    assert "<PATH:/repo/src/index.ts>" in text
    assert "src/already-relative.ts" in text  # relative path kept intact


def test_denylist_replaces_personal_names(tmp_path: Path):
    # Deliberately isolated from scrub_cases.jsonl: "alice" there always gets
    # pre-consumed by the email/path passes before denylist ever sees it.
    # The denylist's job is plain-prose mentions those passes don't touch.
    in_dir = tmp_path / "in"
    in_dir.mkdir()
    (in_dir / "prose.jsonl").write_text(
        '{"type":"user","sessionId":"s1","isSidechain":false,'
        '"message":{"role":"user","content":[{"type":"text",'
        '"text":"carol said the fix looks good, thanks Carol"}]}}\n',
        encoding="utf-8",
    )
    denylist = tmp_path / "denylist.txt"
    denylist.write_text("carol\n# a comment\n", encoding="utf-8")

    out_dir = tmp_path / "out"
    counts, _ = scrub_directory(in_dir, out_dir, denylist_path=denylist)
    text = _text(json.loads((out_dir / "prose.jsonl").read_text(encoding="utf-8")))

    assert "carol" not in text.lower()
    assert text.count("<NAME>") == 2  # case-insensitive, both mentions
    assert counts["NAME"] == 2


def test_counts_report_types_not_values(tmp_path: Path):
    _, counts, _ = _run(tmp_path)
    assert counts["EMAIL"] == 5
    assert counts["IP"] == 1
    assert counts["HOST"] == 1
    assert counts["SECRET:anthropic"] == 3
    assert counts["SECRET:bearer"] == 1
    assert counts["PATH"] >= 4


def test_deterministic_same_input_same_output(tmp_path: Path):
    records_a, counts_a, _ = _run(tmp_path / "run_a")
    records_b, counts_b, _ = _run(tmp_path / "run_b")
    assert records_a == records_b
    assert counts_a == counts_b
