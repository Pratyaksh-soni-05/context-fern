// The hook handlers, /fern dispatch, and MCP server that used to live
// here moved to packages/cli (see docs/decisions.md's Phase-4 PR 2
// entry) now that `context-fern hook <event>`/`context-fern mcp` are
// real CLI subcommands — this package is now just the thin Claude Code
// manifest/wiring (hooks.json, plugin.json, commands/fern.md) plus the
// one piece Claude Code plugins genuinely can't ship themselves: the
// `fern statusline --install` snippet's target script.
export const PACKAGE_NAME = "plugin-claude-code";
