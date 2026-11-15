// `context-fern mcp` — runs the MCP stdio server, reached directly from
// packages/plugin-claude-code/.claude-plugin/plugin.json's mcpServers
// entry (no `bun run mcp-server/server.ts` in between; see
// docs/decisions.md's Phase-4 PR 2 entry).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp-server";

export async function runMcp(): Promise<number> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The MCP stdio server is long-lived by design — unlike every other
  // command, this must not reach index.ts's process.exit(code) wrapper
  // right after returning. Caught by index.ts recognizing "mcp" before
  // its own exit-on-resolve dispatch, the same way "hook" needs to run
  // through normally but a future long-lived mode wouldn't.
  return new Promise<number>(() => {});
}
