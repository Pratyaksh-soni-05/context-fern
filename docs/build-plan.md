# ContextTree build plan

Oct 23, 2026 · @maintainer

## What we are building

ContextTree is a free, local, open-source context router for coding agents. It splits a session into a topic tree as you work, sends the model only the trunk plus the active branch, keeps each branch as a markdown brief that survives compaction, and logs every routing decision so you can see it, undo it or merge it.

Pratyaksh builds it solo with Claude Code over 13 weeks, alongside the maintainer's other commitments. ContextTree and `ctree` are working names; the final name is decided later and the code keeps it in one constant. Week 3 and week 10 are hard gates: if the benchmark says routing does not help, we ship the smaller manual tool and publish the result.

**The twist is accountable context.** Memory vendors hide what the model sees. ContextTree shows it.

- **Inspectable:** every branch is a readable, editable markdown file on disk.
- **Reversible:** every automatic move can be undone with one command.
- **Auditable:** an append-only journal records why each decision was made, its confidence, and the tokens and cache cost it changed.

**Positioning line:** claude-mem remembers across sessions. ContextTree keeps this session clean.

**Non-negotiable principles**

1. Free forever. Apache-2.0, no account, no hosted service required, no paid tier in the core.
2. Local-first. Everything runs on the developer's machine; the only network calls are the ones they already make to their model provider, plus optional router calls on their own key.
3. Suggest before act. The default never removes context without the user seeing it; `isolate` is opt-in.
4. Nothing hidden. Every LLM call the router makes is disclosed in the journal. No content telemetry, ever.
5. One command to install, one command to uninstall, and nothing left behind.

## Architecture

One local binary runs a small daemon. The agent's hooks call it on every prompt; it routes the turn, records the decision, and in isolate mode assembles a smaller, cache-safe payload before forwarding to the model provider.

&#91;embedded content: ContextTree components · clients, daemon, store and UI\]

The router is the accented box because it is the hardest part and the one the day-30 gate measures; everything around it exists so its mistakes are visible and cheap to undo.

**Three trust modes, one binary**

| Mode | What it does | Removes tokens? | Default |
| --- | --- | --- | --- |
| `observe` | Builds the tree and briefs from transcripts; changes nothing the model sees | No | First session after install |
| `suggest` | Routes every prompt; offers "new branch?" on a confident pivot; restores the active brief after compaction or `/clear` | No | From the second session |
| `isolate` | Local proxy sends only tools, system, trunk, active branch and a short tail | Yes | Opt-in: `ctree mode isolate` |

**Router cascade**

1. **Stage 0, local and free:** explicit cues ("back to the auth bug"), overlap in files touched by tool calls, cosine similarity to each branch's centroid using the bundled embedding model.
2. **Stage 2, only for uncertain turns:** a small LLM on the user's key decides continue, new, return or combine.
3. **Stage 1, later (Phase 3+):** a small fine-tuned classifier trained on opt-in journal and ReplayBench data replaces most Stage 2 calls.

Thresholds are asymmetric: a wrong "continue" adds a little noise, a wrong "new branch" removes context the model needed, so the router leans toward continue and every split is undoable.

**Cache-safe context assembly (isolate mode)**

- Order is fixed: tools, system, trunk, active branch, then a volatile tail (brief, recalled snippets, router note).
- Per-branch content never goes in the system prompt; a branch's message list is append-only.
- Isolation engages only when the branch prefix is well below the full history; branching pays back from about the second turn on a branch, using Anthropic's 1.25× cache write and 0.1× read.
- Branches users keep returning to get the one-hour cache TTL.

**Data model (SQLite, one file per project)**

| Table | Holds |
| --- | --- |
| `sessions` | agent, project path, started, mode |
| `branches` | id, parent, name, status (active, parked, merged), centroid vector, brief path |
| `turns` | session, branch, role, token counts, files touched, hash of content (not content) |
| `decisions` | turn, action, signals, confidence, tokens before and after, cache read and write, undone flag |

Briefs live as markdown in `.contexttree/branches/`, so users can read, edit and commit them; the database indexes them.

