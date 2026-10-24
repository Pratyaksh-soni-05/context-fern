from pathlib import Path

from bench.transcript import is_human_prompt, parse_session

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_two_exchanges_and_excludes_sidechain():
    parsed = parse_session(FIXTURES / "session_alpha.jsonl")

    assert parsed.session_id == "session-alpha-0001"
    assert len(parsed.exchanges) == 2

    first, second = parsed.exchanges
    assert first.index == 0
    assert first.prompt_text == "look into the auth bug in src/auth.ts"
    assert first.assistant_text == "sure, checking nowfound the bug, running a search"
    assert [c.name for c in first.tool_calls] == ["Read", "Bash"]

    assert second.index == 1
    assert second.prompt_text == "now check the docker build"
    assert [c.name for c in second.tool_calls] == ["Edit"]

    assert parsed.skipped == []


def test_files_touched_tagged_by_source():
    parsed = parse_session(FIXTURES / "session_alpha.jsonl")
    first = parsed.exchanges[0]

    by_source = {(t.path, t.source) for t in first.files_touched}
    assert ("src/auth.ts", "tool_input") in by_source
    assert ("src/auth.ts", "command") in by_source
    assert ("packages/core/src/index.ts", "command") in by_source

    second = parsed.exchanges[1]
    assert second.files_touched == (("docker/Dockerfile", "tool_input"),) or {
        t.path for t in second.files_touched
    } == {"docker/Dockerfile"}


def test_sidechain_content_excluded_but_counted():
    parsed = parse_session(FIXTURES / "session_alpha.jsonl")
    expected = len(
        "this is a long internal sidechain thought that should be "
        "counted separately and never appear in any exchange"
    )
    assert parsed.sidechain_char_count == expected

    all_text = " ".join(
        e.prompt_text + e.assistant_text for e in parsed.exchanges
    )
    assert "sidechain" not in all_text


def test_malformed_lines_are_skipped_with_reasons_not_crashes():
    parsed = parse_session(FIXTURES / "session_malformed.jsonl")

    assert len(parsed.exchanges) == 2
    assert parsed.exchanges[0].prompt_text == "hello"
    assert parsed.exchanges[1].prompt_text == "second prompt"

    assert len(parsed.skipped) == 2
    assert parsed.skipped[0].line == 2
    assert "invalid JSON" in parsed.skipped[0].reason
    assert parsed.skipped[1].line == 3
    assert "missing 'message'" in parsed.skipped[1].reason


def test_is_human_prompt_classification():
    assert is_human_prompt(
        {"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}}
    )
    assert not is_human_prompt(
        {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "x"}]},
        }
    )
    assert not is_human_prompt(
        {
            "type": "user",
            "message": {
                "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "tool_result", "tool_use_id": "x"},
                ]
            },
        }
    )
    assert not is_human_prompt({"type": "assistant", "message": {"content": []}})
    assert not is_human_prompt({"type": "user", "message": {"content": []}})
