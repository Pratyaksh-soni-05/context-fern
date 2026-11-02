// Not shippable as a plugin-provided statusline — Claude Code plugins
// can't register one (confirmed against the docs, see decisions.md).
// This script is what `fern statusline --install` wires into the user's
// own ~/.claude/settings.json "statusLine" command.

import { dirname } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import {
  findFernDir,
  isDaemonRunning,
  rawGetJson,
} from "@context-fern/daemon/client";

const TIMEOUT_MS = 300;
const OFF = `${CLI_NAME} ▸ off`;

// Claude Code's statusLine protocol sends JSON session data on stdin
// (same shape family as hooks') and renders whatever this script
// prints to stdout verbatim — confirmed against the current docs, see
// docs/decisions.md. This script previously never read stdin at all
// and relied on process.cwd() instead; reading it (with a graceful
// fallback to process.cwd() if it's empty, unparseable, or missing a
// usable cwd — e.g. when run manually for testing) is the documented,
// spec-conformant behavior, and the safer source of truth if Claude
// Code's statusline child process cwd ever differs from the cwd it
// reports in that payload.
async function resolveCwd(): Promise<string> {
  // A TTY (no piped input — e.g. run manually from a terminal for
  // testing) never sends anything and never closes stdin on its own;
  // reading it would hang waiting for input that's never coming.
  if (process.stdin.isTTY) return process.cwd();
  try {
    const text = await Bun.stdin.text();
    const data = JSON.parse(text) as { cwd?: unknown };
    if (typeof data.cwd === "string" && data.cwd.length > 0) return data.cwd;
  } catch {
    // empty stdin or not JSON — fall back below
  }
  return process.cwd();
}

async function main(): Promise<void> {
  const fernDir = findFernDir(await resolveCwd());
  if (!fernDir) {
    console.log(OFF);
    return;
  }
  const projectPath = dirname(fernDir);

  const info = await isDaemonRunning(AbortSignal.timeout(TIMEOUT_MS));
  if (!info) {
    console.log(OFF);
    return;
  }

  try {
    const result = await rawGetJson(
      info,
      `/status?projectPath=${encodeURIComponent(projectPath)}`,
      AbortSignal.timeout(TIMEOUT_MS),
    );
    console.log(typeof result.receipt === "string" ? result.receipt : OFF);
  } catch {
    console.log(OFF);
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
