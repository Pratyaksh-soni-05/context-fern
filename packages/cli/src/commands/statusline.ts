// `fern statusline --install` — Claude Code plugins can't ship a
// statusline themselves (confirmed against the docs; see
// docs/decisions.md), so this writes the snippet into the user's OWN
// ~/.claude/settings.json instead. Never overwrites an existing
// statusLine entry — prints the snippet and exits instead of touching
// the file.
//
// `homeDir` defaults to `FERN_HOME` (packages/daemon's own env-var
// convention) and only then the real `os.homedir()` — not just the
// real home dir with an overridable parameter. `os.homedir()` alone
// isn't safe to rely on for test isolation: verified on CI that Bun's
// `homedir()` doesn't reliably reflect a same-process env override on
// Linux the way it does on Windows, so checking a plain env var first
// (a normal JS read, not a native call) is what actually makes
// test/preload.ts's redirection effective here — see docs/decisions.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_NAME, ENV_PREFIX } from "@context-fern/core";

function defaultHomeDir(): string {
  return process.env[`${ENV_PREFIX}HOME`] || homedir();
}

function statuslineScriptPath(): string {
  // packages/cli/src/commands/statusline.ts -> packages/plugin-claude-code/scripts/statusline.ts.
  // Monorepo-relative, same limitation as serve-entrypoint.ts's path —
  // no packaged distribution exists yet to resolve against instead.
  return join(
    import.meta.dir,
    "../../../plugin-claude-code/scripts/statusline.ts",
  );
}

function settingsPath(homeDir: string): string {
  return join(homeDir, ".claude", "settings.json");
}

function statuslineCommand(): string {
  return `bun run "${statuslineScriptPath()}"`;
}

export function statuslineSnippet(): string {
  return JSON.stringify(
    { statusLine: { type: "command", command: statuslineCommand() } },
    null,
    2,
  );
}

async function readSettings(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runStatusline(
  flags: Record<string, string>,
  homeDir: string = defaultHomeDir(),
): Promise<void> {
  if (flags.install !== "true") {
    console.error(`usage: ${CLI_NAME} statusline --install`);
    return;
  }

  const path = settingsPath(homeDir);
  const existing = await readSettings(path);

  if (existing && "statusLine" in existing) {
    console.log(
      [
        `${CLI_NAME} ▸ ~/.claude/settings.json already has a statusLine — left untouched.`,
        "Add this yourself if you want fern's:",
        statuslineSnippet(),
      ].join("\n"),
    );
    return;
  }

  if (existing) {
    const backupPath = `${path}.${Date.now()}.bak`;
    await writeFile(backupPath, JSON.stringify(existing, null, 2), "utf-8");
    console.log(
      `${CLI_NAME} ▸ backed up ~/.claude/settings.json to ${backupPath}`,
    );
  }

  const next = {
    ...(existing ?? {}),
    statusLine: { type: "command", command: statuslineCommand() },
  };
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  console.log(`${CLI_NAME} ▸ added statusLine to ~/.claude/settings.json`);
}