## Visual design and context representation

The visual product is a local web UI (`ctree ui`) that answers one question at a glance: what did the model see on this turn, and why. Four surfaces carry the experience, from quietest to richest.

| Surface | Where | What it shows | Design rule |
| --- | --- | --- | --- |
| Statusline | Claude Code status bar | `ct ▸ auth-refactor · 3 branches · 18k/96k ctx · undo` | One line, no colour except the active branch name |
| Routing receipt | Inline in the agent transcript | `moved to new branch docker-build (0.86: cue, no file overlap) · /ct undo` | Always carries the reason, the confidence and the undo command |
| Terminal tree | `ctree tree` | Git-log-style tree of trunk and branches, turn counts, active marker | Box-drawing characters, works in any terminal, no TUI framework required |
| Web UI | `ctree ui` at localhost | Tree, brief, context lens, journal (layout below) | Keyboard-first, readable at 1280 px and on a laptop, light and dark |

**Web UI layout: three panes and a timeline**

1. **Tree pane (left).** Trunk as a vertical spine; branches fork right like a git graph. Each node shows name, turn count and last activity. Active branch is the only filled node. Merged branches turn hollow with a merge mark. Click to focus; `j/k` to move, `enter` to open.
2. **Brief pane (centre).** The branch's markdown brief, editable in place, saved straight to `.contexttree/branches/<name>.md`. Above it: goal, open questions, decisions, files touched. This is the "see and edit what's in context" answer.
3. **Context lens (right).** A single stacked bar for the selected turn: tools, system, trunk, branch, tail, each segment labelled with tokens and marked cached or written. Below it, a toggle to show the exact payload the model received. This is the panel people will screenshot.
4. **Journal timeline (bottom).** One row per routing decision: turn, action (continue, new, return, merge, undo), signal, confidence, tokens saved, cache impact. Every row has an undo button and a link to the turn.

**Session card.** `ctree export --png` renders a 1200×630 card: the tree shape, and four numbers such as branches, input tokens saved, compaction losses avoided and undos. This is the shareable artefact, the way ccusage spread through usage screenshots.

**Design language**

- Monochrome base, one accent colour for the active branch, one status colour each for saved, cost and warning. Colour never carries meaning alone; every state also has a shape or a word.
- Two typefaces: a clean sans for UI text, a monospace for branch names, IDs, token counts and payloads.
- Flat surfaces, 8 px radius, 1 px rules, generous whitespace; no gradients or shadows.
- Motion only for state changes (a branch forking, a merge), under 200 ms, and off when the OS asks for reduced motion.
- Accessibility: WCAG 2.2 AA contrast in both themes, full keyboard navigation, the tree exposed as an ARIA tree, every chart backed by a text table.

&#91;embedded content: ctree ui mock-up · tree, brief, context lens, journal\]

The mock-up is the starting point for design week (week 5); it gets refined as static screens before any UI code is written.

## Repo and stack

One public monorepo, TypeScript on Bun for everything that ships, Python only for the benchmark. Bun compiles to a single binary per OS with SQLite built in, which is what makes a one-command install and a tiny footprint possible.

