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

async function main(): Promise<void> {
  const fernDir = findFernDir(process.cwd());
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
