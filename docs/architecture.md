# ContextTree architecture

```
 Claude Code ──hooks──┐         Codex / OpenCode (phase 2)      Cursor (MCP, manual)
                      ▼                     ▼                          ▼
 ┌──────────────────────────── ctree daemon (localhost) ───────────────────────────┐
 │ control plane        router cascade            context assembler      journal  │
 │ /ct, statusline  ──▶ S0 cues+files+vectors ──▶ trunk+branch+tail  ──▶  + undo   │
 │ receipts             S2 LLM if unsure          (isolate mode)                    │
 └───────────┬──────────────────────┬───────────────────────────┬──────────────────┘
             ▼                      ▼                           ▼
   store: SQLite+vec+FTS5      ctree ui (web)         model APIs via proxy
   branches/*.md, journal      tree, brief, lens      (isolate mode only)
```

## Packages
| Package | Responsibility | May depend on |
| --- | --- | --- |
| core | types, router cascade, assembler, branch model, undo inverses | nothing (pure) |
| store | SQLite schema and migrations, markdown mirror, journal writer | core |
| embed | bundled ONNX embedder, Ollama and provider fallbacks | core |
| daemon | HTTP API for hooks and UI, proxy for isolate mode, static UI serving | core, store, embed |
| cli | `ctree` commands, terminal tree renderer, installer helpers | core, store, daemon client |
| plugin-claude-code | hooks, slash commands, statusline, MCP tools, marketplace manifest | daemon client |
| ui | React app: tree, brief editor, context lens, journal | daemon HTTP API |

## Daemon HTTP API (localhost only, random port written to `~/.contexttree/daemon.json`)
- `POST /route` turn in, decision out
- `POST /tools` files touched
- `POST /undo`, `POST /merge`, `POST /mode`
- `GET /tree`, `GET /branch/:id`, `PUT /branch/:id/brief`
- `GET /journal?since=`, `GET /turn/:n/payload` (isolate mode only)
- `POST /v1/messages` Anthropic-compatible proxy (isolate mode only)

## Data flow for one turn
1. UserPromptSubmit hook posts the turn to `/route`.
2. Router computes Stage 0 signals; escalates to Stage 2 only if uncertain.
3. Decision is recorded in the journal with its inverse; the tree updates.
4. Hook returns a receipt (and focus note in suggest mode).
5. In isolate mode, the client's request hits `/v1/messages`; the assembler builds the payload for the active branch; the proxy streams the response back unchanged and records cache token counts.

## Key decisions (see decisions.md)
- Bun single binary over Rust for speed of delivery; revisit if memory or streaming throughput is a measured problem.
- Plugin first, proxy opt-in.
- No graph database; tree in adjacency tables with recursive CTEs.
