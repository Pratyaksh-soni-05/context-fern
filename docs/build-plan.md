# ContextTree build plan

**2026-11-03 note, read this first**: this file is historical. It predates the Context Fern rename (written as ContextTree/`ctree`, branch/trunk — the current, locked vocabulary is fern/frond/stem, `packages/core/src/brand.ts`) and predates spec v0.3. The day-30 gate below (Phase 1) is **resolved, not an open decision**: ReplayBench found that free, local Stage 0+2 routing does not reach a trustworthy auto-routing accuracy, so the plan's own fallback took effect — manual-first routing, shipped in spec v0.3 (`docs/decisions.md`, 2026-10-26). A future session reading this file should not reopen that question; `docs/spec.md` is the current source of truth for scope, and `docs/decisions.md` is the record of what was actually decided and why. Checkboxes below reflect real repo state as of this note, not the original 13-week schedule, which did not hold as written.

**2026-11-10 addendum, same rule applies**: Phase 4's install-paths table and checklist below (`curl`/`irm`/`npx`/Homebrew/marketplace-add, all six at once) are **also superseded**, not current scope. Launch install paths are exactly three — `pip install context-fern`, `uvx context-fern init`, `npx context-fern init` — chosen because no personal or company name may appear in any user-facing install command, and only a bare registry package name manages that without a GitHub owner slug or a domain. `curl`/`install.ps1`/Homebrew/a standalone marketplace-add move to a separate post-launch PR once the repo has an organisation or a domain. See `docs/spec.md` §3.9/§14 and `docs/decisions.md` (2026-11-10) for the current, binding scope — don't reopen this one either.

