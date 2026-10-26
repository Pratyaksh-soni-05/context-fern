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
- `stray` — synthetic off-topic single prompts from the committed
  `bench/data/strays.txt` (60 lines — weather/food/trivia/general CS,
  nothing code-related), spliced in with `branch_id: null` and a
  `stray_from` field naming what it interrupted. Never the first or last
  row of a stream, never two in a row — guaranteed by construction, not
  checked after the fact (see `_insert_strays` in splice.py).

`--min-exchanges` (default 6) excludes short sessions from the pool
entirely (reported as `excluded_below_min_exchanges`); `--streams` (default
50) generates that many streams per variant, each a fresh seeded draw of
`--k` sessions from one **shared pool** built once per run — every variant
draws from the same pool, so results are comparable instead of each
variant happening to sample a different lucky subset.

Output is JSONL, one line per turn:

```json
{"stream_id": "stream-hard_cut-7-0", "turn_index": 4, "branch_id": "session-fake-0002",
 "action_truth": "return", "variant": "hard_cut", "turn": { "...": "an Exchange" }}
```

`combine` rows add `combine_with: [branch_id]` naming the second frond the
synthetic turn needs; `stray` rows add `stray_from` and `synthetic: true`.
Everything is driven off a single seeded `random.Random` per
`(variant, seed, stream index)`, so the same
`(scrubbed_dir, k, seed, segment_len, min_exchanges, streams)` always
produces byte-identical output — including the manifest written alongside
the streams file (`<out>.manifest.json`): seed, pool size, hashed pool
session ids, excluded-session count, the strays file's own sha256, and
per-variant stream/turn/truth-distribution counts.

## Natural labels (`bench label` / `bench label-export`)

`bench label <scrubbed_file>` is an interactive terminal labeller for real
ground truth, since every other variant above is synthetic. Shows one
exchange at a time (prompt, files touched, your position in the session)
and asks `c`=continue, `n`=new (names the topic), `r`=return (pick from
topics named so far), `s`=stray, `b`=back. Saves to
`bench/data/labels/<sha256(session_id)[:16]>.jsonl` (gitignored,
append-only — "back" just appends a correction, and the last line for a
given index wins on read), and resumes where you left off.

`bench label-export <scrubbed_file> <labels_file> <out_file>` turns a
finished labelling session into an eval stream in the same shape as
`splice.py`'s output (`variant: "natural"`), so it can be scored exactly
like a synthetic stream — see `bench eval --natural` below.

## Evaluating the router (`bench eval`)

```
uv run --project bench bench eval <streams.jsonl> [--natural <eval.jsonl>] [--config <fern.toml>]
```

Runs `fern route --replay` once per baseline — `always-continue`,
`cue-only` (cue phrases, no embedding signal at all), `embeddings-only`
(the real thresholds, cue phrases zeroed out), and `full` (everything) —
so the numbers mean something: a table with only "full" tells you nothing
about whether embeddings or cue phrases are actually doing the work. Prints
one table per splice variant, then names which signal (`cue phrases` or
`embedding similarity`) carries most of the average F1.

`combine`-truth rows are counted and reported separately, never folded into
`action_accuracy` — Stage 0 has no mechanism to predict combine in this PR
(see docs/decisions.md), so counting them would just be a permanent,
uninteresting miss baked into every other number.

If `--natural` is given (a `bench label-export` file), it's reported last
under its own "HEADLINE" banner — synthetic variants are useful proxies,
but a hand-labelled real session is the actual answer to "does this work."

## Tuning thresholds (`bench sweep`)

```
uv run --project bench bench sweep <streams.jsonl> [--manifest <manifest.json>] [--out <thresholds.toml>]
```

Splits by **session**, not stream — a session can't appear in both the
training and held-out side of a fold, but one stream can legitimately mix
sessions from both (segments from several sessions are interleaved into
every synthetic stream). With as few as 6 sessions, the split is
leave-one-session-out: each session takes a turn as the held-out test
set, grid-searched thresholds come from the other 5. The report shows the
**mean and worst** fold score as the honest generalization estimate.