```
contexttree/
├── CLAUDE.md                 rules Claude Code follows in this repo
├── docs/
│   ├── spec.md               the source of truth for scope and acceptance
│   ├── architecture.md       module boundaries, data model, one diagram
│   ├── decisions.md          one dated line per non-obvious choice
│   └── design/               UI tokens, mock-ups, the session card template
├── packages/
│   ├── core/                 router cascade, context assembler, branch model (pure, no I/O)
│   ├── store/                SQLite + sqlite-vec + FTS5, markdown mirror, journal
│   ├── embed/                bundled ONNX model, Ollama and provider fallbacks
│   ├── daemon/               localhost service: hook endpoints, proxy (isolate mode), UI server
│   ├── cli/                  `ctree` commands, terminal tree renderer
│   ├── plugin-claude-code/   hooks, /ct commands, statusline, 3 MCP tools, marketplace manifest
│   └── ui/                   web UI (React + Vite), built into the binary as static assets
├── bench/                    ReplayBench: scrubber, splicer, runner, metrics (Python, uv)
├── install/                  install.sh, install.ps1, Homebrew formula, npm shim
├── site/                     contexttree website (static, deploys from main)
└── .github/workflows/        test, bench smoke run, VHS demo regeneration, signed releases
```

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime and binary | Bun, `bun build --compile` | One executable for macOS, Linux, Windows on x64 and arm64; same language as Claude Code hooks and the MCP SDK |
| Store | SQLite (WAL) + sqlite-vec + FTS5 | Zero config, one file per project; FTS5 catches code identifiers that embeddings miss |
| Embeddings | Bundled small ONNX model (MiniLM-class), then Ollama, then provider API | Works offline with no setup; better models are picked up automatically if present |
| Router LLM (Stage 2) | User's own key, cheapest small model on their provider; Ollama allowed | No cost to us, no key held by us |
| Web UI | React + Vite + plain CSS variables | Small bundle, easy for contributors; tokens shared with the site |
| Tests | `bun test` + golden transcript fixtures | Router behaviour is pinned by recorded sessions, not mocks |
| Benchmark | Python 3.12 with uv | Matches ML tooling; runs in CI on a small fixture set, full run on demand |
| Lint and types | Biome, TypeScript strict | One fast tool, fewer config files |
| Releases | GitHub Actions, signed binaries, SHA-256 checksums | The curl installer verifies checksums before running |

The `core` package stays pure (no file, network or clock access) so the router and assembler can be tested exhaustively and reused later as SDK middleware.

## How we build with Claude Code

Claude Code writes most of the code; Pratyaksh owns the spec, the architecture, the router thresholds and every merge. The loop follows the operating pipeline's build stage, adapted for an open-source repo.

**The loop for every module**

1. **Spec first.** The module's section of `docs/spec.md` states inputs, outputs, acceptance tests and what is out of scope. Claude Code is told to refuse work that contradicts it.
2. **Plan mode.** Start each module in plan mode; Claude proposes files, interfaces and tests; a founder edits the plan before any code is written.
3. **Tests before code.** Fixtures and failing tests land first (golden transcripts for the router, snapshot payloads for the assembler).
4. **One module, one branch, one PR.** Never let an agent run across the whole repo for hours. Each PR has code, tests and a line in `decisions.md` if anything non-obvious was chosen.
5. **Reviewer subagent, then a cold self-review.** Checklist: nothing removes context without a journal entry; no hidden LLM call; no network call outside the provider path; tests assert behaviour, not that a mock was called; no new dependency without a one-line reason.
6. **Dogfood daily.** From week 5, you run ContextTree on your own Claude Code sessions, including while building ContextTree. Those transcripts become ReplayBench data (scrubbed).

**Solo review protocol.** With no second human, review is the main risk. Run the reviewer subagent on every PR, then read the diff yourself in a fresh Claude Code session that did not write it. Anything touching the proxy, auth headers, the installer or the journal waits overnight before merge. Optionally ask Daksh for a one-time review of the proxy and install script before launch.

**CLAUDE.md, the rules Claude Code reads every session** (full file is in the starter kit)

- What this is, in one paragraph, and the link to `docs/spec.md`.
- Stack and commands: `bun install`, `bun test`, `bun run dev`, `uv run bench smoke`.
- Architecture rules: `core` is pure; only `daemon` touches the network; only `store` touches disk.
- Accountability rules: any function that changes what the model sees must call `journal.record()` with action, signal, confidence and token delta; every action has an inverse registered for `undo`.
- Cache rules: never put per-branch content in the system prompt; branch message lists are append-only; volatile content goes in the last user turn.
- Privacy rules: no transcript content in logs, tests or commit messages; fixtures are synthetic or scrubbed.
- Ask before: schema changes, new dependencies, anything in the proxy path, anything that changes the install script.

**Claude Code setup for the repo**

