# ContextTree spec v0.1

Status: draft for the maintainer to edit before week 1. Everything here is in scope for the launch build unless listed under Out of scope.

## 1. Problem
Long coding-agent sessions mix topics. Side questions pollute the main task, and compaction drops working state mid-task. Vendors ship manual branch, fork and side-question commands, and token-triggered compaction, but nothing routes turns by topic automatically, keeps per-branch context through compaction, or shows the user why the model saw what it saw.

## 2. Users
Primary: Claude Code power users on macOS, Linux and Windows.
Later: Codex and OpenCode users; agent builders using the SDK middleware.

## 3. Acceptance for the launch build
1. A new user installs with one command and has a routed session in under 2 minutes on a clean machine (macOS, Ubuntu, Windows 11).
2. `observe` and `suggest` modes work fully offline (no API calls) with the bundled embedding model.
3. Every routing decision appears in the journal with action, signals and confidence, and `ctree undo` reverses the last decision.
4. After `/clear` or compaction, the active branch brief is restored into the next turn.
5. `ctree ui` shows the tree, the editable brief, the context lens and the journal; meets WCAG 2.2 AA in light and dark themes.
6. Isolate mode (opt-in) passes the cache property tests and forwards streaming responses without changing content.
7. `ctree uninstall` removes the binary, plugin, hooks and config, and leaves project `.contexttree/` folders only if the user chooses.
8. ReplayBench harness, scrubbed traces and results are published with the release.

## 4. Concepts
- **Session**: one agent conversation in one project directory.
- **Trunk**: shared context every branch needs (task goal, project facts, decisions made on the trunk).
- **Branch**: a topic thread with a name, parent, status (`active`, `parked`, `merged`), centroid vector and brief.
- **Brief**: markdown file at `.contexttree/branches/<name>.md` with Goal, Decided, Open, Files, Notes. User-editable.
- **Decision**: one routing action recorded in the journal.

## 5. Router
Input: the new user turn, recent tool calls (files touched), the tree.
Output: `{ action: continue | new | return | combine, target?, confidence: 0..1, signals: string[] }`.

Stage 0 (local, always on):
- explicit cue phrases (configurable list), e.g. "switching to", "back to", "side question"
- Jaccard overlap between files touched in this turn's context and each branch's file set
- cosine similarity of the turn embedding to each branch centroid

Stage 2 (optional, uncertain turns only): when Stage 0 confidence is between `low` and `high` thresholds, ask a small LLM (user's key or Ollama) to choose the action. Disabled when no key or local model is configured.

Rules:
- Thresholds live in `config.toml`; defaults are set by the maintainer from ReplayBench, not by code.
- Bias toward `continue`: `new` requires higher confidence than `continue`.
- In `suggest` mode, `new` and `return` are proposed, not applied, unless the user confirms with `/ct new` or `/ct switch`.

## 6. Modes
| Mode | Changes model input? | Behaviour |
| --- | --- | --- |
| observe | no | build tree and briefs, show UI |
| suggest | no (adds focus notes only) | propose routing, restore briefs after compaction |
| isolate | yes | proxy assembles trunk + active branch + tail |

## 7. Hooks (Claude Code plugin)
- `UserPromptSubmit`: POST turn to daemon `/route`; return `additionalContext` containing a one-line routing receipt and, in suggest mode, the active branch focus note. Never block the prompt. Timeout 300 ms; on timeout, pass through and log.
- `SessionStart`: if the session resumed after `/clear` or compaction, inject the active branch brief.
- `PreCompact`: in isolate mode, block client compaction when the upstream payload is already within budget; otherwise allow and snapshot the brief first.
- `PostToolUse`: report files touched to the daemon (paths only).

Slash commands: `/ct status`, `/ct new <name>`, `/ct switch <name>`, `/ct undo`, `/ct merge <name>`, `/ct mode <mode>`.
MCP tools (max three): `branch_list`, `branch_search`, `branch_recall`.
Statusline: `ct ▸ <branch> · <n> branches · <sent>/<full> ctx · undo`.

## 8. Assembly (isolate mode)
Order: tools → system → trunk messages → active branch messages → tail (brief, recalled snippets, router note in the latest user turn).
Cache breakpoints: after system, after trunk, after branch.
Property tests:
- For consecutive turns on the same branch, the assembled prefix up to the last breakpoint is byte-identical.
- Nothing branch-specific appears in `system`.
- Isolation is skipped when branch prefix tokens > 0.7 × full history tokens (threshold configurable).

## 9. Merge
`ctree merge <branch> --summary` appends the branch brief's Decided section to the trunk as a tail summary. It never rewrites earlier messages. Recorded in the journal with an inverse.

## 10. CLI
`ctree status [--json]`, `ctree tree`, `ctree ui`, `ctree mode <m>`, `ctree undo`, `ctree merge <b> --summary`, `ctree export --md|--png`, `ctree bench`, `ctree doctor`, `ctree uninstall`, `ctree route --replay <file>` (dev).

## 11. Storage
SQLite file at `.contexttree/ct.db` (WAL). Tables: `sessions`, `branches`, `turns` (hashes and counts, no content), `decisions`, `embeddings` (sqlite-vec). Journal mirrored to `.contexttree/journal.jsonl`.

## 12. ReplayBench
- `bench/scrub.py`: remove secrets, keys, emails, absolute paths, hostnames.
- `bench/splice.py`: interleave K sessions into streams with ground-truth branch IDs; variants: hard cut, cue phrase, return at distance d, combine.
- `bench/run.py`: router metrics (action accuracy, F1 new, F1 return, over-carry, escalation rate, latency p50/p95) and end-to-end conditions (linear, observation masking, ContextTree, oracle).
- Results written as JSON + a markdown table; CI runs a 20-stream smoke set.

## 13. Out of scope for launch
Desktop app, hosted service, accounts, cross-user memory, typed graph edges, automatic merge, Codex/OpenCode proxy, Cursor transparent routing, fine-tuned Stage 1 classifier, git worktree management.

## 14. Gates
- Day 30: Stage 0 + 2 F1 on `new` ≥ 0.85 with ≤ 10% escalation (draft).
- Day 60: isolate mode task success ≥ linear and ≥ 25% fewer input tokens at neutral or better cost on long or distant-tangent sessions (draft).
- Day 90: < 30% of decisions undone; D30 retention of active installers ≥ 20% (draft).
