# Context Fern

Context Fern is a free, local, open-source tool that keeps a long coding-agent session organised by topic. It splits the session into a fern: a stem for the shared task and a frond for each topic. It writes each frond down as a short markdown brief that survives `/clear` and compaction, and it logs every routing decision so you can see it, undo it or merge it. It plugs into Claude Code today.

No account, no hosted service, no telemetry on your content. Apache-2.0.

**Status: not released yet.** The code and the install paths below are built, but no package has been published. Until the first release candidate is out, the install commands will not find anything on the registries.

## What it does today

- **Keeps a brief per topic.** Each frond has a markdown brief in `.fern/fronds/`. In `suggest` mode, after `/clear` or compaction, the active frond's brief is handed back to the model on the next turn.
- **You route, it suggests.** Starting a new frond, switching back, and setting a question aside as a stray are things you do with `/fern new`, `/fern switch` and `/fern stray` (or the `?` prefix). Context Fern shows a suggestion to start a frond or set a stray aside only when it is confident enough, and it never starts a frond, switches frond or sets a stray aside until you say so. See [Routing is manual-first](#routing-is-manual-first).
- **Logs every decision.** Each routing decision is written to the journal with the action, the signals behind it and its confidence. `fern undo` reverses the last one.
- **Shows the fern.** `fern ui` opens a local page with the Fern, List and Categories views and an inspector for any leaflet.
- **Works offline.** Observe and suggest mode run with the embedding model that ships in the package, and make no API calls. (A second-stage router that asks a local Ollama model exists only in the replay and benchmark tools. It is not connected to the running product in this release.)

Vocabulary: a **frond** is a topic thread, a **leaflet** is one turn on a frond, a **stray** is an off-topic question answered and kept off every frond, the **stem** is the context every frond shares, and a **root** is a memory from an earlier session.

## Install

These are the three launch install paths. The `init` step sets up the Claude Code plugin when the `claude` command is on your path, and otherwise prints the exact manual steps.

```
pip install context-fern && context-fern init
uvx context-fern init
npx context-fern init
```

`init` asks before it adds the install folder to your `PATH`, before it registers the plugin with your `claude` command, and before it adds a status line (an existing status line is left alone). In a project it also offers to add `.fern/` to `.gitignore` and to add a project-level `/fern` command at `.claude/commands/fern.md`. `fern uninstall` removes exactly what `init` recorded and nothing else: those two project files stay, and it never deletes `.fern/` or `~/.fern`. It tells you where they are and the one command that deletes them.

Platforms: Windows x64, Linux x64 and arm64 (glibc 2.28 or newer), and macOS on Apple silicon (macOS 14 or newer). Intel Macs are not supported. The binaries are not code-signed, so Windows SmartScreen and macOS Gatekeeper may warn; see [`SECURITY.md`](SECURITY.md).

## If you use Claude Code

1. Install with one of the commands above, then run `context-fern init` (or `fern init`) inside a project.
2. Work as you normally do. A new session starts in `suggest` mode.
3. When you change topic, type `/fern new <name>`. To ask a side question without it joining the task, start the prompt with `?` or use `/fern stray`.
4. `/fern status` shows where you are, `/fern undo` takes back the last decision, and `fern ui` shows the whole fern.

A new user in an existing project starts with an empty fern: just the stem and no fronds. Context Fern does not read your earlier sessions or anyone else's, so there is nothing to see until you have worked with it for a while. Roots (memories from earlier sessions) are not built yet.

## Routing is manual-first

Deciding automatically where a turn belongs is not reliable enough yet, so Context Fern does not do it.

- You start and switch fronds yourself.
- In `suggest` mode it proposes a new frond or a stray only when the suggestion clears a precision bar, and below that bar the turn stays on the active frond until you route it.
- A suggestion to go back to an earlier frond is always shown, and it too waits for `/fern switch`.
- Every turn you do not route stays on the active frond. Starting a frond, switching or setting a stray aside happens only when you say so.

The measurements behind this are below.

## Modes

| Mode | What the model sees | State |
| --- | --- | --- |
| observe | Unchanged. Context Fern grows the fern and the briefs and shows them in the UI. | Available |
| suggest | Unchanged, plus one line naming the active frond, its goal and where its brief lives. After `/clear`, compaction, resume or fork it also restores the stem brief and the active frond's brief, quoted and secret-filtered, up to about 8 KB. The model can also look up briefs through three read-only tools. The default. | Available |
| isolate | Would send the model only the stem and the active frond. | Planned, not in this release |

Isolate mode would need a proxy between Claude Code and your model provider. That proxy does not exist yet, so nothing in this release changes how much context is sent, and Context Fern makes no claim about saving tokens or cost.

## How well does the router work?

Not well enough to route for you, and that is why routing is manual-first. The day-30 gate run is written up in [`bench/results/day30-report.md`](bench/results/day30-report.md); the table below is a fresh re-run of the router on the same kind of data.

**Read this before the numbers.** The data is **spliced and synthetic**: segments of real, scrubbed sessions stitched together so that the topic changes are known. It is **not natural data**, and there are no hand-labelled natural sessions yet. The planned gate was a suggestion precision of at least 0.85, and on the interim spliced-data bar the **day-30 gate result is FAIL**.

Re-run on 2026-11-20 with `uv run --project bench bench eval` over 36,964 spliced turns, with the router's default settings and no tuning. F1 is the score for finding each kind of turn; accuracy is the share of turns given the right action.

| splice variant | turns | F1 new frond | F1 return | F1 stray | accuracy | accuracy if every turn just continues |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| combine | 6,779 | 2.3% | 10.9% | n/a | 84.8% | 90.2% |
| cue phrase | 6,291 | 14.6% | 30.8% | n/a | 81.5% | 89.0% |
| hard cut | 7,962 | 0.0% | 9.5% | n/a | 84.8% | 89.9% |
| return at distance | 8,017 | 3.0% | 9.6% | n/a | 81.1% | 86.3% |
| stray | 7,865 | 2.2% | 13.2% | 69.5% | 81.1% | 80.6% |

What this says:

- The router is **worse than doing nothing** on accuracy in four of the five variants, because most turns really do continue the active frond. Its F1 for finding a new frond is 0% to 15%.
- Stray turns exist only in the `stray` variant, which is the only place a stray score means anything (n/a elsewhere).
- Cue phrases carry most of what it finds: cue phrases alone average F1 0.051 and embeddings alone 0.000, against 0.275 for the full router.
- A tuned run on a 471-turn sample, in the day-30 report, did better: F1 for a new frond 0.615, return 0.398, stray 0.484 (the second-stage local-model router, which is not connected to the running product, reached 0.643, 0.404 and 0.515 at its best setting).
- A blind judge (Claude, shown 120 turns without the answers) scores F1 0.832 on finding a new frond, so the task can be learned; the router is not there.
- The day-30 bar was within 0.05 of that ceiling, or 0.782. The best result was 0.643, so the gate is **FAIL**, and the literal target of suggestion precision 0.85 is further off.

ReplayBench, the scrubber and the scoring code are in [`bench/`](bench/), so you can check how these numbers were made.

## Privacy and security

- What is stored, where, and what is only best-effort: [`TELEMETRY.md`](TELEMETRY.md).
- How to report a vulnerability, how releases are built, and what is not signed: [`SECURITY.md`](SECURITY.md).

## Not built yet

Isolate mode and its proxy, roots and syncing earlier sessions into a new project, automatic merging, other agents besides Claude Code, and a version check. See [`docs/spec.md`](docs/spec.md) for what is in scope for launch.

## Build on it or contribute

The code is a Bun and TypeScript monorepo with a Python benchmark.

- [`docs/spec.md`](docs/spec.md): scope and acceptance.
- [`docs/architecture.md`](docs/architecture.md): how it is built.
- [`docs/decisions.md`](docs/decisions.md): why it is the way it is.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to send a change.

```
bun install              # install workspace dependencies
bun run test             # TypeScript tests and the benchmark's pytest
bun run test:e2e         # build the UI, then the browser tests
bun run dev              # daemon and UI in watch mode
bun run build            # compile the binary for this OS
```
