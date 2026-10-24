import { CLI_NAME } from "@context-fern/core";
import { parseArgs } from "./argv";
import { runRoute } from "./commands/route";

export { parseArgs } from "./argv";
export { loadConfig } from "./load-config";
export { type ReplayTurnInput, type ReplayTurnOutput, replay } from "./replay";

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "route") {
    await runRoute(flags);
    return 0;
  }

  console.error(`${CLI_NAME}: unknown command "${command}"`);
  return 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
