// Sanity checks on the plugin manifest, hooks config, and the
// repo-root marketplace file — not a substitute for `claude plugin
// validate` (not assumed available in CI), but enough to catch a typo
// in a referenced script path or a malformed JSON file before it ships.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "../..");
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder to search for, not a template literal.
const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

interface HooksConfig {
  hooks: Record<
    string,
    {
      matcher: string;
      hooks: {
        type: string;
        command: string;
        args: string[];
        timeout: number;
      }[];
    }[]
  >;
}

test("plugin.json is valid JSON, names the plugin 'fern', and its mcpServers command points at a real file", async () => {
  const text = await Bun.file(
    join(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
  ).text();
  const manifest = JSON.parse(text) as {
    name: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  expect(manifest.name).toBe("fern");

  const mcpArgs = manifest.mcpServers.fern?.args ?? [];
  const scriptArg = mcpArgs.find((a) => a.includes(PLUGIN_ROOT_PLACEHOLDER));
  const scriptPath = scriptArg?.replace(PLUGIN_ROOT_PLACEHOLDER, PLUGIN_ROOT);
  expect(scriptPath && existsSync(scriptPath)).toBe(true);
});

test("hooks.json declares all four events with a 5s timeout and each command path exists", async () => {
  const text = await Bun.file(join(PLUGIN_ROOT, "hooks/hooks.json")).text();
  const config = JSON.parse(text) as HooksConfig;

  const events = ["UserPromptSubmit", "PostToolUse", "Stop", "SessionStart"];
  for (const event of events) {
    const groups = config.hooks[event];
    expect(groups).toBeTruthy();
    for (const group of groups ?? []) {
      for (const hook of group.hooks) {
        expect(hook.timeout).toBe(5);
        const scriptArg = hook.args.find((a) =>
          a.includes(PLUGIN_ROOT_PLACEHOLDER),
        );
        const scriptPath = scriptArg?.replace(
          PLUGIN_ROOT_PLACEHOLDER,
          PLUGIN_ROOT,
        );
        expect(scriptPath && existsSync(scriptPath)).toBe(true);
      }
    }
  }
});

test("commands/fern.md exists, disables model-invocation, and its shell call names the fallback dispatch script", async () => {
  const text = await Bun.file(join(PLUGIN_ROOT, "commands/fern.md")).text();
  expect(text).toContain("disable-model-invocation: true");

  const match = /!`([^`]+)`/.exec(text);
  expect(match).toBeTruthy();
  const shellLine = match?.[1] ?? "";
  expect(shellLine).toContain(PLUGIN_ROOT_PLACEHOLDER);
  expect(shellLine).toContain("scripts/fern-command.ts");
  expect(existsSync(join(PLUGIN_ROOT, "scripts/fern-command.ts"))).toBe(true);
});

test("repo-root marketplace.json names the 'fern' plugin and its relative source directory exists", async () => {
  const text = await Bun.file(
    join(REPO_ROOT, ".claude-plugin/marketplace.json"),
  ).text();
  const marketplace = JSON.parse(text) as {
    name: string;
    owner: { name: string };
    plugins: { name: string; source: string }[];
  };
  expect(marketplace.name).toBe("context-fern");
  expect(marketplace.owner.name.length).toBeGreaterThan(0);

  const fern = marketplace.plugins.find((p) => p.name === "fern");
  expect(fern?.source.startsWith("./")).toBe(true);
  const sourceDir = join(REPO_ROOT, fern?.source ?? "");
  expect(existsSync(join(sourceDir, ".claude-plugin", "plugin.json"))).toBe(
    true,
  );
});

test("every hook script and the MCP server referenced by the manifests exists under scripts/ or mcp-server/", () => {
  const files = [
    "scripts/user-prompt-submit.ts",
    "scripts/post-tool-use.ts",
    "scripts/stop.ts",
    "scripts/session-start.ts",
    "scripts/fern-command.ts",
    "scripts/statusline.ts",
    "mcp-server/server.ts",
  ];
  for (const file of files) {
    expect(existsSync(join(PLUGIN_ROOT, file))).toBe(true);
  }
});