- Project slash commands in `.claude/commands/`: `/spec-check` (compare a diff against the spec), `/bench-smoke` (run the small ReplayBench set), `/ui-shot` (screenshot the web UI for review).
- A subagent for review (`.claude/agents/reviewer.md`) that runs the founder checklist on a diff before a human looks at it. It does not replace the human review.
- A PostToolUse hook that runs `bun test` on the touched package after edits, so broken changes are caught in-session.
- Use worktrees (`claude --worktree`) to run two or three Claude Code sessions on separate modules in parallel; you review and merge each one.

**What not to hand to Claude Code:** router thresholds, the cache-assembly order, the benchmark's scoring rules and anything a reviewer will cite in a critique of our results. Claude can draft options; the decision goes in `decisions.md` with your reasoning.

## Phased build plan

Thirteen weeks from Monday 26 October 2026 to a launch in the week of 11 January 2027, in six phases with two hard gates. Each phase lists what ships, the prompt that opens it in Claude Code, and the condition to move on.

&#91;embedded content: ContextTree roadmap · 6 phases, 3 gates\]

Phases 0 and 1 overlap in week 1; gates are amber diamonds and the launch week is the accent.

**Solo capacity.** The dates assume about three focused days a week on ContextTree. If the maintainer's other commitments leave two, the plan slips by roughly a third. If you fall behind, cut in this order rather than move the launch:

1. Isolate mode moves to a post-launch release; launch on observe and suggest.
2. The PNG session card moves to the launch-week follow-up.
3. Windows signing and Homebrew wait; ship the curl, PowerShell and npx paths only.
4. Stage 2 escalation ships disabled by default if the day-30 numbers are borderline.

### Phase 0 · Foundations (week 1, 26 Oct – 1 Nov)

- [ ] Check "ContextTree", `ctree` (npm, Homebrew, PyPI, GitHub) and a domain for collisions; pick the final name.
- [ ] Create the repo under an org, Apache-2.0, DCO, CODE\_OF\_CONDUCT, SECURITY.md.
- [ ] Write `CLAUDE.md`, `docs/spec.md`, `docs/architecture.md` from the starter kit.
- [ ] Monorepo scaffold, Biome, strict TypeScript, `bun test`, CI.
- [ ] Transcript scrubber (secrets, emails, paths, keys) and collect 50+ of our own Claude Code sessions.

```text
Read CLAUDE.md and docs/spec.md. Enter plan mode. Scaffold the monorepo exactly as
laid out in docs/architecture.md: packages core, store, embed, daemon, cli,
plugin-claude-code, ui, plus bench/ as a uv project. Add Biome, strict tsconfig,
bun test with one passing test per package, and a GitHub Actions workflow that runs
lint, types and tests. Do not add dependencies beyond those named in the spec.
```

**Exit:** CI green on an empty scaffold; 50+ scrubbed transcripts in a private folder.

### Phase 1 · ReplayBench v0 and router prototype (weeks 1–3, to 15 Nov)

- [ ] Splicer that interleaves independent sessions into streams with known branch IDs (hard cuts, cue phrases, returns at varying distance, a combine set).
- [ ] Router Stage 0: explicit cues, file-path overlap from tool calls, embedding similarity to branch centroids.
- [ ] Router Stage 2: LLM adjudicator for uncertain turns only, on the user's key.
- [ ] Metrics: per-turn action accuracy, F1 for new and return, over-carry rate, escalation rate, p50 and p95 latency.

```text
Implement bench/splice.py per docs/spec.md §ReplayBench. Write tests first with three
tiny synthetic sessions. Then implement packages/core/router as a pure cascade:
stage0(turn, tree) -> {action, confidence, signals}; escalate only when confidence is
between the two thresholds in config. Thresholds are placeholders; do not tune them.
Expose a CLI `ctree route --replay <file>` that prints one JSON line per turn.
```

**Gate (day 30):** Stage 0 + Stage 2 reach at least 0.85 F1 on new branches with no more than 10% escalation. If not, drop automatic routing and continue with manual `/ct` commands plus compaction-safe briefs only.

### Phase 2 · Daemon, plugin and the visual layer (weeks 4–7, 16 Nov – 6 Dec)

