// `context-fern statusline` — Claude Code plugins can't ship a statusline
// themselves (confirmed against the docs; see docs/decisions.md), so
// `fern statusline --install` writes a command into the user's OWN
// ~/.claude/settings.json, and Claude Code then runs that command on every
// refresh and prints whatever it writes. Never overwrites an existing
// statusLine entry — prints the snippet and exits instead.
//
// The command is `context-fern statusline` for a shipped binary (no Bun, no
// repository path). From a source checkout it is still the script in
// packages/plugin-claude-code, as before. The same command with no flag
// renders the line, so one implementation serves both.
//
// `homeDir` defaults to `FERN_HOME` (packages/daemon's own env-var
// convention) and only then the real `os.homedir()`: `os.homedir()` alone
// isn't safe for test isolation (docs/decisions.md, 2026-10-27).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLI_BINARY_NAME,
  CLI_NAME,
  ENV_PREFIX,
  isShippedExecutable,
} from "@context-fern/core";
import {
  findFernDir,
  isDaemonRunning,
  rawGetJson,
} from "@context-fern/daemon/client";

function defaultHomeDir(): string {
  return process.env[`${ENV_PREFIX}HOME`] || homedir();
}

/** What a shipped install writes into settings.json. */
export const STATUSLINE_COMMAND = `${CLI_BINARY_NAME} statusline`;

function statuslineScriptPath(): string {
  // packages/cli/src/commands/statusline.ts -> packages/plugin-claude-code/scripts/statusline.ts.
  // Source checkouts only: a compiled binary has no such path.
  return join(
    import.meta.dir,
    "../../../plugin-claude-code/scripts/statusline.ts",
  );
}

export function statuslineCommand(execPath: string = process.execPath): string {
  return isShippedExecutable(execPath)
    ? STATUSLINE_COMMAND
    : `bun run "${statuslineScriptPath()}"`;
}

export type StatuslineCommandKind = "current" | "legacy-bun" | "other";

/**
 * What an existing settings.json `statusLine.command` is: the command a
 * shipped install writes, the one old command earlier versions wrote (`bun run`
 * with the script's path inside a repository checkout, quoted), or something
 * that is not provably ours. Uninstall removes only the recorded command or
 * the old one; "current" alone is not enough to remove an entry.
 */
export function classifyStatuslineCommand(
  command: unknown,
): StatuslineCommandKind {
  if (typeof command !== "string") return "other";
  const c = command.trim();
  // A path prefix may be there, but nothing that makes it more than a path: no
  // whitespace, quotes, `$`, backticks, `;`, `&`, `|`, `<`, `>` or parentheses
  // outside a quoted path, so `echo hi; /x/context-fern statusline` or
  // `FOO=1 context-fern statusline` is the user's own command, not fern's.
  const PLAIN = "[^\\s\"'`$&|;<>()]";
  const QUOTED = '[^"$`]';
  const current = [
    new RegExp(
      `^(?:${PLAIN}*[\\\\/])?${CLI_BINARY_NAME}(?:\\.exe)? statusline$`,
    ),
    new RegExp(
      `^"(?:${QUOTED}*[\\\\/])?${CLI_BINARY_NAME}(?:\\.exe)?" statusline$`,
    ),
  ];
  if (current.some((re) => re.test(c))) return "current";
  // The one old string: git history shows `bun run "<path>"`, quoted, was the
  // only form ever written. An unquoted variant was never written by fern.
  const legacy = new RegExp(
    `^bun run "${QUOTED}*plugin-claude-code[\\\\/]scripts[\\\\/]statusline\\.ts"$`,
  );
  if (legacy.test(c)) return "legacy-bun";
  return "other";
}

export function settingsPath(homeDir: string): string {
  return join(homeDir, ".claude", "settings.json");
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

export type StatuslineInstallOutcome =
  | {
      state: "added";
      file: string;
      command: string;
      /** The copy of the previous settings.json made first, or null when there was none. */
      backupPath: string | null;
    }
  | { state: "already-present" };

export async function installStatusline(
  homeDir: string = defaultHomeDir(),
): Promise<StatuslineInstallOutcome> {
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
    return { state: "already-present" };
  }

  let backupPath: string | null = null;
  if (existing) {
    backupPath = `${path}.${Date.now()}.bak`;
    await writeFile(backupPath, JSON.stringify(existing, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
    console.log(
      `${CLI_NAME} ▸ backed up ~/.claude/settings.json to ${backupPath}`,
    );
  }

  const command = statuslineCommand();
  const next = {
    ...(existing ?? {}),
    statusLine: { type: "command", command },
  };
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  console.log(`${CLI_NAME} ▸ added statusLine to ~/.claude/settings.json`);
  return { state: "added", file: path, command, backupPath };
}

const TIMEOUT_MS = 300;
const OFF = `${CLI_NAME} ▸ off`;

// Claude Code's statusLine protocol sends JSON session data on stdin and
// renders whatever this prints to stdout verbatim (confirmed against the
// docs, docs/decisions.md). Reading it, with a fallback to process.cwd()
// if it is empty, unparseable or has no usable cwd, is the documented
// behaviour.
async function resolveCwd(): Promise<string> {
  // A TTY (run by hand) never sends anything and never closes stdin;
  // reading it would hang waiting for input that is never coming.
  if (process.stdin.isTTY) return process.cwd();
  try {
    const data = JSON.parse(await Bun.stdin.text()) as { cwd?: unknown };
    if (typeof data.cwd === "string" && data.cwd.length > 0) return data.cwd;
  } catch {
    // empty stdin or not JSON — fall back below
  }
  return process.cwd();
}

/** Prints the status line. `cwd` skips reading stdin (tests, and callers that already know it). */
export async function renderStatusline(
  options: { cwd?: string } = {},
): Promise<void> {
  const fernDir = findFernDir(options.cwd ?? (await resolveCwd()));
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

export async function runStatusline(
  flags: Record<string, string>,
  homeDir: string = defaultHomeDir(),
): Promise<StatuslineInstallOutcome | undefined> {
  if (flags.install === "true") return installStatusline(homeDir);
  await renderStatusline();
  return undefined;
}
