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
| cli | `fern` commands, terminal fern renderer, installer helpers | core, store, daemon client, embed (dev-only: `fern route --replay`, spec §10, never the daemon's live routing path) |
| plugin-claude-code | hooks, slash commands, statusline, MCP tools, marketplace manifest | daemon client |
| ui | React app: fern graph, brief editor, context lens, journal | daemon HTTP API |

## Daemon HTTP API (localhost only, random port written to `~/.fern/daemon.json`)
- `POST /route` leaflet in, decision out
- `POST /tools` files touched
- `POST /undo`, `POST /merge`, `POST /mode`
- `GET /fern`, `GET /frond/:id`, `PUT /frond/:id/brief`
- `GET /journal?since=`, `GET /leaflet/:n/payload` (isolate mode only)
- `POST /v1/messages` Anthropic-compatible proxy (isolate mode only)

## Data flow for one leaflet
1. UserPromptSubmit hook posts the prompt to `/route`.
2. Router computes Stage 0 signals; escalates to Stage 2 only if uncertain.
3. Decision is recorded in the journal with its inverse; the fern updates.
4. Hook returns a receipt (and focus note in suggest mode).
5. In isolate mode, the client's request hits `/v1/messages`; the assembler builds the payload for the active frond; the proxy streams the response back unchanged and records cache token counts.

## Key decisions (see decisions.md)
- Bun single binary over Rust for speed of delivery; revisit if memory or streaming throughput is a measured problem.
- Plugin first, proxy opt-in.
- No graph database; fern in adjacency tables with recursive CTEs.