- [ ] `store`: SQLite schema (sessions, branches, turns, decisions), markdown mirror, append-only journal.
- [ ] `daemon`: localhost service the hooks call; observe and suggest modes.
- [ ] `plugin-claude-code`: UserPromptSubmit, SessionStart, PreCompact hooks; `/ct new|switch|undo|merge|status`; statusline; MCP tools `branch_list`, `branch_search`, `branch_recall`.
- [ ] `cli`: `ctree status`, `ctree tree`, `ctree undo`.
- [ ] Week 5 is design week: tokens, the three-pane layout, the context lens, the session card, reviewed as static mock-ups before UI code.
- [ ] Weeks 6–7: `ctree ui` built from the approved mock-ups; `ctree export --png`.
- [ ] Private beta opens at the end of week 7 with 30–50 Claude Code users.

```text
Build packages/plugin-claude-code. Use the hook contracts in docs/spec.md §Hooks.
UserPromptSubmit calls the daemon's /route endpoint and returns additionalContext
with a one-line routing receipt; it never blocks the prompt. SessionStart restores the
active branch brief after /clear or compaction. Every decision is written with
journal.record() and has an inverse for undo. Add golden-transcript tests.
```

**Exit:** you use it daily on real work for a week; undo rate and beta feedback logged.

### Phase 3 · Isolate mode and end-to-end proof (weeks 8–10, 7 – 27 Dec)

- [ ] Local proxy for the Anthropic Messages API behind `ctree mode isolate`.
- [ ] Cache-aware assembler: tools, system, trunk, active branch append-only, volatile tail last; per-branch cache TTL.
- [ ] Journal records cache-read and cache-write tokens per turn.
- [ ] End-to-end ReplayBench across four conditions: linear, observation masking, ContextTree, oracle branching.

```text
Implement packages/core/assemble per docs/spec.md §Assembly. Input: tree, active
branch, tail. Output: messages[] plus cache breakpoints. Property tests: the prefix
for a branch never changes between consecutive turns on that branch; nothing
branch-specific appears in system. Then wire it into packages/daemon/proxy behind the
isolate flag with streaming passthrough and OAuth header forwarding.
```

**Gate (day 60):** task success no worse than linear and at least 25% fewer input tokens at neutral or better cost on long or distant-tangent sessions. If not, keep observe and suggest only and publish the negative result. Plan for a lighter week over 25 December.

### Phase 4 · Install, docs and polish (weeks 11–12, 28 Dec – 10 Jan)

- [ ] `install.sh` (checksum-verified, wrapped in a function), `install.ps1`, Homebrew tap, `npx` shim, `/plugin` marketplace manifest, `ctree uninstall`.
- [ ] Signed release pipeline for six targets.
- [ ] README with persona split, hero GIF made with VHS and regenerated in CI, benchmark table with caveats.
- [ ] Website, docs with `llms.txt`, TELEMETRY.md (none on content), SECURITY.md.
- [ ] ReplayBench write-up for arXiv, with harness and scrubbed traces released.

**Exit:** a stranger on a clean Mac, Linux box and Windows machine goes from nothing to a routed session in under two minutes.

### Phase 5 · Launch (week 13, 11 – 17 Jan)

- [ ] Show HN on a Tuesday to Thursday at 8–9 am ET (6:30 pm IST), with a number in the title.
- [ ] 30-second demo on X, posts in r/ClaudeAI and r/ChatGPTCoding, marketplace listing, PRs to awesome-claude-code and awesome-mcp-servers.
- [ ] If a major Claude Code or model release lands within two weeks, move the launch next to it.

**Gate (day 90, launch + 30 days):** under 30% of routing decisions undone and D30 retention of active installers at least 20%. If not, freeze features and reassess against the maintainer's other commitments.

## Free and accessible to all

Free means three things here: it costs the user nothing beyond what they already pay their model provider, it costs us almost nothing to run, and nobody is locked out by platform, hardware, network or ability.

**Cost to users: zero by design**

