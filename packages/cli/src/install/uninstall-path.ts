// The reversible edits outside the install directory, undone one at a time:
// the user PATH entry, the shell startup block and the `statusLine` entry in
// the user's settings.json. Each removes only what init recorded adding, each
// leaves anything that no longer looks like what init wrote, and each reports
// which of those it did.
//
// The Windows script mirrors the add script in path-setup.ts: it reads the
// raw unexpanded value, keeps the value kind, changes exactly one entry and
// broadcasts the change. It never rewrites a PATH it does not need to.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { classifyStatuslineCommand } from "../commands/statusline";
import {
  cleanPowerShellEnv,
  RC_BEGIN,
  RC_END,
  windowsPowerShell,
} from "./path-setup";
import { discardOwnTemp } from "./safe-remove";

// The directory and the registry location arrive through the environment, so
// no path is ever interpolated into the script text.
export const WINDOWS_PATH_REMOVE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dir = $env:FERN_PATH_REMOVE
$sub = $env:FERN_PATH_KEY
$name = $env:FERN_PATH_VALUE
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
if ($null -eq $key) { Write-Output 'absent'; exit 0 }
$raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if ($null -eq $raw) { Write-Output 'absent'; exit 0 }
$kind = $key.GetValueKind($name).ToString()
$parts = @($raw -split ';')
$want = $dir.TrimEnd('\\')
$idx = -1
for ($i = $parts.Count - 1; $i -ge 0; $i--) {
  $p = $parts[$i]
  if ($p -ne '') {
    $x = [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\\')
    if ($x -ieq $want -or $p.TrimEnd('\\') -ieq $want) { $idx = $i; break }
  }
}
if ($idx -lt 0) { Write-Output 'absent'; exit 0 }
$keep = @()
for ($i = 0; $i -lt $parts.Count; $i++) { if ($i -ne $idx) { $keep += $parts[$i] } }
$key.SetValue($name, ($keep -join ';'), [Microsoft.Win32.RegistryValueKind]$kind)
if ($env:FERN_PATH_BROADCAST -ne '0') {
  Add-Type -Namespace FernNative -Name Env -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $r = [UIntPtr]::Zero
  [void][FernNative.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}
Write-Output "removed|$kind"
`;

export interface WindowsPathRemoveOptions {
  /** Test seam: a scratch key under HKCU instead of the real `Environment`. */
  registrySubKey?: string;
  valueName?: string;
  broadcast?: boolean;
}

/** Removes the last occurrence of `dir` from the user PATH. "absent" if it is not there (already removed). */
export function removeFromWindowsUserPath(
  dir: string,
  opts: WindowsPathRemoveOptions = {},
): Promise<"removed" | "absent"> {
  return new Promise((resolve, reject) => {
    execFile(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_PATH_REMOVE_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          ...cleanPowerShellEnv(),
          FERN_PATH_REMOVE: dir,
          FERN_PATH_KEY: opts.registrySubKey ?? "Environment",
          FERN_PATH_VALUE: opts.valueName ?? "Path",
          FERN_PATH_BROADCAST: opts.broadcast === false ? "0" : "1",
        },
        timeout: 30_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${stderr || err.message}`.trim()));
          return;
        }
        resolve(stdout.trim().startsWith("removed") ? "removed" : "absent");
      },
    );
  });
}

export type FileEditOutcome =
  | { state: "removed"; backupPath: string }
  | { state: "absent" }
  | { state: "left-alone"; reason: string };

/**
 * Writes `text` over `file` without ever truncating it in place: a new file
 * (exclusive create) is renamed over it, keeping its permissions. A symlink
 * is followed first, so a dotfiles-repository link stays a link.
 */
async function replaceFileContents(file: string, text: string): Promise<void> {
  const real = realpathSync(file);
  const mode = statSync(real).mode & 0o777;
  const tmp = `${real}.context-fern-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let created = false;
  try {
    await writeFile(tmp, text, { encoding: "utf-8", flag: "wx", mode });
    created = true;
    await chmod(tmp, mode);
    await rename(tmp, real);
  } catch (err) {
    if (created) await discardOwnTemp(tmp);
    throw err;
  }
}

/** The block `addToShellRc` writes for `dir`, exactly. */
export function expectedRcBlock(dir: string): string {
  return `${RC_BEGIN}\nexport PATH='${dir}':"$PATH"\n${RC_END}\n`;
}

/**
 * Removes the block init appended, only if it is still exactly what init
 * wrote. If the markers are there but the content between them changed, the
 * file is left alone. The file is copied first.
 */
export async function removeShellRcBlock(
  file: string,
  dir: string,
): Promise<FileEditOutcome> {
  if (!existsSync(file)) return { state: "absent" };
  const text = await readFile(file, "utf-8");
  if (!text.includes(RC_BEGIN)) return { state: "absent" };
  const block = expectedRcBlock(dir);
  const at = text.indexOf(block);
  if (at < 0 || text.indexOf(block, at + 1) >= 0) {
    return {
      state: "left-alone",
      reason: `the ${RC_BEGIN} block in ${file} is not exactly what init wrote (or appears more than once), so it was not touched`,
    };
  }
  const backupPath = `${file}.context-fern-uninstall-${Date.now()}.bak`;
  await copyFile(file, backupPath, constants.COPYFILE_EXCL);
  await replaceFileContents(
    file,
    text.slice(0, at) + text.slice(at + block.length),
  );
  return { state: "removed", backupPath };
}

/**
 * Removes the `statusLine` key from the user's settings.json, only if its
 * command equals the command init recorded adding, or is the one old command
 * earlier versions wrote (`bun run "<repo>/.../statusline.ts"`). Anything else,
 * including a command that merely looks like fern's, is left alone and
 * reported.
 */
export async function removeStatuslineEntry(
  settingsFile: string,
  recordedCommand?: string,
): Promise<FileEditOutcome> {
  if (!existsSync(settingsFile)) return { state: "absent" };
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(settingsFile, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {
      state: "left-alone",
      reason: `${settingsFile} is not valid JSON, so it was not touched`,
    };
  }
  const entry = settings.statusLine as { command?: unknown } | undefined;
  if (entry === undefined) return { state: "absent" };
  const kind = classifyStatuslineCommand(entry.command);
  const isRecorded =
    recordedCommand !== undefined && entry.command === recordedCommand;
  if (!isRecorded && kind !== "legacy-bun") {
    return {
      state: "left-alone",
      reason:
        recordedCommand !== undefined
          ? `the statusLine in ${settingsFile} is not the command init recorded adding (${JSON.stringify(recordedCommand)}); its command is ${JSON.stringify(entry.command)}, so it was not touched`
          : kind === "current"
            ? `the statusLine in ${settingsFile} runs ${JSON.stringify(entry.command)}, which looks like fern's, but init did not record adding it, so it was not touched · remove it yourself if it is fern's`
            : `the statusLine in ${settingsFile} is not fern's (its command is ${JSON.stringify(entry.command)}), so it was not touched`,
    };
  }
  const backupPath = `${settingsFile}.context-fern-uninstall-${Date.now()}.bak`;
  await copyFile(settingsFile, backupPath, constants.COPYFILE_EXCL);
  const { statusLine: _removed, ...rest } = settings;
  await replaceFileContents(settingsFile, `${JSON.stringify(rest, null, 2)}\n`);
  return { state: "removed", backupPath };
}
