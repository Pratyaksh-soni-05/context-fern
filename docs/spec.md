# Context Fern spec v0.3

Status: design locked 2026-10-23; routing default revised 2026-10-26 (manual-first — see §5, §6, §16 and `bench/results/day30-report.md`). Working CLI name `fern` (held in `packages/core/src/brand.ts`; may change before launch). Everything here is in scope for the launch build unless listed under Out of scope.

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
| Brief | markdown at `.fern/fronds/<name>.md` with Goal, Decided, Open, Files, Notes, Recent. Goal/Decided/Open/Files/Notes are user-editable; Recent (last 5 prompts, newest first) is machine-maintained — rewritten on every update, never merged with user edits | `Brief` |
| Decision | one routing action recorded in the journal with its inverse | `Decision` |

## 5. Router
Manual-first: the user's own commands (`/fern new`, `/fern switch`, `/fern stray`, the `?` prefix — §7) are the primary way turns get routed. The router's job is cue and suggestion, not silent auto-routing — ReplayBench found that free, local Stage 0+2 does not reach a trustworthy auto-routing accuracy (`bench/results/day30-report.md`, `docs/decisions.md` 2026-10-26), so nothing routes a turn the user didn't ask to route unless the router has measured, high-precision confidence that it's right.

Input: the new human prompt, recent tool calls (files touched), the fern.
Output: `{ action: continue | new | return | combine | stray, target?, with?, confidence: 0..1, signals: string[], stage: 0 | 2 }`.

Stage 0 (local, always on):
- explicit cue phrases (configurable list), e.g. "switching to", "back to", "side question", "unrelated, but"
- Jaccard overlap between files in this exchange and each frond's file set
- cosine similarity of the prompt embedding to each frond centroid and to the stem
- stray signals: low similarity to the stem and every frond, no file context, short question form

Cue phrases and raw Stage 0 signals are always computed and shown in `fern status`/the journal/UI, but on their own they are not a detector: cue phrases alone measured 0.05 recall for `new` and 0.00 for `stray` on ReplayBench's spliced data. They are a hint to the user, not a routing signal by themselves.

Suggestions: for `new` and `stray` — the two actions ReplayBench has a measured precision/recall curve for — Stage 0's decision is meant to be surfaced to the user as a suggestion only when its confidence clears `config.suggestionPrecision` for that action; the real gate is ≥ 0.85 precision on natural (real, hand-labelled) data (§16). `suggestionPrecision` ships with real, non-placeholder defaults, `{ new: 0.88, stray: 0.603 }` (precision 0.87/recall 0.41 for `new`, precision 0.88/recall 0.50 for `stray` — `bench/results/day30-report.md`), marked **interim**: measured on spliced/synthetic data only, not natural labels, and must be re-validated once natural data exists (`docs/decisions.md`, 2026-10-26). Below threshold, Stage 0 makes no suggestion for that action and the turn stays on the active frond (`continue`) until the user routes it manually. `return` and `combine` have no measured precision curve yet, so they keep the old rule below (always a proposal, never shown-or-hidden by a confidence bar) rather than a bar nobody has measured. (As of this spec revision, the config and its defaults exist; wiring this gate into a suggest-mode consumer is follow-up work — see `docs/decisions.md`, 2026-10-26.)

