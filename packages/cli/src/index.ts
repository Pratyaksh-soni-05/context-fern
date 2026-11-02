import { CLI_NAME } from "@context-fern/core";
import { parseArgs } from "./argv";
import { runDaemon } from "./commands/daemon";
import { runDoctor } from "./commands/doctor";
import {
  runMerge,
  runMode,
  runNew,
  runStray,
  runSwitch,
  runUndo,
} from "./commands/frond";
import { runInit } from "./commands/init";
import { runRoute } from "./commands/route";
import { runStatus } from "./commands/status";
import { runStatusline } from "./commands/statusline";
import { runTree } from "./commands/tree";

export { parseArgs } from "./argv";
export { loadConfig } from "./load-config";
export { type ReplayTurnInput, type ReplayTurnOutput, replay } from "./replay";

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case "route":
        await runRoute(flags);
        return 0;
      case "init":
        await runInit(flags);
        return 0;
      case "daemon":
        await runDaemon(positional[0]);
        return 0;
      case "status":
        await runStatus(flags);
        return 0;
      case "tree":
        await runTree();
        return 0;
      case "new":
        await runNew(positional[0]);
        return 0;
      case "switch":
        await runSwitch(positional[0]);
        return 0;
      case "stray":
        await runStray();
        return 0;
      case "undo":
        await runUndo();
        return 0;
      case "merge":
        await runMerge(positional[0]);
        return 0;
      case "mode":
        await runMode(positional[0]);
        return 0;
      case "doctor":
        await runDoctor();
        return 0;
      case "statusline":
        await runStatusline(flags);
        return 0;
      default:
        console.error(`${CLI_NAME}: unknown command "${command}"`);
        return 1;
    }
  } catch (err) {
    console.error(
      `${CLI_NAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
