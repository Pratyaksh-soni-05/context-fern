// `context-fern uninstall`: see install/uninstall.ts for the rules.
//
//   uninstall [--dry-run] [--yes] [--keep-plugin] [--keep-path] [--json]
//
// Exit codes: 0 done (or nothing to do), 1 something was left alone, could not
// be removed, or the manifest could not be used, 2 not confirmed.

import { realUninstallDeps, runUninstall } from "../install/uninstall";

export async function runUninstallCommand(
  flags: Record<string, string>,
): Promise<number> {
  const report = await runUninstall(flags, realUninstallDeps());
  if (flags.json === "true") console.log(JSON.stringify(report));
  return report.exitCode;
}
