# ContextTree

## What this is
ContextTree is a free, local, open-source context router for coding agents. It splits a session into a topic tree, sends the model only the trunk plus the active branch (in isolate mode), keeps each branch as a markdown brief that survives compaction, and logs every routing decision so the user can see it, undo it or merge it. Apache-2.0. No account, no hosted service, no content telemetry.

Source of truth for scope and acceptance: `docs/spec.md`. If a request contradicts the spec, say so and stop; do not implement it.

Working name. "ContextTree" and the CLI name `ctree` are placeholders. Never hard-code either: import `PRODUCT_NAME`, `CLI_NAME`, `CONFIG_DIR` (`.contexttree`) and `ENV_PREFIX` (`CONTEXTTREE_`) from `packages/core/src/brand.ts`. Renaming must be a one-file change plus package metadata.

Solo maintainer. There is one human reviewer. Before saying a PR is ready, run the `reviewer` subagent and fix what it finds. Flag in the PR description any change to the proxy, auth headers, installer or journal so it waits a day before merge.

## Stack and commands
- Bun (latest stable), TypeScript strict, Biome for lint and format.
- SQLite via `bun:sqlite`, `sqlite-vec`, FTS5.
- Web UI: React + Vite, plain CSS variables (tokens in `docs/design/tokens.css`).
- Benchmark: Python 3.12 with uv, in `bench/`.

```
bun install              # install workspace deps
bun test                 # all TS tests
bun test packages/core   # one package
bun run dev              # daemon + UI in watch mode
bun run build            # compile the ctree binary for this OS
uv run --project bench bench smoke   # small ReplayBench run
```

## Architecture rules
- Monorepo packages: `core`, `store`, `embed`, `daemon`, `cli`, `plugin-claude-code`, `ui`. See `docs/architecture.md`.
- `core` is pure: no file system, no network, no clock, no randomness. Inject them.
- Only `store` touches disk. Only `daemon` and `embed` touch the network.
- `ui` talks to the daemon over its localhost HTTP API only.
- Public types live in `packages/core/src/types.ts`. Changing them needs an entry in `docs/decisions.md`.

## Accountability rules (non-negotiable)
- Any code path that changes what the model sees, or the tree, MUST call `journal.record()` with: action, turn, branch, signals, confidence, tokens before and after, cache read and write tokens (when known).
- Every action type registers an inverse so `ctree undo` can reverse it. No action ships without its undo test.
- Every LLM call the router makes is recorded in the journal with model and token counts. No hidden calls.

## Cache rules (isolate mode)
- Assembly order is fixed: tools, system, trunk, active branch, volatile tail.
- Never put per-branch or per-turn content in the system prompt.
- A branch's message list is append-only between turns on that branch. A property test enforces this.

## Privacy rules
- No transcript content in logs, tests, fixtures, snapshots or commit messages. Store content hashes in `turns`, not content.
- Fixtures are synthetic or passed through `bench/scrub.py`.
- No telemetry on content. The only optional network ping is the opt-in version check described in `TELEMETRY.md`.

## Conventions
- One module, one branch, one PR. PRs include tests and, if anything non-obvious was decided, one dated line in `docs/decisions.md`.
- Tests first for router and assembler work; behaviour is pinned with golden transcripts in `packages/*/test/fixtures/`.
- Tests assert behaviour, never that a mock was called.
- Conventional commits.
- New dependency = one-line justification in the PR. Prefer zero-dependency solutions.
- User-facing strings: plain English, say what happened and the one command that fixes it.

## Ask before you
- change the SQLite schema or public types
- add a dependency
- touch `packages/daemon/src/proxy/` (isolate mode) or anything that forwards auth headers
- change `install/` scripts or release workflows
- change router thresholds or benchmark scoring (the maintainer decides these; draft options instead)