**Current, not historical — pre-public-release checklist (added 2026-11-10, keep this current when the rest of this file isn't):**
- [ ] Secret scan over the *full* git history (not just the working tree) before the repo is made public.
- [ ] GitHub email privacy: Settings → Emails → tick "Keep my email addresses private" and "Block command line pushes that expose my email", and keep the local git identity on the account's `<id>+<login>@users.noreply.github.com` address. History was rewritten into a new repository in November 2026 (see `docs/decisions.md`, 2026-11-23); every commit in it carries a noreply address.
- [ ] Confirm `bench/denylist.txt` and `bench/data/` (especially `bench/data/private/`, which holds real non-synthetic content) are not tracked in git — point-in-time confirmed clean via `git log --all --full-history` on 2026-11-10 (`docs/decisions.md`); re-run before the actual publish, not just once.
- [ ] npm trusted publishers: create or refresh all six (`context-fern`, `context-fern-model`, `@context-fern/win-x64`, `@context-fern/linux-x64`, `@context-fern/linux-arm64`, `@context-fern/darwin-arm64`; all reserved at 0.0.0) ONLY right before the first release candidate, when the repo is public and the `publish-npm` job can run. A new entry expires, and then cannot be used or edited, unless a real publish validates it within 2 days of creating it (npm docs; observed 2026-11-18: "publish once before Nov 20"). Values for each: owner `Pratyaksh-soni-05` (`REPO_OWNER` in `packages/core/src/brand.ts`), repository `context-fern`, workflow `release.yml`, Environment `npm`, "Allow npm publish" ticked, dist-tag unticked. npm does not check the entry when it is saved, so a wrong value only shows up as a failed publish. If an entry expires, delete it, recreate it and publish again within 2 days. The first public release candidate publishes to npm (decision 2026-11-18, below), so it is the publish that validates them.
- [ ] **First release candidate publishes to npm under the `rc` dist-tag, never `latest` (maintainer decision 2026-11-18; the workflow change is its own PR, `feat/npm-rc-publish`, opened after #23 merges; until it merges the `publish-npm` job still skips `-rc.` tags).** Order of events, from the maintainer's side:
  1. Everything above is done, and the repo is made public; `PUBLISH_ENABLED` is set; the Environments `release`, `npm`, `testpypi` and `pypi` have their reviewers.
  2. Create the six npm trusted publishers (values above). The 2-day window starts now, so do step 3 the same day.
  3. Push the tag `vX.Y.Z-rc.1`. `publish-npm` publishes all six with `--tag rc`; approve the `npm` Environment; the TestPyPI job runs too.
  4. Verify (all must hold, `scripts` or the verify job prints each): `npm view <name> dist-tags --json` shows `rc` = the rc version on all six and `latest` unchanged (still `0.0.0`); each package page shows a provenance badge; on a clean machine `npm i context-fern@rc` installs exactly that platform's `@context-fern/<target>` at the rc version plus the matching model, and `npx context-fern@rc --version` prints the rc version; `npm i context-fern` (no tag) still gives the 0.0.0 placeholder.
  5. If anything is wrong: the rc version number is burned (see "left behind" below), so fix and push `-rc.2`; the trusted-publisher entries are already validated by then.
  6. Stable: bump `CLI_VERSION` and the plugin manifest, push `vX.Y.Z`. `publish-npm` publishes with no tag, so `latest` moves to the stable version on every package.
  7. Verify again without the `@rc` tag: `latest` is the stable version on all six, and `rc` still points at the last rc (remove it with `npm dist-tag rm <name> rc` from your own account if you do not want it, or leave it).
- [ ] Model package version during the rehearsal (maintainer decision 2026-11-18, option A): the rc build publishes `context-fern-model` as `1.0.0-rc.N`, with N taken from the tag's rc number, and the rc main package pins that exact version; stable publishes a fresh `1.0.0` and `latest` is set normally, so no dist-tag permission is needed. Reason: an npm version can never be published twice, so publishing `1.0.0` at the rc would freeze its bytes early and leave `latest` on the placeholder. Cost: the 16 MB model is uploaded again for every rc.
- [ ] If `npm publish --tag rc` is refused with only "Allow npm publish" ticked (npm's docs do not say whether `--tag` needs more), tick "Allow npm dist-tag" on the failing package's trusted-publisher entry only, not on the others.
- [ ] Left on the registries by a release candidate, and hard to undo (npm's unpublish rules are quoted below from the current docs): the rc version numbers are burned for good even if removed; every rc tarball (about 60 to 110 MB per platform) stays downloadable while the version exists; the provenance record (repository URL, workflow, commit, runner) goes in a public transparency log that cannot be edited later, so the owner slug is in it permanently; the `rc` dist-tag stays until removed; the GitHub prerelease and tag are public; a run that fails half way leaves some of the six at the rc version and the rest not (the job publishes the model and platforms first and the launcher last, and skips versions already published, so re-running the same tag finishes it). npm's unpublish rules (docs.npmjs.com/policies/unpublish, read 2026-11-18): within 72 hours of publishing you may unpublish if no other package in the public registry depends on it; after 72 hours only if all three hold: nothing in the registry depends on it, it had fewer than 300 downloads in the last week, and it has a single owner or maintainer; `npm unpublish <name>@<version>` removes one version. Registry data is immutable: no package can ever be published again with that name at that version, even after an unpublish; unpublishing every version blocks new versions of the package for 24 hours. Our six packages depend on each other (the launcher on the model and the platform packages), so the dependents rule applies between them: unpublish the launcher before the packages it depends on. Otherwise use `npm deprecate <name>@<version> "message"`, which keeps the version downloadable and shows the warning.
- [ ] PyPI and TestPyPI pending publishers: PyPI's current docs (docs.pypi.org/trusted-publishers, read 2026-11-18) give no expiry for pending publishers, and say a pending publisher does NOT create the project or reserve the name until it is used; if someone else registers the name first, the pending publisher is invalidated. So the two PyPI names are not reserved yet. Consider uploading a `0.0.0` placeholder for each (maintainer's call, like the npm ones), and add the pending publishers on pypi.org and test.pypi.org separately (they are separate sites, and the docs do not mention TestPyPI at all, so check its page when you create the entry).
- [ ] Before the first release candidate, confirm the `publish-npm` job's toolchain supports trusted publishing, against the current npm docs (docs.npmjs.com/trusted-publishers, read 2026-11-18): npm CLI 11.5.1 or later (the job installs exactly `npm@11.5.1`) and Node 22.14.0 or later (the job uses `node-version: "22"`, which resolves to the newest 22.x; check the resolved version in the job log), plus `id-token: write` on the job and the exact workflow filename `release.yml`.
- [x] Pin the plugin marketplace source to the release tag (done 2026-11-24, `docs/decisions.md`). `context-fern init` and its manual fallback now run `claude plugin marketplace add Pratyaksh-soni-05/context-fern#v<CLI_VERSION>` (`MARKETPLACE_SOURCE` in `packages/cli/src/install/plugin-setup.ts`), so a user on version N gets the hooks released with version N, not whatever is on `main`. Still open: a marketplace named `context-fern` that a user already has (for example from before this change) is not re-pinned by `init`; `claude plugin marketplace remove context-fern`, then `init`, re-adds it.
- [x] PyPI attestations: decided 2026-11-18, none for launch (PyPI releases are trusted-published without PEP 740 attestations; npm releases carry provenance; the GitHub Release tarballs carry build provenance). Every document must say exactly that and no more; see the post-launch list below.
- [x] The `publish` job (GitHub Release) is gated like the registry jobs: `PUBLISH_ENABLED`, its own Environment `release`, and `needs` on `package`, `install-smoke` and `glibc-floor`; `-rc.` tags are prereleases (decided 2026-11-18, done in #23).
- [x] The six npm names (`context-fern`, `context-fern-model`, four `@context-fern/<target>`) are reserved at 0.0.0 (done by the maintainer, 2026-11-18). Still open: the PyPI names (a pending publisher does not reserve a name; see the PyPI item above) and the npm trusted publishers, which are created only right before the first release candidate (first item above).
- [ ] Repository settings for publishing, set by the maintainer once the repository is public, in this order and **before the first `v*` tag**: (1) tag protection for `v*`; (2) Environments `release`, `testpypi`, `pypi`, `npm`, each with required reviewers and a deployment rule limited to `v*` tags; (3) only then the repository variables `PUBLISH_TEST_ENABLED` and `PUBLISH_ENABLED`. Also decide whether `v*` tags must point at commits on `main`, and hash-pin (or vendor) the `uv` and `npm` installs in the jobs that hold `id-token: write`. Until (1) and (2) exist, anyone with push access can tag any commit.

**Post-launch (not launch scope):**
- [ ] PyPI attestations: allow `pypa/gh-action-pypi-publish` on the repository's Actions allowlist, pin it by commit SHA, replace the `uv publish` steps with it, and publish PEP 740 attestations. Until then no document may say PyPI releases are attested.
- [ ] `fern doctor` compares the installed native sidecar with the install manifest (Phase 4 PR 5).

**Notes for Phase 4 PR 6 (site, README and install docs):**
- Say plainly that the first daemon start on a cold Windows machine (Defender scanning an unsigned executable) can take longer than the CLI's fixed ~5 s wait; the hook fails open, so the prompt passes untouched, and the daemon keeps starting, so the next call finds it. The limit is not changed (`docs/decisions.md`, 2026-11-18).
- `SECURITY.md`, the README and the site state the attestation position exactly: PyPI releases are trusted-published without PEP 740 attestations, npm releases carry provenance, GitHub Release tarballs carry build provenance. No stronger claim.
- Install docs: unsigned binaries (SmartScreen and Gatekeeper interstitials are expected), Intel Macs unsupported at launch, and the `Landing.dc.html` footer still names a personal account (`docs/decisions.md`, 2026-11-10 and 2026-11-14).

Historical plan, written under the working name ContextTree. Current scope: docs/spec.md (v0.2).

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

- [x] Check "ContextTree", `ctree` (npm, Homebrew, PyPI, GitHub) and a domain for collisions; pick the final name. — done as "Context Fern" / `fern`, locked in `packages/core/src/brand.ts`.
- [x] Create the repo under an org, Apache-2.0, CODE\_OF\_CONDUCT, SECURITY.md. — `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CONTRIBUTING.md` all exist at the repo root.
- [x] Write `CLAUDE.md`, `docs/spec.md`, `docs/architecture.md` from the starter kit.
- [x] Monorepo scaffold, Biome, strict TypeScript, `bun test`, CI. — `.github/workflows/ci.yml`.
- [ ] Transcript scrubber (secrets, emails, paths, keys) and collect 50+ of our own Claude Code sessions. — the scrubber shipped (`bench/src/bench/scrub.py`, tested); collecting 50+ real sessions isn't confirmed done.

```text
Read CLAUDE.md and docs/spec.md. Enter plan mode. Scaffold the monorepo exactly as
laid out in docs/architecture.md: packages core, store, embed, daemon, cli,
plugin-claude-code, ui, plus bench/ as a uv project. Add Biome, strict tsconfig,
bun test with one passing test per package, and a GitHub Actions workflow that runs
lint, types and tests. Do not add dependencies beyond those named in the spec.
```

**Exit:** CI green on an empty scaffold; 50+ scrubbed transcripts in a private folder.

### Phase 1 · ReplayBench v0 and router prototype (weeks 1–3, to 15 Nov)

- [x] Splicer that interleaves independent sessions into streams with known branch IDs (hard cuts, cue phrases, returns at varying distance, a combine set).
- [x] Router Stage 0: explicit cues, file-path overlap from tool calls, embedding similarity to branch centroids. — `packages/core/src/router`.
- [x] Router Stage 2: LLM adjudicator for uncertain turns only, on the user's key. — ships local-only (Ollama), disabled by default; see `docs/decisions.md`.
- [x] Metrics: per-turn action accuracy, F1 for new and return, over-carry rate, escalation rate, p50 and p95 latency. — `bench/results/day30-report.md`.

```text
Implement bench/splice.py per docs/spec.md §ReplayBench. Write tests first with three
tiny synthetic sessions. Then implement packages/core/router as a pure cascade:
stage0(turn, tree) -> {action, confidence, signals}; escalate only when confidence is
between the two thresholds in config. Thresholds are placeholders; do not tune them.
Expose a CLI `ctree route --replay <file>` that prints one JSON line per turn.
```

**Gate (day 30) — resolved, see the note at the top of this file:** Stage 0 + Stage 2 reach at least 0.85 F1 on new branches with no more than 10% escalation. If not, drop automatic routing and continue with manual `/ct` commands plus compaction-safe briefs only. **The gate did not pass**; the fallback is what shipped — manual-first routing, spec v0.3, `docs/decisions.md` 2026-10-26. Do not reopen this.

### Phase 2 · Daemon, plugin and the visual layer (weeks 4–7, 16 Nov – 6 Dec)

- [x] `store`: SQLite schema (sessions, branches, turns, decisions), markdown mirror, append-only journal. — `packages/store`.
- [x] `daemon`: localhost service the hooks call; observe and suggest modes. — `packages/daemon` (isolate mode's proxy is not built; see Phase 3 below).
- [x] `plugin-claude-code`: hooks, `/fern` commands, statusline, MCP tools — shipped under the current `fern`/frond naming, not the `/ct`/`branch_*` names drafted here. `packages/plugin-claude-code`.
- [x] `cli`: `fern status`, `fern tree`, `fern undo` (and more). — `packages/cli`.
- [x] Week 5 is design week: tokens, the three-pane layout, the context lens, the session card, reviewed as static mock-ups before UI code. — `docs/design/DESIGN.md`, `docs/design/tokens.css`, `docs/design/blueprint/`.
- [ ] Weeks 6–7: `ctree ui` built from the approved mock-ups; `ctree export --png`. — `packages/ui` is still a scaffold, no real UI built yet.
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

- [x] Final name and domain, after a collision check (can wait until Phase 4). — name decided: Context Fern / `fern`.
- [ ] Final numbers for the three gates (the plan's numbers are drafts).
- [ ] Whether beta users' transcripts may be donated to ReplayBench, and the consent wording.
- [ ] Whether to notarise macOS and sign Windows binaries at launch (small cost, fewer install warnings).
