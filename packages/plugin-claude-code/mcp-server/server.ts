// Three read-only MCP tools backed by the daemon's lightweight client:
// frond_list, frond_search, frond_recall. Uses the SDK's high-level
// McpServer (not the deprecated low-level Server) with zod schemas —
// an earlier version of this file used the low-level Server specifically
// to avoid a zod dependency, but that reasoning didn't hold up: the
// pinned @modelcontextprotocol/sdk unconditionally depends on zod (and
// express, hono, ajv, ...) regardless of which API this file calls, so
// avoiding it bought nothing. zod is pinned directly here since this
// file imports it; see docs/decisions.md.

import { dirname } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import {
  type DaemonInfo,
  findFernDir,
  isDaemonRunning,
  rawGetJson,
} from "@context-fern/daemon/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function notInitialized(): ToolResult {
  return errorResult(
    `${CLI_NAME} ▸ not initialized here — run "${CLI_NAME} init"`,
  );
}

function daemonDown(): ToolResult {
  return errorResult(
    `${CLI_NAME} ▸ daemon not running — run "${CLI_NAME} daemon start"`,
  );
}

function resolveProjectPath(): string | null {
  const fernDir = findFernDir(process.cwd());
  return fernDir ? dirname(fernDir) : null;
}

async function callFrondList(): Promise<ToolResult> {
  const projectPath = resolveProjectPath();
  if (!projectPath) return notInitialized();
  const info: DaemonInfo | null = await isDaemonRunning();
  if (!info) return daemonDown();

  try {
    const result = await rawGetJson(
      info,
      `/fronds?projectPath=${encodeURIComponent(projectPath)}`,
    );
    return textResult(JSON.stringify(result.fronds ?? []));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function callFrondSearch(query: string): Promise<ToolResult> {
  const projectPath = resolveProjectPath();
  if (!projectPath) return notInitialized();
  const info = await isDaemonRunning();
  if (!info) return daemonDown();

  try {
    const result = await rawGetJson(
      info,
      `/search?projectPath=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(query)}`,
    );
    return textResult(JSON.stringify(result.results ?? []));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function callFrondRecall(name: string): Promise<ToolResult> {
  if (!name)
    return errorResult(`${CLI_NAME} ▸ usage: frond_recall needs a "name"`);
  const projectPath = resolveProjectPath();
  if (!projectPath) return notInitialized();
  const info = await isDaemonRunning();
  if (!info) return daemonDown();

  try {
    const result = await rawGetJson(
      info,
      `/frond/${encodeURIComponent(name)}/brief?projectPath=${encodeURIComponent(projectPath)}`,
    );
    return textResult(JSON.stringify(result));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: CLI_NAME, version: "0.1.0" });

  server.registerTool(
    "frond_list",
    {
      description: `List every frond in the current project's ${CLI_NAME} session, with its status and leaflet count.`,
      inputSchema: {},
    },
    async () => callFrondList(),
  );

  server.registerTool(
    "frond_search",
    {
      description:
        "Search every frond's brief text for a case-insensitive substring match.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => callFrondSearch(query),
  );

  server.registerTool(
    "frond_recall",
    {
      description:
        "Recall a named frond's full brief: Goal, Decided, Open, Files, Notes.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => callFrondRecall(name),
  );

  return server;
}

if (import.meta.main) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
