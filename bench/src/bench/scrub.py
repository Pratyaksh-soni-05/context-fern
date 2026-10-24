"""Deterministically replace secrets, PII and absolute paths in Claude Code
JSONL transcripts with typed placeholders, so they're safe to use as
ReplayBench fixtures.

Design notes (see bench/README.md for the full writeup):

- Operates on the parsed JSON structure, not raw lines, so it can walk every
  nested string value (tool inputs, tool_result content, backup/snapshot
  metadata, ...), not just top-level fields.
- "thinking" content blocks are dropped entirely rather than scrubbed.
- Known path-bearing fields (cwd, file_path, ...) are scrubbed as whole
  values against the session's detected project root(s), which is what lets
  an absolute path collapse to <PATH:/repo/relative/tail> without leaking the
  machine/username prefix. Free-text fields (prose, Bash/PowerShell command
  strings) get a best-effort regex pass instead, backed by the denylist as a
  last line of defense for anything the regex under-matches (e.g. a Windows
  path with a spacey username).
- Every secret-token pattern tolerates exactly one embedded newline inside
  the token body, so a key that got soft-wrapped mid-token still matches as
  one span instead of leaking a fragment.
"""

from __future__ import annotations

import getpass
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


def _token_body(min_len: int, extra: str = "") -> str:
    """A key-shaped run of chars that tolerates one embedded newline."""
    return rf"(?:[A-Za-z0-9_\-{extra}]|\r?\n){{{min_len},}}"


_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"
)
_JWT_RE = re.compile(
    r"\beyJ(?:[A-Za-z0-9_-]|\r?\n)+\.(?:[A-Za-z0-9_-]|\r?\n)+\.(?:[A-Za-z0-9_-]|\r?\n)+"
)
_ANTHROPIC_RE = re.compile(r"\bsk-ant-" + _token_body(20))
_OPENAI_RE = re.compile(r"\bsk-(?!ant-)" + _token_body(20))
_GITHUB_RE = re.compile(r"\bgh[pousr]_" + _token_body(30))
_AWS_RE = re.compile(r"\bAKIA" + _token_body(12))
_GOOGLE_RE = re.compile(r"\bAIza" + _token_body(31))
_BEARER_RE = re.compile(r"(?i)\bBearer\s+" + _token_body(10, r"."))
_ENV_SECRET_RE = re.compile(
    r"(?im)^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PWD|CREDENTIAL)[A-Z0-9_]*)[ \t]*=[ \t]*(\S+)"
)

# (label, pattern) — order matters: more specific prefixes before general ones.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private_key", _PRIVATE_KEY_RE),
    ("jwt", _JWT_RE),
    ("anthropic", _ANTHROPIC_RE),
    ("openai", _OPENAI_RE),
    ("github", _GITHUB_RE),
    ("aws", _AWS_RE),
    ("google", _GOOGLE_RE),
)

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_URL_RE = re.compile(r"\b(https?)://([^/\s\"'<>]+)((?:/[^\s\"'<>]*)?)")

# Free-text (no-spaces) absolute path heuristics, combined into one pattern
# so a single .sub() pass handles both — two sequential passes would let the
# POSIX branch re-match the "/repo/..." tail of a placeholder the Windows
# branch just produced, double-wrapping it. Structured path fields are
# handled exactly instead — see _PATH_FIELD_NAMES below.
_ABS_TEXT_PATH_RE = re.compile(
    r"\b[A-Za-z]:[\\/](?:[^\s\"'<>:|?*\\/]+[\\/])*[^\s\"'<>:|?*\\/]+"
    r"|/(?:[^\s\"'<>|]+/)+[^\s\"'<>|]*"
)

_ALLOWED_HOSTS = (
    "github.com",
    "npmjs.com",
    "pypi.org",
    "docs.anthropic.com",
    "code.claude.com",
    "stackoverflow.com",
)

# Keys whose string value is a whole path (never prose), scrubbed atomically
# instead of via regex-in-text. A relative value is left untouched so file
# overlap keeps working; an absolute one is relativized or opaqued.
_PATH_FIELD_NAMES = {
    "cwd",
    "backgroundCwdHint",
    "realParentDir",
    "trackingPath",
    "backupFileName",
    "originalFile",
    "file_path",
    "filePath",
    "path",
    "displayPath",
    "filename",
    "filenames",
    "addedNames",
    "removedNames",
    "readdedNames",
}

