// Registers the Claude Code plugin through the user's own `claude` CLI,
// or prints the exact manual steps when `claude` is not on PATH or a step
// fails. Nothing here edits Claude's settings files directly.
//
// The marketplace source names the GitHub account today (REPO_OWNER);
// that is the one place an install step still does, until the repo moves
// to an organisation or a domain exists (docs/decisions.md 2026-11-10).
//
// The source is pinned to this binary's release tag, "v" + CLI_VERSION,
// so the hooks Claude Code runs on every prompt are the ones released with
// this binary, not whatever is on the repository's default git branch.
// `claude plugin marketplace add owner/repo#ref` clones that ref (a tag or a
// git branch name). A build whose tag does not exist on GitHub (a build made
// before its release) fails that add, and init then prints the manual
// commands with the same pinned source (docs/decisions.md 2026-11-24).

import { execFile } from "node:child_process";
import { CLI_NAME, CLI_VERSION, REPO_OWNER } from "@context-fern/core";
import type { PluginRecord } from "./manifest";

export const MARKETPLACE_NAME = "context-fern";
export const PLUGIN_NAME = "fern";
export const MARKETPLACE_REF = `v${CLI_VERSION}`;
export const MARKETPLACE_SOURCE = `${REPO_OWNER}/context-fern#${MARKETPLACE_REF}`;

export interface CommandResult {
  ok: boolean;
  output: string;
}
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

/** Runs a command with no shell, killing it after `timeoutMs`. */
export const makeRunner =
  (timeoutMs: number): CommandRunner =>
  (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) =>
          resolve({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
      );
    });

export const defaultRunner: CommandRunner = makeRunner(120_000);

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
  let addedByInit: boolean | undefined;
  const manual = (
    reason: string,
    marketplaceAdded = false,
  ): PluginSetupResult => ({
    state: "manual",
    reason,
    steps: manualPluginSteps(),
    record: marketplaceAdded
      ? {
          method: "manual",
          marketplace: MARKETPLACE_NAME,
          ...(addedByInit === undefined
            ? {}
            : { marketplaceAddedByInit: addedByInit }),
        }
      : { method: "manual" },
  });
  if (claudePath === null) {
    return manual("the claude command is not on PATH");
  }
  // Was it configured before we add it? `add` is idempotent, so afterwards
  // nothing could tell, and uninstall must not remove a marketplace the
  // user already had (on a developer machine it is often a local directory).
  const existedBefore = await marketplaceExists(claudePath, run);
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
  addedByInit = existedBefore === undefined ? undefined : !existedBefore;
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
      ...(addedByInit === undefined
        ? {}
        : { marketplaceAddedByInit: addedByInit }),
    },
  };
}

/** true/false from `claude plugin marketplace list --json`, or undefined when that could not be read. */
async function marketplaceExists(
  claudePath: string,
  run: CommandRunner,
): Promise<boolean | undefined> {
  const r = await run(claudePath, ["plugin", "marketplace", "list", "--json"]);
  if (!r.ok) return undefined;
  try {
    const list = JSON.parse(r.output.slice(r.output.indexOf("["))) as {
      name?: unknown;
    }[];
    if (!Array.isArray(list)) return undefined;
    return list.some((m) => m.name === MARKETPLACE_NAME);
  } catch {
    return undefined;
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 160);
}

export const PLUGIN_MANUAL_HINT = `run these two commands yourself, then restart Claude Code, to finish with the ${CLI_NAME} plugin`;
