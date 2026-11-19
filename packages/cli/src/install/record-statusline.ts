// `fern init` may add a `statusLine` entry to the user's own
// ~/.claude/settings.json (with their consent). The install manifest records
// exactly what was added, so an uninstall can remove that entry and nothing
// else. With no manifest (a source checkout, nothing installed machine-wide)
// there is nothing to record into and this does nothing.

import { homedir } from "node:os";
import type { StatuslineInstallOutcome } from "../commands/statusline";
import { installLayout } from "./layout";
import { readManifest, writeManifest } from "./manifest";

export async function recordStatusline(
  outcome: StatuslineInstallOutcome | undefined,
  where: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {},
): Promise<boolean> {
  if (outcome?.state !== "added") return false;
  const layout = installLayout({
    platform: where.platform ?? process.platform,
    env: where.env ?? process.env,
    home: where.home ?? homedir(),
  });
  const manifest = await readManifest(layout.manifestPath);
  if (manifest === null) return false;
  await writeManifest(layout.manifestPath, {
    ...manifest,
    statusline: {
      file: outcome.file,
      command: outcome.command,
      backupPath: outcome.backupPath,
    },
  });
  return true;
}
