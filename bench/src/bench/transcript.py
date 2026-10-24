"""Parse Claude Code JSONL transcripts into Exchanges.

The routing unit is the *exchange*, not the raw JSONL record. A human prompt
is a ``type: "user"`` record whose ``message.content`` has a text block and
no ``tool_result`` block. An exchange is one human prompt plus every
following assistant/tool-result record up to (but not including) the next
human prompt. See bench/README.md for the JSONL schema this is parsing.

Sub-agent / sidechain records (``isSidechain: true``) are excluded from
exchanges entirely; their character count is tracked separately so callers
can report on it without it polluting the main thread.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

ToolSource = Literal["tool_input", "command"]

# Tools whose structured input directly names a single file path.
_FILE_PATH_INPUT_KEYS: dict[str, str] = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
}

# Tools whose structured input names a directory/glob root, not a file.
_DIR_PATH_INPUT_KEYS: dict[str, str] = {
    "Grep": "path",
    "Glob": "path",
}

# Tools whose input is a free-text shell command we scan heuristically.
_COMMAND_TOOLS = {"Bash", "PowerShell"}

# Extension allowlist for the command-text path heuristic. Deliberately
# narrow: this trades recall for precision so "1.2.3" or "example.com"
# don't get picked up as files.
_FILE_EXTENSIONS = (
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "json", "md", "toml",
    "yml", "yaml", "css", "scss", "html", "sh", "ps1", "rs", "go", "java",
    "c", "h", "cpp", "hpp", "sql", "lock", "txt", "ini", "cfg",
)

_COMMAND_PATH_RE = re.compile(
    r"(?<![\w./\\-])"
    r"(?:\.{1,2}/)?(?:[\w.-]+[/\\])+[\w.-]+\.(?:" + "|".join(_FILE_EXTENSIONS) + r")"
    r"(?![\w])"
)


@dataclass(frozen=True)
class FileTouch:
    path: str
    source: ToolSource


@dataclass(frozen=True)
class ToolCall:
    name: str
    input: dict
    files_touched: tuple[FileTouch, ...] = ()


@dataclass(frozen=True)
class Exchange:
    session_id: str
    index: int
    prompt_text: str
    assistant_text: str
    tool_calls: tuple[ToolCall, ...]
    files_touched: tuple[FileTouch, ...]
    size_chars: int


@dataclass(frozen=True)
class SkipNote:
    line: int
    reason: str


@dataclass
class ParsedSession:
    session_id: str | None
    exchanges: list[Exchange] = field(default_factory=list)
    sidechain_char_count: int = 0
    skipped: list[SkipNote] = field(default_factory=list)


def _extract_command_paths(command: str) -> list[FileTouch]:
    seen: set[str] = set()
    out: list[FileTouch] = []
    for match in _COMMAND_PATH_RE.finditer(command):
        token = match.group(0)
        if token in seen:
            continue
        seen.add(token)
        out.append(FileTouch(path=token, source="command"))
    return out


def _extract_tool_calls(content: object) -> list[ToolCall]:
    calls: list[ToolCall] = []
    if not isinstance(content, list):
        return calls
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = block.get("name") or ""
        raw_input = block.get("input")
        tool_input = raw_input if isinstance(raw_input, dict) else {}

        touches: list[FileTouch] = []
        file_key = _FILE_PATH_INPUT_KEYS.get(name)
        if file_key and isinstance(tool_input.get(file_key), str):
            touches.append(FileTouch(path=tool_input[file_key], source="tool_input"))
        dir_key = _DIR_PATH_INPUT_KEYS.get(name)
        if dir_key and isinstance(tool_input.get(dir_key), str):
            touches.append(FileTouch(path=tool_input[dir_key], source="tool_input"))
        if name in _COMMAND_TOOLS and isinstance(tool_input.get("command"), str):
            touches.extend(_extract_command_paths(tool_input["command"]))

        calls.append(ToolCall(name=name, input=tool_input, files_touched=tuple(touches)))
    return calls


def _text_blocks(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "".join(parts)


def _char_len(record: dict) -> int:
    message = record.get("message")
    if not isinstance(message, dict):
        return 0
    content = message.get("content")
    if isinstance(content, str):
        return len(content)
    if not isinstance(content, list):
        return 0
    total = 0
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            total += len(block.get("text") or "")
        elif block_type == "thinking":
            total += len(block.get("thinking") or "")
        elif block_type == "tool_use":
            total += len(json.dumps(block.get("input") or {}, sort_keys=True))
        elif block_type == "tool_result":
            result_content = block.get("content")
            if isinstance(result_content, str):
                total += len(result_content)
            elif isinstance(result_content, list):
                for result_block in result_content:
                    if isinstance(result_block, dict) and result_block.get("type") == "text":
                        total += len(result_block.get("text") or "")
    return total


def is_human_prompt(record: dict) -> bool:
    """A user record with a text block and no tool_result block."""
    if record.get("type") != "user":
        return False
    message = record.get("message")
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if not isinstance(content, list):
        return False
    has_text = False
    has_tool_result = False
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            has_text = True
        elif block_type == "tool_result":
            has_tool_result = True
    return has_text and not has_tool_result


def parse_session(path: Path) -> ParsedSession:
    session_id: str | None = None
    exchanges: list[Exchange] = []
    skipped: list[SkipNote] = []
    sidechain_chars = 0

    current_prompt: str | None = None
    current_assistant_parts: list[str] = []
    current_tool_calls: list[ToolCall] = []
    current_size = 0
    index = 0

    def flush() -> None:
        nonlocal current_prompt, current_assistant_parts, current_tool_calls, current_size, index
        if current_prompt is not None:
            touches: list[FileTouch] = []
            for call in current_tool_calls:
                touches.extend(call.files_touched)
            exchanges.append(
                Exchange(
                    session_id=session_id or "",
                    index=index,
                    prompt_text=current_prompt,
                    assistant_text="".join(current_assistant_parts),
                    tool_calls=tuple(current_tool_calls),
                    files_touched=tuple(touches),
                    size_chars=current_size,
                )
            )
            index += 1
        current_prompt = None
        current_assistant_parts = []
        current_tool_calls = []
        current_size = 0

    with path.open(encoding="utf-8") as f:
        for lineno, raw_line in enumerate(f, start=1):
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                skipped.append(SkipNote(line=lineno, reason=f"invalid JSON: {exc.msg}"))
                continue
            if not isinstance(record, dict):
                skipped.append(SkipNote(line=lineno, reason="record is not a JSON object"))
                continue

            record_session_id = record.get("sessionId")
            if session_id is None and isinstance(record_session_id, str):
                session_id = record_session_id

            record_type = record.get("type")
            if record_type not in ("user", "assistant"):
                continue  # non-turn metadata record (mode, ai-title, ...): not an error

            if record.get("isSidechain") is True:
                sidechain_chars += _char_len(record)
                continue

            message = record.get("message")
            if not isinstance(message, dict):
                reason = f"{record_type} record missing 'message'"
                skipped.append(SkipNote(line=lineno, reason=reason))
                continue

            if record_type == "user":
                if is_human_prompt(record):
                    flush()
                    current_prompt = _text_blocks(message.get("content"))
                    current_size += _char_len(record)
                else:
                    current_size += _char_len(record)
                continue

            # assistant record
            content = message.get("content")
            current_assistant_parts.append(_text_blocks(content))
            current_tool_calls.extend(_extract_tool_calls(content))
            current_size += _char_len(record)

    flush()
    return ParsedSession(
        session_id=session_id,
        exchanges=exchanges,
        sidechain_char_count=sidechain_chars,
        skipped=skipped,
    )


def iter_exchanges(path: Path) -> Iterator[Exchange]:
    yield from parse_session(path).exchanges
