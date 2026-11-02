// Fallback for commands/fern.md — only reached if the UserPromptSubmit
// block path (src/hook-handlers.ts) didn't intercept "/fern ..." first,
// confirmed to work even without ANY registered command (see
// docs/decisions.md), so this is a rare path (hooks disabled, `claude
// --bare`, or a hook failure). Takes no user-controlled arguments at
// all — commands/fern.md invokes it with the fixed literal "--fallback"
// and nothing else, so there is nothing here for a shell injection to
// even target (see docs/decisions.md for why the earlier
// double-quote-plus-sanitize design still had a residual $(...) gap).

import { CLI_NAME } from "@context-fern/core";
import { isDaemonRunning } from "@context-fern/daemon/client";

async function main(): Promise<void> {
  const info = await isDaemonRunning();
  const daemonStatus = info
    ? `${CLI_NAME} ▸ daemon running on 127.0.0.1:${info.port}`
    : `${CLI_NAME} ▸ daemon not running`;
  console.log(
    `${CLI_NAME} ▸ the ${CLI_NAME} hook didn't run · try again, or run ${CLI_NAME} doctor\n${daemonStatus}`,
  );
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
