// `fern ui` — opens the browser at the daemon's /ui, authenticated via
// a 30-second, single-use code (POST /ui-code, using the CLI's own real
// daemon token), never the raw token itself: that stays off the address
// bar, browser history and this process's own argv. See
// docs/decisions.md.

import { dirname } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import { touchRecentProject } from "@context-fern/daemon";
import {
  canonicalizeProjectPath,
  ensureDaemonRunning,
  findFernDir,
  rawPostJson,
  spawnDetached,
} from "@context-fern/daemon/client";
import { openFernStore } from "@context-fern/store";

/** Argv-array spawn, never an interpolated shell string — the URL (which includes the one-time code) can never be read as shell syntax. `cmd /c start "" <url>` needs the empty title argument on Windows or `start` treats the first quoted argument as a window title. Goes through spawnDetached(), not a raw Bun.spawn call, so this survives `runUi()`'s own process exiting right after — see that function's doc comment. */
function defaultOpenBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  spawnDetached(cmd);
}

/** Best-effort: touches the recent-projects registry for the project `cwd` is inside, if any — never creates `.fern/`, never blocks opening the UI on failure. */
async function touchCurrentProjectIfAny(cwd: string): Promise<void> {
  const fernDir = findFernDir(cwd);
  if (!fernDir) return;
  const projectPath = canonicalizeProjectPath(dirname(fernDir));
  try {
    const store = await openFernStore(fernDir);
    try {
      const sessionCount = await store.countSessionsForProjectPath(projectPath);
      await touchRecentProject(
        projectPath,
        projectPath.split(/[\\/]/).pop() || projectPath,
        sessionCount,
      );
    } finally {
      store.close();
    }
  } catch {
    // no fern.db yet, a locked file, or anything else — the Start
    // screen still works without this project pre-populated.
  }
}

export async function runUi(
  openBrowser: (url: string) => void = defaultOpenBrowser,
): Promise<void> {
  await touchCurrentProjectIfAny(process.cwd());

  const info = await ensureDaemonRunning();
  const { code } = (await rawPostJson(info, "/ui-code", {})) as {
    code: string;
  };
  const url = `http://127.0.0.1:${info.port}/ui#code=${code}`;

  openBrowser(url);
  console.log(
    `${CLI_NAME} ▸ opening ${CLI_NAME} ui at http://127.0.0.1:${info.port}/ui`,
  );
}
