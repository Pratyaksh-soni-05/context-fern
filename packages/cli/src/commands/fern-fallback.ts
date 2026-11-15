// `context-fern fern-fallback` — the commands/fern.md fallback, only
// reached if the UserPromptSubmit block path (hooks/hook-handlers.ts)
// didn't intercept "/fern ..." first (hooks disabled, `claude --bare`,
// or a hook failure). Takes no arguments on purpose — see
// commands/fern.md's own comment on why $ARGUMENTS was removed rather
// than hardened against shell injection.

import { CLI_BINARY_NAME, CLI_NAME } from "@context-fern/core";
import { isDaemonRunning } from "@context-fern/daemon/client";

export async function runFernFallback(): Promise<number> {
  const info = await isDaemonRunning();
  const daemonStatus = info
    ? `${CLI_NAME} ▸ daemon running on 127.0.0.1:${info.port}`
    : `${CLI_NAME} ▸ daemon not running`;
  console.log(
    `${CLI_NAME} ▸ the ${CLI_NAME} hook didn't run · try again, or run ${CLI_BINARY_NAME} doctor\n${daemonStatus}`,
  );
  return 0;
}
