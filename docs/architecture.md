# Context Fern architecture

```
 Claude Code ──hooks──┐         Codex / OpenCode (phase 2)      Cursor (MCP, manual)
                      ▼                     ▼                          ▼
 ┌──────────────────────────── fern daemon (localhost) ────────────────────────────┐
 │ control plane        router cascade            context assembler      journal  │
 │ /fern, statusline ──▶ S0 cues+files+vectors ──▶ stem+frond+tail  ──▶   + undo   │
 │ receipts             S2 LLM if unsure          (isolate mode)                    │
 └───────────┬──────────────────────┬───────────────────────────┬──────────────────┘
             ▼                      ▼                           ▼
   store: SQLite+vec+FTS5      fern ui (web)          model APIs via proxy
   fronds/*.md, journal        fern, brief, lens       (isolate mode only)
```

## Packages
| Package | Responsibility | May depend on |
| --- | --- | --- |
| core | types, router cascade, assembler, frond model, undo inverses | nothing (pure) |
| store | SQLite schema and migrations, markdown mirror, journal writer | core |
| embed | bundled ONNX embedder, Ollama and provider fallbacks | core |
| daemon | HTTP API for hooks and UI, proxy for isolate mode, static UI serving | core, store, embed |
| cli | `fern` commands, terminal fern renderer, installer helpers | core, store, daemon client, embed and daemon (dev-only: `fern route --replay`'s stage0/stage2/always-escalate modes, spec §10, never the daemon's live routing path) |
| plugin-claude-code | hooks, slash commands, statusline, MCP tools, marketplace manifest | daemon client |
| ui | React app: fern graph, brief editor, context lens, journal | daemon HTTP API |

## Daemon HTTP API (127.0.0.1 only, port 7420 falling back to a free one, random token + random port written to `~/.fern/daemon.json`; every request needs the token header and an exact `127.0.0.1`/`localhost` Host, no other Origin)
Shipped (`feat/daemon-cli`):
- `POST /prompt` a human prompt in; a receipt and, if Stage 0 clears the display bar, a pending suggestion out. Only ever applies a forced `continue` itself — recognizes manual commands (`/fern new|switch|stray`, the `? ` prefix) and applies those immediately instead.
- `POST /tools` files touched, buffered against the in-flight exchange
- `POST /exchange-end` finalizes the leaflet (and the forced `continue`) with whatever files arrived via `/tools`
- `POST /undo`, `POST /merge`, `POST /mode`
- `GET /tree`, `GET /status`

Not yet built (isolate mode / UI):
- `GET /frond/:id`, `PUT /frond/:id/brief`
- `GET /journal?since=`, `GET /leaflet/:n/payload` (isolate mode only)
- `POST /v1/messages` Anthropic-compatible proxy (isolate mode only)

## Data flow for one leaflet
1. `UserPromptSubmit` hook posts the prompt to `/prompt`.
2. Router computes Stage 0 signals. A plain prompt's decision is only ever surfaced as a suggestion; the daemon persists a forced `continue` underneath. A manual command (or an accepted suggestion) applies immediately. Stage 2 stays off unless configured — not wired into the live daemon yet.
3. The Decision is recorded (SQLite + `.fern/journal.jsonl`) with its inverse: immediately for a manual command, or for a plain prompt at `/exchange-end` — or defensively at the top of the *next* `/prompt`, whichever arrives first, so a hook that never calls `/exchange-end` can't silently lose it. The fern updates either way.
4. The hook/CLI command prints the receipt (and focus note in suggest mode — see PR 2 for the real user-visible channel vs. what the model sees).
5. In isolate mode, the client's request hits `/v1/messages`; the assembler builds the payload for the active frond; the proxy streams the response back unchanged and records cache token counts.

## Key decisions (see decisions.md)
- Bun single binary over Rust for speed of delivery; revisit if memory or streaming throughput is a measured problem.
- Plugin first, proxy opt-in.
- No graph database; fern in adjacency tables with recursive CTEs.