_ROOT_FIELD_NAMES = {"cwd", "backgroundCwdHint", "realParentDir"}


@dataclass
class SkipNote:
    line: int
    reason: str


@dataclass
class ScrubState:
    roots: list[str] = field(default_factory=list)
    counts: Counter[str] = field(default_factory=Counter)
    email_index: dict[str, dict[str, int]] = field(default_factory=dict)
    denylist_re: re.Pattern[str] | None = None


def load_denylist(explicit_path: Path | None = None) -> list[str]:
    terms: list[str] = []
    path = explicit_path or (Path(__file__).resolve().parents[2] / "denylist.txt")
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            terms.append(line)
    try:
        username = getpass.getuser()
        if username:
            terms.append(username)
    except Exception:
        pass
    home_name = Path.home().name
    if home_name:
        terms.append(home_name)
    return terms


def _build_denylist_regex(terms: list[str]) -> re.Pattern[str] | None:
    escaped = sorted(
        {re.escape(t) for t in terms if t.strip()},
        key=len,
        reverse=True,
    )
    if not escaped:
        return None
    return re.compile(r"(?i)\b(?:" + "|".join(escaped) + r")\b")


def _normalize_dir(path_str: str) -> str:
    return path_str.replace("\\", "/").rstrip("/")


def _is_absolute(path_str: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:[\\/]", path_str)) or path_str.startswith("/")


def _relativize(path_str: str, roots: list[str]) -> str | None:
    norm = _normalize_dir(path_str)
    norm_cf = norm.casefold()
    for root in roots:
        root_cf = root.casefold()
        if norm_cf == root_cf:
            return ""
        if norm_cf.startswith(root_cf + "/"):
            return norm[len(root) + 1 :]
    return None


def _collect_roots(records: list[dict]) -> list[str]:
    roots: set[str] = set()

    def walk(value: object, key: str | None) -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, k)
        elif isinstance(value, list):
            for item in value:
                walk(item, key)
        elif isinstance(value, str) and key in _ROOT_FIELD_NAMES:
            norm = _normalize_dir(value)
            if norm:
                roots.add(norm)

    for record in records:
        walk(record, None)
    return sorted(roots, key=len, reverse=True)


def _scrub_path_field_value(value: str, state: ScrubState) -> str | None:
    """Returns the scrubbed value, or None if `value` isn't absolute."""
    if not _is_absolute(value):
        return None
    state.counts["PATH"] += 1
    rel = _relativize(value, state.roots)
    if rel is None:
        return "<PATH>"
    return f"<PATH:/repo/{rel}>" if rel else "<PATH:/repo>"


def _scrub_emails(text: str, session_id: str, state: ScrubState) -> str:
    def repl(m: re.Match[str]) -> str:
        email_key = m.group(0).casefold()
        idx_map = state.email_index.setdefault(session_id, {})
        if email_key not in idx_map:
            idx_map[email_key] = len(idx_map) + 1
        state.counts["EMAIL"] += 1
        return f"<EMAIL:{idx_map[email_key]}>"

    return _EMAIL_RE.sub(repl, text)


def _scrub_env_secrets(text: str, state: ScrubState) -> str:
    def repl(m: re.Match[str]) -> str:
        name, value = m.group(1), m.group(2)
        if value.startswith("<") and value.endswith(">"):
            return m.group(0)  # already a placeholder from an earlier pass
        state.counts["SECRET:env"] += 1
        return f"{name}=<SECRET:env>"

    return _ENV_SECRET_RE.sub(repl, text)


def _scrub_bearer(text: str, state: ScrubState) -> str:
    def repl(m: re.Match[str]) -> str:
        state.counts["SECRET:bearer"] += 1
        return "Bearer <SECRET:bearer>"

    return _BEARER_RE.sub(repl, text)


def _host_allowed(host: str) -> bool:
    host_only = host.split(":", 1)[0].casefold()
    return any(host_only == h or host_only.endswith("." + h) for h in _ALLOWED_HOSTS)


def _protect_urls(text: str, sentinels: list[str], state: ScrubState) -> str:
    def repl(m: re.Match[str]) -> str:
        scheme, authority, rest = m.group(1), m.group(2), m.group(3)
        if _host_allowed(authority):
            resolved = f"{scheme}://{authority}{rest}"
        else:
            state.counts["HOST"] += 1
            resolved = f"{scheme}://<HOST>{rest}"
        token = f"\x00URL{len(sentinels)}\x00"
        sentinels.append(resolved)
        return token

    return _URL_RE.sub(repl, text)


