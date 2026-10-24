# bench — ReplayBench

Scrubber, splicer, runner and metrics for Context Fern's router (spec §13).
Python 3.12 via uv; see root `CLAUDE.md` for the project-wide commands.

```
uv run --project bench bench scrub <in_dir> <out_dir>
uv run --project bench bench splice <scrubbed_dir> <out_file> --k 3 --variant all --seed 7
uv run --project bench pytest
uv run --project bench ruff check
```

All examples below use made-up session ids, file paths and timestamps —
none of this is real transcript content.

## The Claude Code JSONL transcript format

A transcript is one JSONL file per session (plus one file per sub-agent
task, sharing the parent's `sessionId`). Every line is a JSON object with
a top-level `"type"`. The two types that carry conversation are `"user"`
and `"assistant"`; the rest (`mode`, `system`, `ai-title`, `last-prompt`,
`pr-link`, `frame-link`, `queue-operation`, `attachment`,
`file-history-snapshot`, `file-history-delta`) are session/UI bookkeeping
and carry no turn content — `transcript.py` skips them without treating
that as an error.

```json
{"type": "user", "sessionId": "session-fake-0001", "isSidechain": false,
 "cwd": "/repo", "timestamp": "2026-01-01T00:00:00Z",
 "message": {"role": "user", "content": [
   {"type": "text", "text": "look into the auth bug in src/auth.ts"}
 ]}}
```

A `"user"` record is either a **human prompt** (a `text` content block,
no `tool_result` block) or a **tool-result record** (a `tool_result`
block, no `text` block) — never both in the data we've seen. A
`"tool_result"` block carries `tool_use_id`, `is_error`, and its own
nested `content` (usually `text` blocks, occasionally `image`).

```json
{"type": "assistant", "sessionId": "session-fake-0001", "isSidechain": false,
 "message": {"role": "assistant", "content": [
   {"type": "text", "text": "sure, checking now"},
   {"type": "thinking", "thinking": "internal reasoning, dropped by scrub.py"},
   {"type": "tool_use", "id": "tool-fake-1", "name": "Read",
    "input": {"file_path": "src/auth.ts"}}
 ]}}
```

An `"assistant"` record's `message.content` mixes `text`, `thinking` and
`tool_use` blocks. `tool_use.input` shape depends on `name` — `Read` /
`Edit` / `Write` carry `file_path`; `Grep` / `Glob` carry `path`; `Bash` /
`PowerShell` carry a free-text `command` string with no structured path at
all (handled by a heuristic — see below).

**Sidechains.** Sub-agent and sidechain records are marked `"isSidechain":
true` and always carry a non-empty `agentId`; in our real data, a
dedicated `agent-*.jsonl` file is *entirely* sidechain (100% of its
records), while a main session file has none. `transcript.py` excludes
these from exchanges entirely but still counts their characters, so a
report can show "this much sidechain activity happened" without it
polluting the main thread or the frond definition.

**Absolute paths and usernames** show up scattered across many fields, not
just one place: `cwd`, `backgroundCwdHint`, tool `input.file_path`,
`toolUseResult.originalFile`, `backup.realParentDir`, and inline inside
`Bash`/`PowerShell` command text. `scrub.py` walks every nested string
value for this reason, not just a fixed set of top-level fields.

## Exchanges (transcript.py)

The routing unit is the **exchange**, not the raw record: one human prompt
plus every following assistant/tool-result record up to (not including)
the next human prompt.

```python
Exchange(
    session_id="session-fake-0001",
    index=0,
    prompt_text="look into the auth bug in src/auth.ts",
    assistant_text="sure, checking now",
    tool_calls=(ToolCall(name="Read", input={"file_path": "src/auth.ts"}, ...),),
    files_touched=(FileTouch(path="src/auth.ts", source="tool_input"),),
    size_chars=123,
)
```

`files_touched` is tagged by `source`: `"tool_input"` for paths read
straight out of structured tool input (`Read`/`Edit`/`Write`/`Grep`/`Glob`),
`"command"` for paths heuristically extracted from `Bash`/`PowerShell`
command text (a narrow regex requiring a recognized file extension, to
trade recall for precision). Keeping the two tagged separately lets a
later router experiment measure each signal's value on its own.

## Scrubbing (scrub.py)

Walks the parsed JSON recursively (not just top-level fields) and replaces,
deterministically:

| Finds | Placeholder |
| --- | --- |
| Anthropic / OpenAI / GitHub / AWS / Google key patterns | `<SECRET:anthropic>` etc. |
| Bearer tokens, JWTs, PEM private-key blocks | `<SECRET:bearer>`, `<SECRET:jwt>`, `<SECRET:private_key>` |
| `.env`-style `SOME_KEY=value` lines | `SOME_KEY=<SECRET:env>` |
| Email addresses | `<EMAIL:1>`, `<EMAIL:2>`, ... — stable within one `sessionId`, so the router can tell "same person again" from "someone new" without seeing the address. Two different sessions mentioning the same real address get independent numbering. |
| IPv4 addresses | `<IP>` |
| URL hostnames, except an allowlist of public hosts (github.com, npmjs.com, pypi.org, docs.anthropic.com, code.claude.com, stackoverflow.com and their subdomains) | `<HOST>` — path and scheme kept |
| Absolute paths (Windows and POSIX) | `<PATH:/repo/<relative-tail>>` when relativizable against a detected project root, else opaque `<PATH>` — a **relative** path (`src/auth.ts`) is left untouched, because the router needs file overlap |
| Personal names (`bench/denylist.txt`, gitignored — copy `denylist.example.txt`) plus the OS username and home-folder name, auto-added | `<NAME>` |

`thinking` content blocks are dropped entirely rather than scrubbed.

**Known-path fields are scrubbed exactly, not by regex.** Fields like
`cwd`, `file_path`, `trackingPath`, `backupFileName` hold nothing but a
path — scrub.py relativizes or opaques the *whole* value rather than
regex-matching a substring. This is what makes the Windows case
survivable: a path like `C:\Users\Jane Smith\project\src\auth.ts` has a
space in the username segment, which a prose regex can't safely swallow
(it would need to decide where a plain English sentence ends and the path
starts). Free-text mentions (inside a Bash command, or prose) get a
best-effort no-spaces regex instead; the denylist is the backstop that
still catches a bare leaked name fragment even when the regex under-matches.

**Evasion handling.** Every key-shaped secret pattern tolerates exactly one
embedded newline inside the token body, so a key that got soft-wrapped
mid-token (`sk-ant-api03-ABCDEFGHIJ\nKLMNOPQRSTUVWX`) still matches as one
span instead of leaking the back half as an unscrubbed fragment.

**Determinism.** No randomness, no wall-clock; same input directory always
produces byte-identical output.

## Splicing (splice.py)

Each scrubbed session is one ground-truth frond (spec §4's vocabulary —
this schema keeps the field name `branch_id` for continuity rather than
chasing the rename through the output format and every fixture; see
docs/decisions.md). Sessions are cut into fixed-length segments
(`--segment-len`, default 4 exchanges, order preserved within a session)
and segments from `--k` sessions are interleaved into one stream, so a
realistic-length stream has many topic transitions instead of one.

- `hard_cut` — segments concatenated back to back, no transition marker.
- `cue_phrase` — the real first prompt of a (non-first) segment gets a cue
  phrase prefixed, e.g. `"ok, switching to <topic hint>: "` — no
  standalone synthetic turn is inserted.
- `return_at_distance` — a frond's segment reappears after exactly `d`
  intervening exchanges from other fronds.
- `combine` — one synthetic final prompt, clearly marked
  (`"[synthetic] combine what we decided about ..."`), whose ground truth
  needs two fronds at once.

**TODO (spec §13):** a `stray` variant — insert synthetic, clearly marked
off-topic single prompts (from a fixed, committed list) into streams with
truth `stray`. Not implemented yet.

Output is JSONL, one line per turn:

```json
{"stream_id": "stream-hard_cut-7", "turn_index": 4, "branch_id": "session-fake-0002",
 "action_truth": "return", "variant": "hard_cut", "turn": { "...": "an Exchange" }}
```

`combine` rows add a `combine_with: [branch_id]` field naming the second
frond the synthetic turn needs. Everything is driven off a single seeded
`random.Random` per `(variant, seed)`, so the same
`(scrubbed_dir, k, seed, segment_len)` always produces byte-identical
output.

## Known limitations

- The `.env`-style secret regex only redacts unquoted single-token values
  on one line; a quoted value containing spaces isn't matched.
- A URL's query string isn't scrubbed, so a secret passed as a query
  parameter would survive — none of our real data does this, but it's a
  gap worth knowing about.
- The AWS pattern only catches the `AKIA...` access key id, not a paired
  secret access key (plain base64, not reliably distinguishable from other
  base64 blobs without more context).
- The command-text file-path heuristic requires a recognized extension and
  no spaces; it will under-match an unusual file reference in prose.
