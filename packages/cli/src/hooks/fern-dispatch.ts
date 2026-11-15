// The /fern command dispatch — shared by two callers: the UserPromptSubmit
// hook's zero-model-turn intercept (hooks/hook-handlers.ts) and the
// commands/fern.md fallback (commands/fern-fallback.ts). Both need the
// exact same subcommand behaviour, so it lives here once. Moved here
// from packages/plugin-claude-code (see docs/decisions.md) now that
// `context-fern hook <event>` is a CLI subcommand, not a separate
// bun-run script — this file's own "init" dependency is now a same-
// package import, not the cross-package "@context-fern/cli/init"
// subpath it used to need.
//
// "init" needs the real init logic, which might look like it breaks the
// hooks' lightweight-import rule — but that import (the local
// ../commands/init module, not a package-crossing one) only touches
// fs/core/local cli helpers, never store/embed, so this file's own
// import graph stays clean. test/hooks/import-graph.test.ts verifies
// this transitively, since hook.ts's dispatch imports this file for the
// zero-turn "/fern" block path.

import { CLI_NAME } from "@context-fern/core";
import {
  type DaemonInfo,
  ensureDaemonRunning,
  isDaemonRunning,
  rawGetJson,
  rawPostJson,
} from "@context-fern/daemon/client";
import { runInit } from "../commands/init";

export interface DispatchOptions {
  projectPath: string;
  /** Everything after "/fern ", split on whitespace — e.g. ["new", "docker-build"]. */
  rest: string[];
  /** The zero-turn hook path and the fallback command script both wait for a down daemon (the user typed an explicit command and expects an answer); only the passive per-turn hooks never do. */
  ensureDaemon: boolean;
  /** Threaded through to /prompt so a "/fern new|switch|stray" that happens to be the first command after a resume/clear/compaction/fork still gets a restored receipt prepended, same as a plain prompt would. */
  agentSessionId?: string;
}

async function daemonInfoOrThrow(ensureDaemon: boolean): Promise<DaemonInfo> {
  if (ensureDaemon) return ensureDaemonRunning();
  const info = await isDaemonRunning();
  if (!info) throw new Error(`${CLI_NAME} daemon isn't running.`);
  return info;
}

function usage(): string {
  return `${CLI_NAME} ▸ usage: /${CLI_NAME} <status|new|switch|stray|undo|merge|mode|init|ui>`;
}

async function dispatchInit(projectPath: string): Promise<string> {
  const originalCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    process.chdir(projectPath);
    // No interactive terminal here (zero-model-turn hook path or the
    // commands/fern.md fallback) — auto-confirm the local .gitignore
    // edit, matching --yes, but never the statusline offer: that one
    // writes to ~/.claude/settings.json, outside the project, and must
    // not happen without a real user answering a real prompt. See
    // docs/decisions.md.
    await runInit({ yes: "true", statusline: "no" });
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
  }
  return logs.join("\n");
}

/**
 * Runs one /fern subcommand and returns the text to show the user (a
 * receipt, or an error/usage message). Never throws for a recognized
 * subcommand whose daemon call fails — the caller decides how to
 * surface that as the command's own "result" (still zero model turns).
 */
export async function dispatchFernCommand(
  options: DispatchOptions,
): Promise<string> {
  const { projectPath, rest, ensureDaemon, agentSessionId } = options;
  const [subcommand, ...args] = rest;

  if (!subcommand) return usage();

  if (subcommand === "init") {
    return dispatchInit(projectPath);
  }

  if (subcommand === "ui") {
    return `${CLI_NAME} ▸ ui: not built yet`;
  }

  // Not a real dispatch target — the active frond's brief path is
  // always in the model's context (prompt-handler.ts's focusNote), so
  // the plain-English phrasing already works with no slash command at
  // all. A dedicated "/fern brief" that bypasses the UserPromptSubmit
  // block (letting the model edit the brief in a real turn) needs
  // Claude Code's UserPromptExpansion hook to suppress the fallback
  // command's own template, and whether the raw prompt still reaches
  // the model after that hook blocks isn't documented — deferred until
  // that's confirmed interactively. See docs/decisions.md.
  if (subcommand === "brief") {
    return `${CLI_NAME} ▸ to update the brief, ask: "update the ${CLI_NAME} brief"`;
  }

  if (
    subcommand === "new" ||
    subcommand === "switch" ||
    subcommand === "stray"
  ) {
    const info = await daemonInfoOrThrow(ensureDaemon);
    const prompt =
      args.length > 0
        ? `/${CLI_NAME} ${subcommand} ${args.join(" ")}`
        : `/${CLI_NAME} ${subcommand}`;
    const result = await rawPostJson(info, "/prompt", {
      projectPath,
      prompt,
      agentSessionId,
    });
    return typeof result.receipt === "string" ? result.receipt : "";
  }

  if (subcommand === "undo") {
    const info = await daemonInfoOrThrow(ensureDaemon);
    const result = await rawPostJson(info, "/undo", { projectPath });
    return typeof result.receipt === "string" ? result.receipt : "";
  }

  if (subcommand === "merge") {
    const frondName = args[0];
    if (!frondName) return `${CLI_NAME} ▸ usage: /${CLI_NAME} merge <name>`;
    const info = await daemonInfoOrThrow(ensureDaemon);
    const result = await rawPostJson(info, "/merge", {
      projectPath,
      frondName,
    });
    return typeof result.receipt === "string" ? result.receipt : "";
  }

  if (subcommand === "mode") {
    const mode = args[0];
    if (!mode) {
      return `${CLI_NAME} ▸ usage: /${CLI_NAME} mode <observe|suggest|isolate>`;
    }
    const info = await daemonInfoOrThrow(ensureDaemon);
    await rawPostJson(info, "/mode", { projectPath, mode });
    return `${CLI_NAME} ▸ mode ${mode}`;
  }

  if (subcommand === "status") {
    const info = await daemonInfoOrThrow(ensureDaemon);
    const result = await rawGetJson(
      info,
      `/status?projectPath=${encodeURIComponent(projectPath)}`,
    );
    return typeof result.statusReceipt === "string" ? result.statusReceipt : "";
  }

  return usage();
}
