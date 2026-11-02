// The MCP server as a real subprocess, speaking real MCP protocol via
// the SDK's own client (not calling createServer()'s handlers
// in-process) — proving stdio framing, tool registration, and the
// server's own daemon-client calls all work across a process boundary.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllProjects,
  type DaemonHandle,
  getOrOpenProject,
  startDaemon,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";
import { writeBriefSections } from "@context-fern/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;
let projectDir: string;
let client: Client | undefined;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });

  const base = join(tmpdir(), `fern mcp test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
  await mkdir(join(projectDir, ".fern"), { recursive: true });

  const state = await getOrOpenProject(projectDir);
  const frond = await state.store.createFrond({
    sessionId: state.sessionId,
    parentId: state.stemFrondId,
    name: "docker-build",
    colorIndex: 1,
    centroid: null,
  });
  await writeBriefSections(frond.briefPath, {
    Goal: "Get CI green again.",
    Open: "Flaky runner on windows-latest.",
  });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await daemon?.stop();
  daemon = undefined;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  await closeAllProjects();
});

async function connectedClient(): Promise<Client> {
  const entrypoint = join(import.meta.dir, "../mcp-server/server.ts");
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", entrypoint],
    cwd: projectDir,
    env: { ...process.env, FERN_HOME: fakeHome },
  });
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(transport);
  return c;
}

test("lists all three tools", async () => {
  client = await connectedClient();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "frond_list",
    "frond_recall",
    "frond_search",
  ]);
}, 15_000);

test("frond_list returns the real frond created in this project", async () => {
  client = await connectedClient();
  const result = await client.callTool({ name: "frond_list", arguments: {} });
  const content = result.content as { type: string; text: string }[];
  const fronds = JSON.parse(content[0]?.text ?? "[]") as { name: string }[];
  expect(fronds.map((f) => f.name)).toContain("docker-build");
}, 15_000);

test("frond_search finds a substring match in the frond's brief", async () => {
  client = await connectedClient();
  const result = await client.callTool({
    name: "frond_search",
    arguments: { query: "windows-latest" },
  });
  const content = result.content as { type: string; text: string }[];
  const results = JSON.parse(content[0]?.text ?? "[]") as {
    name: string;
    section: string;
    snippet: string;
  }[];
  expect(results).toEqual([
    { name: "docker-build", section: "Open", snippet: expect.any(String) },
  ]);
}, 15_000);

test("frond_recall returns the named frond's full brief", async () => {
  client = await connectedClient();
  const result = await client.callTool({
    name: "frond_recall",
    arguments: { name: "docker-build" },
  });
  const content = result.content as { type: string; text: string }[];
  const brief = JSON.parse(content[0]?.text ?? "{}") as { goal: string };
  expect(brief.goal).toBe("Get CI green again.");
}, 15_000);

test("frond_recall returns an error result for an unknown frond name", async () => {
  client = await connectedClient();
  const result = await client.callTool({
    name: "frond_recall",
    arguments: { name: "no-such-frond" },
  });
  expect(result.isError).toBe(true);
}, 15_000);

test("frond_recall and frond_search both return an error result in observe mode — the model must not pull brief content through an MCP tool when observe mode says no change to model input", async () => {
  const state = await getOrOpenProject(projectDir);
  await state.store.setMode(state.sessionId, "observe");
  state.mode = "observe"; // mirrors what handleMode (handlers.ts) does — ProjectState caches mode outside the store row

  client = await connectedClient();

  const recall = await client.callTool({
    name: "frond_recall",
    arguments: { name: "docker-build" },
  });
  expect(recall.isError).toBe(true);

  const search = await client.callTool({
    name: "frond_search",
    arguments: { query: "windows-latest" },
  });
  expect(search.isError).toBe(true);
}, 15_000);
