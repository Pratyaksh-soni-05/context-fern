# Context Fern spec v0.2

Status: design locked 2026-10-23. Working CLI name `fern` (held in `packages/core/src/brand.ts`; may change before launch). Everything here is in scope for the launch build unless listed under Out of scope.

Design source of truth: `docs/design/DESIGN.md`, `docs/design/tokens.css`, and the reference boards in `docs/design/blueprint/`.

## 1. Problem
Long coding-agent sessions mix topics. Side questions pollute the main task, off-topic questions linger in context, and compaction drops working state mid-task. Vendors ship manual branch, fork and side-question commands, and token-triggered compaction, but nothing routes turns by topic automatically, keeps per-topic context through compaction, or shows the user why the model saw what it saw.

## 2. Users
Primary: Claude Code power users on macOS, Linux and Windows.
Later: Codex and OpenCode users; agent builders using SDK middleware.

## 3. Acceptance for the launch build
1. A new user installs with one command and has a routed session in under 2 minutes on a clean machine (macOS, Ubuntu, Windows 11).
2. `observe` and `suggest` modes work fully offline (no API calls) with the bundled embedding model.
3. Every routing decision appears in the journal with action, signals and confidence, and `fern undo` reverses the last decision.
4. After `/clear` or compaction, the active frond's brief is restored into the next turn.
5. `fern ui` shows the Fern, List and Categories views, the inspector and the stats row, matching `docs/design/`; meets WCAG 2.2 AA.
6. Isolate mode (opt-in) passes the cache property tests and forwards streaming responses without changing content.
7. `fern uninstall` removes the binary, plugin, hooks and config, and leaves project `.fern/` folders only if the user chooses.
8. ReplayBench harness, scrubbed traces and results are published with the release.
9. All six install paths work: curl, PowerShell, npx, pip/uvx, Homebrew, Claude Code plugin marketplace.

## 4. Concepts (vocabulary used everywhere: code, UI, docs)
| Term | Meaning | Code name |
| --- | --- | --- |
| Session | one agent conversation in one project directory | `Session` |
| Stem | shared context every frond needs: task goal, project facts, decisions merged back | `Stem` (was "trunk") |
| Frond | a topic thread: name, colour index, status (`active`, `resting`, `merged`), centroid vector, brief | `Frond` (was "branch") |
| Leaflet | one exchange (human prompt + everything until the next prompt) placed on a frond | `Leaflet` / `Exchange` |
| Stray | an off-topic exchange: answered, then kept off every frond and out of future context | `Stray` |
| Root | a memory from an earlier session that feeds a frond (read-only in v1; imported from CLAUDE.md, MEMORY.md or memory tools) | `Root` |
| Graft | a merge back to the stem, or a combined turn that used two fronds | `Graft` |
| Brief | markdown at `.fern/fronds/<name>.md` with Goal, Decided, Open, Files, Notes. User-editable | `Brief` |
| Decision | one routing action recorded in the journal with its inverse | `Decision` |

## 5. Router
Input: the new human prompt, recent tool calls (files touched), the fern.
Output: `{ action: continue | new | return | combine | stray, target?, with?, confidence: 0..1, signals: string[], stage: 0 | 2 }`.

Stage 0 (local, always on):
- explicit cue phrases (configurable list), e.g. "switching to", "back to", "side question", "unrelated, but"
- Jaccard overlap between files in this exchange and each frond's file set
- cosine similarity of the prompt embedding to each frond centroid and to the stem
- stray signals: low similarity to the stem and every frond, no file context, short question form