def _restore_urls(text: str, sentinels: list[str]) -> str:
    for i, resolved in enumerate(sentinels):
        text = text.replace(f"\x00URL{i}\x00", resolved)
    return text


def _scrub_free_text_paths(text: str, state: ScrubState) -> str:
    def repl(m: re.Match[str]) -> str:
        state.counts["PATH"] += 1
        rel = _relativize(m.group(0), state.roots)
        if rel is None:
            return "<PATH>"
        return f"<PATH:/repo/{rel}>" if rel else "<PATH:/repo>"

    return _ABS_TEXT_PATH_RE.sub(repl, text)


def _scrub_denylist(text: str, state: ScrubState) -> str:
    if state.denylist_re is None:
        return text

    def repl(_m: re.Match[str]) -> str:
        state.counts["NAME"] += 1
        return "<NAME>"

    return state.denylist_re.sub(repl, text)


def _scrub_generic_text(text: str, session_id: str, state: ScrubState) -> str:
    sentinels: list[str] = []
    text = _protect_urls(text, sentinels, state)

    for label, pattern in _SECRET_PATTERNS:
        def repl(m: re.Match[str], label: str = label) -> str:
            state.counts[f"SECRET:{label}"] += 1
            return f"<SECRET:{label}>"

        text = pattern.sub(repl, text)

    text = _scrub_bearer(text, state)
    text = _scrub_env_secrets(text, state)
    text = _scrub_emails(text, session_id, state)
    text = _IPV4_RE.sub(lambda m: (state.counts.update(IP=1), "<IP>")[1], text)
    text = _scrub_free_text_paths(text, state)
    text = _scrub_denylist(text, state)

    return _restore_urls(text, sentinels)


def _scrub_string(value: str, key: str | None, session_id: str, state: ScrubState) -> str:
    if key in _PATH_FIELD_NAMES:
        handled = _scrub_path_field_value(value, state)
        if handled is not None:
            return handled
    return _scrub_generic_text(value, session_id, state)


def _scrub_value(value: object, key: str | None, session_id: str, state: ScrubState) -> object:
    if isinstance(value, dict):
        return {k: _scrub_value(v, k, session_id, state) for k, v in value.items()}
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, dict) and item.get("type") == "thinking":
                continue  # drop thinking blocks entirely
            out.append(_scrub_value(item, key, session_id, state))
        return out
    if isinstance(value, str):
        return _scrub_string(value, key, session_id, state)
    return value


def scrub_record(record: dict, state: ScrubState) -> dict:
    session_id = record.get("sessionId") or ""
    return _scrub_value(record, None, session_id, state)  # type: ignore[return-value]


def scrub_file(in_path: Path, out_path: Path, state: ScrubState) -> list[SkipNote]:
    skipped: list[SkipNote] = []
    records: list[dict] = []

    with in_path.open(encoding="utf-8") as f:
        for lineno, raw_line in enumerate(f, start=1):
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                obj = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                skipped.append(SkipNote(line=lineno, reason=f"invalid JSON: {exc.msg}"))
                continue
            if not isinstance(obj, dict):
                skipped.append(SkipNote(line=lineno, reason="record is not a JSON object"))
                continue
            records.append(obj)

    state.roots = sorted(set(state.roots) | set(_collect_roots(records)), key=len, reverse=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as out:
        for record in records:
            scrubbed = scrub_record(record, state)
            out.write(json.dumps(scrubbed, ensure_ascii=False))
            out.write("\n")

    return skipped


def scrub_directory(
    in_dir: Path, out_dir: Path, denylist_path: Path | None = None
) -> tuple[Counter[str], dict[Path, list[SkipNote]]]:
    state = ScrubState()
    state.denylist_re = _build_denylist_regex(load_denylist(denylist_path))

    all_skipped: dict[Path, list[SkipNote]] = {}
    for in_path in sorted(in_dir.glob("*.jsonl")):
        out_path = out_dir / in_path.name
        skipped = scrub_file(in_path, out_path, state)
        if skipped:
            all_skipped[in_path] = skipped

    return state.counts, all_skipped
