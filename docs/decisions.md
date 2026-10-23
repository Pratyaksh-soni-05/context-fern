# Decisions log

One line per non-obvious decision. Newest first. Format: `YYYY-MM-DD · decision · reason · owner`.

- 2026-10-23 · Bun install linker pinned to "hoisted" via bunfig.toml (Bun's new default is "isolated") · @types/bun's transitive `bun-types` dependency isn't resolvable by tsc under the isolated linker's nested node_modules layout · Pratyaksh
- 2026-10-23 · Each package's tsconfig includes only `src`, not `test`; tests are type-erased by `bun test` but not checked by `tsc -b` · including `test` in the composite build emitted compiled test files into `dist/`, which `bun test packages` then picked up as duplicates alongside the source `.test.ts` files · Pratyaksh
- 2026-10-23 · Biome's Markdown formatter/linter disabled via an override for `**/*.md` · default-on Markdown formatting would rewrite existing hand-formatted docs (CLAUDE.md, CODE_OF_CONDUCT.md) on every lint run · Pratyaksh
- 2026-10-23 · Solo build; name is a placeholder held in packages/core/src/brand.ts · rename later without a code sweep · Pratyaksh
- 2026-10-23 · Router thresholds set from ReplayBench data, never hand-tuned in code · avoid untested defaults · Pratyaksh
- 2026-10-23 · Apache-2.0 + DCO, license will not change · trust and enterprise adoption · Pratyaksh
- 2026-10-23 · Claude Code plugin is the front door; isolate proxy is opt-in · proxies drew trust and cache backlash · Pratyaksh
- 2026-10-23 · TypeScript on Bun, single compiled binary · one language with hooks and MCP SDK, fastest for one person with Claude Code · Pratyaksh
- 2026-10-23 · SQLite + sqlite-vec + FTS5, no graph DB · zero config, tree fits adjacency tables · Pratyaksh