Stage 2 (optional, uncertain turns only): when Stage 0 confidence is between `low` and `high`, ask a small LLM (user's key or Ollama) to choose the action. Disabled when nothing is configured. Every call is journaled with model and tokens.

Rules:
- Thresholds live in `.fern/config.toml`; defaults are set by the maintainer from ReplayBench, never hand-tuned in code.
- Bias toward `continue`: `new` and `stray` require higher confidence than `continue`.
- In `suggest` mode, `new`, `return` and `combine` are proposed and applied only after `/fern new`, `/fern switch` or a `[y]` reply. `stray` is applied automatically in suggest mode because it removes nothing the task needs; it can be undone.
- A stray is answered normally by the agent. It is excluded from every frond and, in isolate mode, from future payloads.

## 6. Modes
| Mode | Changes model input? | Behaviour |
| --- | --- | --- |
| observe | no | grow the fern and briefs, show UI |
| suggest | no (adds focus notes only) | propose routing, restore briefs after compaction, mark strays |
| isolate | yes | proxy assembles stem + active frond + tail; strays and resting fronds left out |

## 7. Hooks and commands (Claude Code plugin)
- `UserPromptSubmit`: POST to daemon `/route`; return `additionalContext` with a one-line receipt and, in suggest mode, the focus note. Never block. 300 ms timeout; on timeout pass through and log.
- `SessionStart`: after `/clear` or compaction, inject the active frond's brief.
- `PreCompact`: in isolate mode, block client compaction when the upstream payload is within budget; otherwise allow and snapshot the brief first.
- `PostToolUse`: report files touched (paths only).

Slash commands: `/fern status`, `/fern new <name>`, `/fern switch <name>`, `/fern undo`, `/fern merge <name>`, `/fern mode <mode>`, `/fern ui`.
MCP tools (max three): `frond_list`, `frond_search`, `frond_recall`.
Receipts (exact formats, see DESIGN.md §Voice):
- `fern ▸ new frond? docker-build · 0.86 · cue phrase, no file overlap · /fern new`
- `fern ▸ on docker-build · auth-refactor rests with its brief`
- `fern ▸ stray · answered, kept off every frond`
- `fern ▸ returned to auth-refactor · 0.88 · /fern undo`
Statusline: `fern ▸ <frond> · <n> fronds · <s> strays · <sent>/<full> ctx`.

## 8. Assembly (isolate mode)
Order: tools → system → stem messages → active frond messages → tail (brief, recalled snippets, router note in the latest user turn).
Cache breakpoints: after system, after stem, after frond.
Property tests:
- Consecutive turns on the same frond produce a byte-identical prefix up to the last breakpoint.
- Nothing frond-specific appears in `system`.
- Stray exchanges never appear in any assembled payload after the turn they were answered in.
- Isolation is skipped when frond prefix tokens > 0.7 × full history tokens (configurable).

## 9. Merge (graft)
`fern merge <frond> --summary` appends the frond brief's Decided section to the stem as a tail summary. Never rewrites earlier messages. Journaled with an inverse.

## 10. CLI
`fern status [--json]`, `fern tree`, `fern ui`, `fern mode <m>`, `fern undo`, `fern merge <f> --summary`, `fern export --md|--png`, `fern bench`, `fern doctor`, `fern init`, `fern uninstall`, `fern route --replay <file>` (dev).
`fern tree` output format is shown on the First run board in `docs/design/blueprint/Install.dc.html`.

## 11. Local UI (`fern ui`)
Served by the daemon on localhost (default port 7420). No account, no login. Screens, matching `docs/design/blueprint/`:
1. **Start**: pick a project (recent list + folder input). `Start.dc.html`.
2. **App**: left icon rail; header with view switch (Fern / List / Categories) and mode pill; main panel; inspector; four stat tiles. `Prototype.dc.html` is the behavioural reference, including replay, the growth slider, strays/roots toggles, selection and dimming.
   - Fern view: stem, coloured fronds with stippled leaflets, leaflet nodes, dashed orange strays, dashed root lines and nodes, dotted graft links.
   - List view: one row per exchange: turn, frond, kind, prompt, context cells, confidence.
   - Categories view: one card per frond, a strays card, a roots card, and the topic-switching heat map.
3. `fern export --png`: the 1200×630 session card, `SessionCard.dc.html`.
Frond colours are assigned in order from the palette in `tokens.css` (moss, lake, iris, ochre, rose, then repeat with a pattern); stray is always ember, roots always ash.

## 12. Storage
`.fern/fern.db` (SQLite, WAL). Tables: `sessions`, `fronds`, `exchanges` (hashes and counts, no content), `decisions`, `roots`, `embeddings` (sqlite-vec). Briefs in `.fern/fronds/*.md`. Journal mirrored to `.fern/journal.jsonl`. Config in `.fern/config.toml`.

## 13. ReplayBench
- `bench/scrub.py`, `bench/transcript.py`, `bench/splice.py` as built in Phase 1.
- Add a `stray` variant: insert synthetic, clearly marked off-topic single prompts (from a fixed, committed list) into streams with truth `stray`.
- `bench/run.py`: router metrics (action accuracy, F1 for new, return and stray, over-carry, escalation rate, latency p50/p95) and end-to-end conditions (linear, observation masking, Context Fern, oracle).
- Results as JSON + a markdown table; CI runs a 20-stream smoke set.

## 14. Distribution
Signed binaries for macOS, Linux and Windows on x64 and arm64, plus checksums. Install paths: `install.sh`, `install.ps1`, npm package `context-fern` (shim), PyPI package `context-fern` (platform wheels carrying the binary, same approach as ruff/uv), Homebrew tap, Claude Code plugin marketplace manifest.

## 15. Out of scope for launch
Desktop app, hosted service, accounts, cross-user memory, writing to roots, automatic merge, Codex/OpenCode proxy, Cursor transparent routing, fine-tuned Stage 1 classifier, git worktree management, dark theme for the UI (tokens allow it later).

## 16. Gates
- Day 30: Stage 0 + 2 F1 on `new` ≥ 0.85 and on `stray` ≥ 0.8, with ≤ 10% escalation (draft).
- Day 60: isolate mode task success ≥ linear and ≥ 25% fewer input tokens at neutral or better cost on long or distant-tangent sessions (draft).
- Day 90: < 30% of decisions undone; D30 retention of active installers ≥ 20% (draft).
