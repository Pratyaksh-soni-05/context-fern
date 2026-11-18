// Registers the Claude Code plugin through the user's own `claude` CLI,
// or prints the exact manual steps when `claude` is not on PATH or a step
// fails. Nothing here edits Claude's settings files directly.
//
// The marketplace source names the GitHub account today (REPO_OWNER);
// that is the one place an install step still does, until the repo moves
// to an organisation or a domain exists (docs/decisions.md 2026-11-10).

import { execFile } from "node:child_process";
import { CLI_NAME, REPO_OWNER } from "@context-fern/core";
import type { PluginRecord } from "./manifest";

export const MARKETPLACE_NAME = "context-fern";
export const PLUGIN_NAME = "fern";
export const MARKETPLACE_SOURCE = `${REPO_OWNER}/context-fern`;

export interface CommandResult {
  ok: boolean;
  output: string;
}
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) =>
        resolve({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
    );
  });

export function manualPluginSteps(): string[] {
  return [
    `claude plugin marketplace add ${MARKETPLACE_SOURCE}`,
    `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  ];
}

export type PluginSetupResult =
  | { state: "installed"; record: PluginRecord }
  | { state: "manual"; reason: string; steps: string[]; record: PluginRecord };

export async function setUpPlugin(
  claudePath: string | null,
  run: CommandRunner = defaultRunner,
): Promise<PluginSetupResult> {
  const manual = (
    reason: string,
    marketplaceAdded = false,
  ): PluginSetupResult => ({
    state: "manual",
    reason,
    steps: manualPluginSteps(),
    record: marketplaceAdded
      ? { method: "manual", marketplace: MARKETPLACE_NAME }
      : { method: "manual" },
  });
  if (claudePath === null) {
    return manual("the claude command is not on PATH");
  }
  const add = await run(claudePath, [
    "plugin",
    "marketplace",
    "add",
    MARKETPLACE_SOURCE,
  ]);
  if (!add.ok) {
    return manual(
      `adding the marketplace failed (${firstLine(add.output) || "no output"})`,
    );
  }
  const install = await run(claudePath, [
    "plugin",
    "install",
    `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  ]);
  if (!install.ok) {
    return manual(
      `installing the plugin failed (${firstLine(install.output) || "no output"})`,
      true,
    );
  }
  return {
    state: "installed",
    record: {
      method: "claude-cli",
      marketplace: MARKETPLACE_NAME,
      plugin: `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    },
  };
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 160);
}

export const PLUGIN_MANUAL_HINT = `run these two commands yourself, then restart Claude Code, to finish with the ${CLI_NAME} plugin`;
