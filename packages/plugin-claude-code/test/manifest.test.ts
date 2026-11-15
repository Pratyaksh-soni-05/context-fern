// Sanity checks on the plugin manifest, hooks config, and the
// repo-root marketplace file — not a substitute for `claude plugin
// validate` (not assumed available in CI), but enough to catch a typo
// in a referenced script path or a malformed JSON file before it ships.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_BINARY_NAME, CLI_VERSION } from "@context-fern/core";

const PLUGIN_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "../..");
const CLI_SRC = join(REPO_ROOT, "packages/cli/src");

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

test("plugin.json is valid JSON, names the plugin 'fern', its mcpServers runs the unambiguous binary, and its declared version matches CLI_VERSION", async () => {
  const text = await Bun.file(
    join(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
  ).text();
  const manifest = JSON.parse(text) as {
    name: string;
    version: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  expect(manifest.name).toBe("fern");
  expect(manifest.mcpServers.fern).toEqual({
    command: CLI_BINARY_NAME,
    args: ["mcp"],
  });
  // Not just a style check: this is the exact comparison
  // packages/cli/src/commands/hook.ts makes at runtime to print the
  // "plugin and binary versions differ" receipt — a mismatch here means
  // every real hook invocation would show that receipt unconditionally.
  expect(manifest.version).toBe(CLI_VERSION);
});

test("hooks.json declares all four events with a 5s timeout, running the unambiguous binary's hook subcommand", async () => {
  const text = await Bun.file(join(PLUGIN_ROOT, "hooks/hooks.json")).text();
  const config = JSON.parse(text) as HooksConfig;

  const events = ["UserPromptSubmit", "PostToolUse", "Stop", "SessionStart"];
  for (const event of events) {
    const groups = config.hooks[event];
    expect(groups).toBeTruthy();
    for (const group of groups ?? []) {
      for (const hook of group.hooks) {
        expect(hook.timeout).toBe(5);
        expect(hook.command).toBe(CLI_BINARY_NAME);
        expect(hook.args).toEqual(["hook", event]);
      }
    }
  }
});

test("commands/fern.md exists, disables model-invocation, and its shell call is the fixed, argument-free fern-fallback subcommand", async () => {
  const text = await Bun.file(join(PLUGIN_ROOT, "commands/fern.md")).text();
  expect(text).toContain("disable-model-invocation: true");

  const match = /!`([^`]+)`/.exec(text);
  expect(match).toBeTruthy();
  expect(match?.[1]).toBe(`${CLI_BINARY_NAME} fern-fallback`);
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

test("no personal name in any manifest or package author field, or the LICENSE copyright line", async () => {
  const read = async (path: string) => Bun.file(join(REPO_ROOT, path)).text();

  const marketplace = JSON.parse(
    await read(".claude-plugin/marketplace.json"),
  ) as { owner: { name: string } };
  expect(marketplace.owner.name).toBe("Context Fern");

  const plugin = JSON.parse(
    await read("packages/plugin-claude-code/.claude-plugin/plugin.json"),
  ) as { author: { name: string } };
  expect(plugin.author.name).toBe("Context Fern contributors");

  const packageJsons = [
    "package.json",
    "e2e/package.json",
    ...[
      "cli",
      "core",
      "daemon",
      "embed",
      "plugin-claude-code",
      "store",
      "ui",
    ].map((p) => `packages/${p}/package.json`),
  ];
  for (const path of packageJsons) {
    const pkg = JSON.parse(await read(path)) as { author?: string };
    expect(pkg.author, path).toBe("Context Fern contributors");
  }

  expect(await read("LICENSE")).toContain(
    "Copyright 2026 Context Fern contributors",
  );
});

test("every CLI subcommand the manifests invoke, and the one script Claude Code plugins can't ship themselves, exists on disk", () => {
  const cliFiles = [
    "commands/hook.ts",
    "commands/mcp.ts",
    "commands/fern-fallback.ts",
    "mcp-server.ts",
  ];
  for (const file of cliFiles) {
    expect(existsSync(join(CLI_SRC, file))).toBe(true);
  }
  expect(existsSync(join(PLUGIN_ROOT, "scripts/statusline.ts"))).toBe(true);
});