The thresholds actually **written** to `bench/results/thresholds.toml`
come from one more grid search using all sessions as training data (no
held-out set) — the best estimate for an actual deployed config, reported
separately from, and not conflated with, the LOSO mean/worst. The file is
a draft artifact (see docs/decisions.md on CLAUDE.md's "maintainer decides
thresholds" rule) — it also carries a `sha256` of the manifest that
produced the data it was tuned on.

The grid search itself runs in TypeScript (`bench/ts/sweep.ts`), not
Python, and against **oracle state** (fronds built from ground truth, not
from what the router would have guessed) rather than a real replay — see
`bench/ts/sweep.ts`'s module docstring and docs/decisions.md for why real
online state can't be precomputed once per threshold candidate, and why
`decide()` itself is never ported to Python.

## Stage 2: local LLM escalation (`bench eval-stage2`)

```
uv run --project bench bench eval-stage2 <streams.jsonl> \
  [--config <fern.toml>] [--sample-size 500] [--seed 7] \
  [--models qwen3:8b] [--model <force-this-one>] \
  [--ollama-url <url>] [--max-hours 3] [--skip-full] [--skip-sample]
```

Stage 2 is local-only — `packages/daemon`'s `OllamaLlmClient` talks to a
locally running Ollama server, never a paid API (see docs/decisions.md).
It asks two narrow yes/no questions (`same_goal`, `unrelated`) rather
than picking an action directly; the action is derived in code
(`mapAdjudication` in `packages/core/src/router/stage2.ts`), since small
local models are unreliable at open-ended 5-way classification but fine
at a narrow judgment. `--models` defaults to all three candidates in
`DEFAULT_STAGE2_MODELS`, but `bench/results/day30-report.md` only ever
ran `--models qwen3:8b` — `gemma3:12b` and `qwen3.5:9b` don't fit
alongside Ollama on the 16 GB RAM machine this ran on (see
docs/decisions.md); pass `--models qwen3:8b` explicitly on similar
hardware.

**Sampling is a probe, not a simulation, and never feeds back into
state.** A flat random sample of turns would barely include any
`new`/`return`/`stray` truths (they're a small fraction of real turns),
so the sample is stratified by `(variant, action_truth)`. The sample
stage (`bench/ts/stage2-sample.ts`) replays each stream's turns with
**Stage 0 only** — cheap, and free via an on-disk embedding cache
(`bench/ts/embedding-cache.ts`, keyed by prompt hash) — to build correct
router state, and calls the LLM only on the pre-selected sample ids
within that stream, strictly as a side-channel measurement: the next
turn's state always advances from Stage 0's own decision, never from
the LLM's answer, so Stage 2 never escalates a turn that wasn't
selected and never changes what later turns see. (An earlier version of
this forced escalation on *every* turn up to each sampled row — a real
bug, fixed; see docs/decisions.md.) Every sampled row still carries
Stage 0's own pre-escalation action/confidence
(`stage0_predicted_action`, `stage0_confidence`), so one sample run
doubles as the data needed to *simulate* any other escalation band
(slice by whether `stage0_confidence` falls in that band) without
spending another LLM call.

The sample stage checkpoints per row (`bench/results/stage2-sample-<model>.jsonl`,
gitignored) and skips ids already done on restart; it logs progress
every 10 rows with latency and ETA, and aborts early if 5 consecutive
calls fail (so a down Ollama server can't silently produce a file full
of fallback rows that look like real judgments).

For each candidate model, the sample run reports F1 new/return/stray,
escalation rate, and real measured p50/p95 latency for Stage 0 and
Stage 2 separately. No dollar cost anywhere — Ollama is local and free,
so the report is time/tokens, not money.

**The full-dataset gated run is not run by default, and wasn't run for
qwen3:8b.** `--skip-sample` (requires `--model`) goes straight to it when
sample results already exist, but the 2026-10-26 decision was to stop at
the sample: qwen3:8b's best simulated band (F1(new) 0.643) missed the
gate by enough margin that a many-hour full run wouldn't change the
conclusion — see `bench/results/day30-report.md` and docs/decisions.md.
When it is run, it's a **resumable** job: the dataset is split one file
per stream under `bench/results/stage2-full-split/`, each stream's
output written to its own file as soon as it's done, and interrupting
(Ctrl-C, crash, reboot) then re-running the exact same command skips
streams whose output file already exists.

Both the sample and full-run subprocesses stream their output line by
line and print periodic progress, instead of blocking silently until the
whole pass exits — a multi-minute-to-multi-hour local Stage 2 run is
otherwise indistinguishable from a hang.

`bench/results/day30-report.md` is the actual, final read against the
gate: on spliced data the bar is "within 0.05 F1 of the measured
ceiling" (a 120-row sample Claude judged blind), not spec §16's literal
natural-data numbers — see docs/decisions.md, 2026-10-26. The result was
a miss, and the project's default behaviour changed in response (spec
§5/§6/§16, v0.3).

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
