# Claude Code kickoff prompts, in build order

Start each in plan mode. Edit the plan before approving. One module per branch and PR.

## 0. Scaffold (week 1)
Read CLAUDE.md and docs/spec.md. Scaffold the monorepo exactly as laid out in docs/architecture.md: packages core, store, embed, daemon, cli, plugin-claude-code, ui, plus bench/ as a uv project. Add Biome, strict tsconfig, bun test with one passing test per package, and a GitHub Actions workflow that runs lint, types and tests. Do not add dependencies beyond those named in the spec. Create packages/core/src/brand.ts exporting PRODUCT_NAME, CLI_NAME, CONFIG_DIR and ENV_PREFIX, and use it everywhere the name appears, including package.json bin entries generated at build time.

## 1. Scrubber and splicer (week 1–2)
Implement bench/scrub.py and bench/splice.py per spec §12. Tests first with three tiny synthetic sessions. Splice variants: hard cut, cue phrase, return at distance d, combine. Output JSONL with ground-truth branch ids per turn.

## 2. Router Stage 0 (week 2)
Implement packages/core/router as a pure function stage0(turn, tree, signalsInput) -> Decision per spec §5. Inject the embedder. Golden tests from spliced fixtures. Expose `ctree route --replay <file>` printing one JSON line per turn.

## 3. Router Stage 2 and metrics (week 3)
Add escalation for uncertain turns via an injected LLM client (Anthropic, OpenAI, Ollama adapters in daemon). Record every call. Implement bench/run.py router metrics. Thresholds are config placeholders; do not tune them.

## 4. Store and journal (week 4)
Implement packages/store: schema per spec §11 with migrations, markdown brief mirror, journal writer with inverse registry. Property test: undo after any sequence of decisions restores the prior tree.

## 5. Daemon and plugin (weeks 4–5)
Implement the daemon HTTP API per docs/architecture.md and packages/plugin-claude-code per spec §7. UserPromptSubmit never blocks; 300 ms timeout with pass-through. SessionStart restores the active brief after /clear or compaction.

## 6. CLI (week 5)
`ctree status`, `tree`, `mode`, `undo`, `merge --summary`, `doctor`. Terminal tree uses box-drawing characters only.

## 7. UI (weeks 6–7, after design week)
Build packages/ui from docs/design mock-ups: tree pane, brief editor (saves via PUT /branch/:id/brief), context lens, journal timeline with undo. Keyboard navigation, ARIA tree, light/dark from tokens.css, reduced motion. Add `ctree export --png` session card (1200×630).

## 8. Assembler and proxy (weeks 8–9)
Implement packages/core/assemble per spec §8 with the property tests. Wire into packages/daemon/proxy behind the isolate flag: Anthropic Messages API, streaming passthrough, OAuth header forwarding, cache token accounting into the journal.

## 9. End-to-end bench (week 10)
Extend bench/run.py with the four conditions (linear, observation masking, ContextTree, oracle). Execution-graded where possible. Write results to bench/results/.

## 10. Install and release (weeks 11–12)
install/install.sh (wrapped in a function, verifies SHA-256), install.ps1, Homebrew formula, npm shim, plugin marketplace manifest, `ctree uninstall`. Release workflow builds and signs six targets and publishes checksums.
