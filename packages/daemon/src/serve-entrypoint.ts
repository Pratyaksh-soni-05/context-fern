// The only place startDaemon() runs automatically — `bun run` this file
// directly (the CLI spawns it detached). Importing @context-fern/daemon
// as a library (e.g. packages/cli's Stage 2 client code) must never
// start a server as a side effect.

import { CLI_NAME } from "@context-fern/core";
import { startDaemon } from "./server";

if (import.meta.main) {
  const handle = await startDaemon();
  console.log(`${CLI_NAME} daemon listening on 127.0.0.1:${handle.port}`);
}