Stage 2 (optional, off by default, uncertain turns only): when enabled and Stage 0 confidence is between `low` and `high`, ask an LLM (user's key or Ollama) to choose the action, itself held to the same suggestion-precision bar as Stage 0 for `new`/`stray`, not a separate auto-routing target. Disabled unless the user configures a model. A free local 8B model (qwen3:8b via Ollama) was measured and did not clear the day-30 gate, and did not beat a precision-thresholded Stage 0 alone (`bench/results/day30-report.md`) — Stage 2 remains available for users who point it at a stronger model, but ships off by default. Every call is journaled with model and tokens.

Rules:
- Thresholds live in `.fern/config.toml`; defaults are set by the maintainer from ReplayBench, never hand-tuned in code.
- Bias toward `continue`: `new` and `stray` require higher confidence than `continue`.
- `continue` is the only action ever applied without the user asking for it. For `new` and `stray`, the precision bar above decides whether the decision is even shown as a suggestion; `return` and `combine` are always shown as a proposal, applied only after `/fern switch`/`[y]` as before. None of the five is auto-applied purely because the action is cheap to undo — low-precision `stray` suggestions were exactly what this rule was added to stop (`docs/decisions.md` 2026-10-26).
- A stray — whether suggested-and-accepted or set with `/fern stray`/the `?` prefix (§7) — is answered normally by the agent. It is excluded from every frond and, in isolate mode, from future payloads.

## 6. Modes
| Mode | Changes model input? | Behaviour |
| --- | --- | --- |
| observe | no | grow the fern and briefs, show UI |
| suggest | no (adds focus notes only) | `new`/`stray` are shown only once they clear the precision bar in §5; below it, the turn stays on the active frond until the user routes it manually. `return`/`combine` are always shown as a proposal (§5's older rule — no measured precision bar for them yet). Nothing is applied without `/fern new`, `/fern switch` or a `[y]` reply; restores briefs after compaction |
| isolate | yes | proxy assembles stem + active frond + tail; strays and resting fronds left out |

## 7. Hooks and commands (Claude Code plugin)
- `UserPromptSubmit`: if the prompt starts with `/fern`, dispatch it against the daemon directly (or run `fern init` locally) and return `decision: "block"` with the receipt as `reason` — zero model turns, the one exception to "never block" below (it's a command, not a routing decision on a real prompt; see `docs/decisions.md`). Otherwise, POST to daemon `/prompt` and return the receipt as the top-level `systemMessage` (user-visible, omitted entirely when there's nothing to show — quiet by default) and, outside observe mode, a minimal focus note as `hookSpecificOutput.additionalContext` (model-only). Never block a real prompt. 300 ms internal timeout on this passive path; on timeout or a down daemon, pass through silently.
- `SessionStart`: starts the daemon if it isn't already running (fire-and-forget, never waits for it); after `/clear`, compaction, resume, or fork — not a fresh `startup`, which has nothing to restore yet — injects the active frond's brief as `additionalContext`, capped ~8KB with `Notes` truncated first, omitted in observe mode.
- `PreCompact`: in isolate mode, block client compaction when the upstream payload is within budget; otherwise allow and snapshot the brief first.
- `PostToolUse`: report files touched (paths only, relativized to the project root) via `/tools`. Never tool output or file contents.

Slash commands: `/fern status`, `/fern new <name>`, `/fern switch <name>`, `/fern stray`, `/fern undo`, `/fern merge <name>`, `/fern mode <mode>`, `/fern ui`.
`/fern stray` marks the current prompt a stray by hand (same effect as accepting a stray suggestion, §5): answered normally, kept off every frond, undoable with `/fern undo`.

`?` prefix: a message typed as `? <prompt>` is equivalent to `/fern stray` followed by that prompt, in one round trip. The match is narrow on purpose — only a literal `"? "` (question mark, then a space) at the very start of the raw prompt triggers it (`parseStrayPrefix`, `packages/core/src/router/math.ts`); a bare `?`, a prompt that merely starts with `?` and no following space (e.g. `"?.."`), or leading whitespace before the `?` are left as ordinary prompts, since those are real questions, not the stray shortcut. Cheap to support — `UserPromptSubmit` strips the matched prefix (plus any further leading whitespace) before routing and before the prompt reaches the agent, and records the decision exactly as a manual `/fern stray` would.

MCP tools (max three): `frond_list`, `frond_search`, `frond_recall`.
Receipts (exact formats, see DESIGN.md §Voice):
- `fern ▸ new frond? docker-build · 0.86 · cue phrase, no file overlap · /fern new`
- `fern ▸ on docker-build · auth-refactor rests with its brief`
- `fern ▸ stray · answered, kept off every frond`
- `fern ▸ stray (marked) · answered, kept off every frond · /fern undo`
- `fern ▸ returned to auth-refactor · 0.88 · /fern undo`
Statusline: `fern ▸ <frond> · <n> fronds · <s> strays · <sent>/<full> ctx` (the `.../... ctx` clause is omitted until isolate-mode token accounting is real — never a fabricated `0/0`). Claude Code plugins can't register a statusline directly (confirmed against the docs); `fern statusline --install` writes the equivalent command into the user's own Claude Code settings instead, never overwriting an existing one.

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
`.fern/fern.db` (SQLite, WAL). Tables: `sessions`, `fronds`, `leaflets` (hashes and counts, no content), `decisions`, `roots`, `migrations` (versioned; opening a DB with a newer schema version than the running code knows about refuses outright). `embeddings` (sqlite-vec) is deferred — not built yet; frond centroids live as a JSON array directly on `fronds.centroid` in the meantime (see docs/decisions.md). Briefs in `.fern/fronds/*.md`. Journal mirrored to `.fern/journal.jsonl`. Config in `.fern/config.toml`.

## 13. ReplayBench
- `bench/scrub.py`, `bench/transcript.py`, `bench/splice.py` as built in Phase 1.
- Add a `stray` variant: insert synthetic, clearly marked off-topic single prompts (from a fixed, committed list) into streams with truth `stray`.
- `bench/run.py`: router metrics (action accuracy, F1 for new, return and stray, over-carry, escalation rate, latency p50/p95) and end-to-end conditions (linear, observation masking, Context Fern, oracle).
- Results as JSON + a markdown table; CI runs a 20-stream smoke set.

## 14. Distribution
Signed binaries for macOS, Linux and Windows on x64 and arm64, plus checksums. Install paths: `install.sh`, `install.ps1`, npm package `context-fern` (shim), PyPI package `context-fern` (platform wheels carrying the binary, same approach as ruff/uv), Homebrew tap, Claude Code plugin marketplace manifest.

Two binary names ship from the one executable: `fern` for interactive use (matches `CLI_NAME` throughout this spec and §7/§10's commands) and `context-fern` (`CLI_BINARY_NAME`, `packages/core/src/brand.ts`) for every machine-invoked entry point the Claude Code plugin owns — `hooks.json`'s four hook commands, `.claude-plugin/plugin.json`'s MCP server entry, and `commands/fern.md`'s fallback. `fern` collides with the real, already-published Fern API docs CLI; a plugin-registered hook or MCP server that silently resolved to the wrong `fern` on a user's `PATH` would fail invisibly, so those entries need the unambiguous name even though every human-typed command and receipt stays `fern`. Both names are installed together by every install path in this section — never one without the other.

## 15. Out of scope for launch
Desktop app, hosted service, accounts, cross-user memory, writing to roots, automatic merge, Codex/OpenCode proxy, Cursor transparent routing, fine-tuned Stage 1 classifier, git worktree management, dark theme for the UI (tokens allow it later).

## 16. Gates
- Launch: install-to-first-frond (one install command to a working routed session with its first frond, whether created manually or by a suggestion the user accepted) under 2 minutes on a clean macOS, Ubuntu and Windows machine (restates §3's acceptance item 1 as a hard gate, not just a one-time acceptance check).
- Day 30: suggestion precision ≥ 0.85 on natural (real, hand-labelled) data for both `new` and `stray`, at whatever recall the threshold yields — the manual-first default succeeds on trustworthy suggestions, not on auto-routing every turn. Until natural labels exist, the interim bar on spliced/synthetic data is "within 0.05 F1 of the measured ceiling" (`docs/decisions.md`, 2026-10-26); the 2026-10-26 measurement on spliced data missed even that interim bar for Stage-2-assisted auto-routing (best F1(new) 0.643 vs a 0.782 bar — `bench/results/day30-report.md`). Stage 2, when a user enables it with their own model, is held to this same suggestion-precision bar, not a separate F1 target.
- Day 30: D30 retention of active installers ≥ 20% (draft; moved up from the previous draft's Day 90 slot — a D30 figure is itself a day-30 measurement).
- Day 60: isolate mode task success ≥ linear and ≥ 25% fewer input tokens at neutral or better cost on long or distant-tangent sessions (draft).
- Day 90: < 30% of decisions undone (draft).