- No account, no sign-in, no hosted service in any default path.
- Observe and suggest modes run fully offline: Stage 0 routing uses the bundled embedding model, no API calls.
- Stage 2 escalation is optional and uses the user's own key, or a local Ollama model, or is turned off. The UI shows its spend per session (expected well under one cent per escalated turn on a small model; to be measured in Phase 1).
- Isolate mode is meant to lower the user's bill. If the journal shows a session cost more than linear would have, `ctree status` says so.

**Cost to us: near zero**

- Hosting is a static website and GitHub Releases, both free tiers.
- No servers to run, so a viral spike costs nothing and cannot take the product down.
- The only recurring cost is the domain and code-signing certificates; budget a few thousand rupees a year, plus Apple and Windows signing if we choose to notarise binaries.

**Install paths for every setup**

| User | Command | Notes |
| --- | --- | --- |
| macOS / Linux | `curl -fsSL https://<domain>/install.sh \| sh` | Hero command; detects Claude Code and installs the plugin |
| Windows | `irm https://<domain>/install.ps1 \| iex` | PowerShell, no admin rights needed |
| Node users, quick try | `npx contexttree@latest init` | No permanent install |
| Homebrew | `brew install <org>/tap/contexttree` | Auto-updates with brew |
| Inside Claude Code | `/plugin marketplace add <org>/contexttree` then `/plugin install contexttree` | For people who never leave the agent |
| Manual | Signed binaries + checksums on GitHub Releases and the website | For locked-down machines |

**Runs on modest machines**

- Target under 150 MB RAM for the daemon with the bundled embedding model, under 30 ms added per turn in suggest mode, and a binary under 100 MB. These are targets to measure in Phase 2, not promises.
- Works on x64 and arm64, including older laptops and Raspberry Pi-class Linux.

**Accessible to everyone who uses it**

- UI meets WCAG 2.2 AA in light and dark themes; full keyboard control; screen-reader tree semantics; reduced-motion respected.
- Every visual (context lens, tree, session card) has a text equivalent in `ctree status --json` and `ctree tree`.
- Docs in plain English with copy-paste commands and a 2-minute quickstart; translations accepted from the community after launch.
- Error messages say what happened and the one command to fix it; `ctree doctor` checks the whole setup.

**Kept free by structure, not promise**

- Apache-2.0 for the whole repo, contributions licensed under Apache-2.0 (section 5 of the license) instead of a CLA, and a written commitment in the README that the license will not change.

## Risks, kill criteria and decisions needed

The biggest risk is Anthropic building automatic topic routing into Claude Code; the biggest unknown is whether real sessions contain enough distant tangents for isolation to pay. The plan answers the second by week 3 and hedges the first by staying cross-tool and making the journal and benchmark the lasting assets.

| Risk | Mitigation |
| --- | --- |
| Anthropic ships native automatic routing | Stay cross-tool (Codex, OpenCode next); build on native `/fork` and `/btw` rather than against them; the journal and ReplayBench outlive any one feature |
| claude-mem or Letta adds routing | Ship first with a published benchmark; interoperate (export to both) rather than compete on memory |
| Router cuts context the model needed | Bias thresholds toward continue; suggest mode by default; one-command undo; measure undo rate |
| Cache misses raise users' bills | Cache-aware assembly as a tested property; isolate only when the branch prefix is well below full history; cost shown per session |
| Proxy breaks or conflicts with terms | Isolate mode is opt-in; confirm subscription-login terms before launch; enterprise `allowedProviders` blocks fail loudly with a clear message |
| Prompt injection stored in briefs | Treat branch content as untrusted data; never inject briefs into system; signed releases |
| Maintainer overload after a spike | Issue templates, a triage rota, `good first issue` labels, a public roadmap; solo maintainer, so issues are triaged twice a week, not live, and the README says so |

**Decisions to make before week 1**

- [ ] Final name and domain, after a collision check (can wait until Phase 4).
- [ ] Final numbers for the three gates (the plan's numbers are drafts).
- [ ] Whether beta users' transcripts may be donated to ReplayBench, and the consent wording.
- [ ] Whether to notarise macOS and sign Windows binaries at launch (small cost, fewer install warnings).
