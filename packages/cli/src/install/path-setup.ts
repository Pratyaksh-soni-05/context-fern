// Getting <prefix>/bin onto PATH, with the user's say-so and never silently.
//
// Windows: the user PATH in the registry, never `setx` (it truncates at
// 1024 characters). We write the value ourselves, keeping its existing
// kind, because `[Environment]::SetEnvironmentVariable(.., 'User')` always
// rewrites it as REG_SZ: a user PATH that is REG_EXPAND_SZ with %USERPROFILE%
// style entries (the Windows default) would stop expanding them
// (measured on this repo's maintainer machine, docs/decisions.md). The
// script then broadcasts WM_SETTINGCHANGE so new terminals see it.
//
// macOS/Linux: a marked block appended to the shell's rc file, recorded in
// the install manifest so uninstall can remove exactly that block.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import { CLI_BINARY_NAME } from "@context-fern/core";
import type { PathEdit } from "./manifest";

function normalize(p: string, platform: NodeJS.Platform): string {
  const P = platform === "win32" ? win32 : posix;
  let out = P.resolve(p);
  while (out.length > 1 && out.endsWith(P.sep)) out = out.slice(0, -1);
  return platform === "win32" ? out.toLowerCase() : out;
}

export function isOnPath(
  dir: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  const raw = env.PATH ?? env.Path ?? "";
  const want = normalize(dir, platform);
  return raw
    .split(platform === "win32" ? ";" : ":")
    .filter((e) => e.length > 0)
    .some((e) => normalize(e, platform) === want);
}

export function shellRcFile(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): { file: string; shell: string } | null {
  const shell = basename(env.SHELL ?? "");
  if (shell === "zsh")
    return { file: join(env.ZDOTDIR ?? home, ".zshrc"), shell };
  if (shell === "bash") {
    // macOS Terminal starts login shells, which read .bash_profile, not .bashrc.
    return {
      file: join(home, platform === "darwin" ? ".bash_profile" : ".bashrc"),
      shell,
    };
  }
  return null; // fish, nushell, unknown: we print the command instead of guessing
}

/** The one command that fixes PATH by hand, for the message shown when nothing is edited. */
export function pathFixCommand(
  dir: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string {
  if (platform === "win32") {
    // Not SetEnvironmentVariable: it rewrites the value as REG_SZ and breaks %VAR% entries (docs/decisions.md).
    return `run "${CLI_BINARY_NAME} init --add-to-path", or add ${dir} in Settings > System > About > Advanced system settings > Environment Variables > Path`;
  }
  if (basename(env.SHELL ?? "") === "fish") return `fish_add_path "${dir}"`;
  return `export PATH="${dir}:$PATH"   # add this line to your shell's startup file`;
}

export const RC_BEGIN = `# >>> ${CLI_BINARY_NAME} >>>`;
export const RC_END = `# <<< ${CLI_BINARY_NAME} <<<`;

export async function addToShellRc(
  file: string,
  dir: string,
): Promise<PathEdit | "already"> {
  if (/['\n\r]/.test(dir)) {
    throw new Error(
      `${dir} has a quote or newline in it, so it cannot be written safely into ${file}`,
    );
  }
  const existing = existsSync(file) ? await readFile(file, "utf-8") : "";
  if (existing.includes(RC_BEGIN)) return "already";
  const lead = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(
    file,
    `${lead}${RC_BEGIN}\nexport PATH='${dir}':"$PATH"\n${RC_END}\n`,
    "utf-8",
  );
  return {
    kind: "shell-rc",
    file,
    beginMarker: RC_BEGIN,
    endMarker: RC_END,
  };
}

// The directory and registry location arrive through the environment, so
// no path is ever interpolated into the script text.
export const WINDOWS_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dir = $env:FERN_PATH_ADD
$sub = $env:FERN_PATH_KEY
$name = $env:FERN_PATH_VALUE
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
$raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind = if ($null -ne $raw) { $key.GetValueKind($name).ToString() } else { 'ExpandString' }
$parts = @()
if ($raw) { $parts = @($raw -split ';' | Where-Object { $_ -ne '' }) }
$want = $dir.TrimEnd('\\')
foreach ($p in $parts) {
  $x = [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\\')
  if ($x -ieq $want -or $p.TrimEnd('\\') -ieq $want) { Write-Output "already|$kind"; exit 0 }
}
$key.SetValue($name, (($parts + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]$kind)
if ($env:FERN_PATH_BROADCAST -ne '0') {
  Add-Type -Namespace FernNative -Name Env -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $r = [UIntPtr]::Zero
  [void][FernNative.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}
Write-Output "added|$kind"
`;

export interface WindowsPathOptions {
  /** Test seam: a scratch key under HKCU instead of the real `Environment`. */
  registrySubKey?: string;
  valueName?: string;
  broadcast?: boolean;
}

/** The system's own powershell.exe by full path, not found through the current directory or PATH. */
function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root) {
    const p = join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(p)) return p;
  }
  return "powershell.exe";
}

export function addToWindowsUserPath(
  dir: string,
  opts: WindowsPathOptions = {},
): Promise<PathEdit | "already"> {
  // A `;` would split the entry in two and a `%VAR%` would be expanded.
  if (/[;%]/.test(dir)) {
    return Promise.reject(
      new Error(
        `${dir} contains a ";" or "%", which cannot be added to PATH safely`,
      ),
    );
  }
  return new Promise((resolvePromise, reject) => {
    execFile(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_PATH_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          FERN_PATH_ADD: dir,
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
        const [state, kind] = stdout.trim().split("|");
        if (state === "already") resolvePromise("already");
        else
          resolvePromise({
            kind: "windows-user-path",
            added: dir,
            valueKind: kind ?? "ExpandString",
          });
      },
    );
  });
}
