// Windows will not delete a program that is running, and `context-fern
// uninstall` is usually running from the copy it is removing. The sequence
// (verified on NTFS with the real binary): rename our own running exe aside
// (allowed), delete every other name (allowed, including the other name of the
// hard-linked pair), exit, and let a small detached helper delete the renamed
// file once our process is gone. The helper is the system PowerShell by full
// path, gets its work through environment variables only (nothing is spliced
// into the command line), and deletes a file only if its SHA-256 still equals
// the one recorded: the same rule as every other delete in install code.
//
// How it is launched matters, and was measured with a parent that exits at
// once (the real situation): PowerShell started with `detached: true` never
// runs at all (it needs a console), and a plain attached child is killed when
// its parent exits. `cmd.exe /d /c start "" /b powershell ...` survives, so
// that is what runs, through `spawnDetached` like every other detached spawn.
// The script travels in an environment variable and the command line carries
// only a base64 `-EncodedCommand`, so no character in it can be misparsed by
// cmd. The helper cannot report back, so uninstall prints, up front, the one
// command that removes the file by hand.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnDetached } from "@context-fern/daemon/client";
import type { PendingDelete } from "./manifest";
import { cleanPowerShellEnv, windowsPowerShell } from "./path-setup";

export const DELETE_HELPER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
# This script uses no PowerShell cmdlets, only the language and .NET. On the
# GitHub Windows runner (whose default shell is PowerShell 7, which sets
# PSModulePath for its own modules) the Windows PowerShell child could not find
# Get-FileHash, and the helper silently did nothing; .NET has no such dependency.
# FERN_DEL_LOG, when set, names a file that records each step.
function Log($m) {
  if ($env:FERN_DEL_LOG) {
    try { [System.IO.File]::AppendAllText($env:FERN_DEL_LOG, ([DateTime]::Now.ToString('HH:mm:ss.fff') + ' ' + $m + [char]10), [System.Text.Encoding]::UTF8) } catch {}
  }
}
function Sha256($path) {
  try {
    $s = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $a = [System.Security.Cryptography.SHA256]::Create()
      return ([System.BitConverter]::ToString($a.ComputeHash($s)).Replace('-', '').ToLower())
    } finally { $s.Dispose() }
  } catch { return $null }
}
# Jobs are lines of "<sha256>|<path>" and directories are lines of paths: neither '|' nor a newline can be in a Windows path.
$jobs = @()
foreach ($line in ([string]$env:FERN_DEL_JOBS).Split([char]10)) {
  $line = $line.Trim([char]13)
  $bar = $line.IndexOf('|')
  if ($bar -gt 0) { $jobs += ,@($line.Substring(0, $bar), $line.Substring($bar + 1)) }
}
$dirs = @()
foreach ($line in ([string]$env:FERN_DEL_DIRS).Split([char]10)) {
  $line = $line.Trim([char]13)
  if ($line.Length -gt 0) { $dirs += $line }
}
Log ('jobs=' + $jobs.Count + ' dirs=' + $dirs.Count + ', waiting for pid ' + $env:FERN_DEL_PID)
try { [void][System.Diagnostics.Process]::GetProcessById([int]$env:FERN_DEL_PID).WaitForExit(120000) } catch {}
Log 'wait over'
# A job stays pending, and is retried, until its file is gone or its hash is
# known not to match: a file that cannot be read yet (antivirus scanning a
# just-exited executable, a handle not yet released) is not a reason to give up.
for ($try = 0; $try -lt 120; $try++) {
  $pending = 0
  foreach ($j in $jobs) {
    $expected = $j[0]
    $path = $j[1]
    if (-not [System.IO.File]::Exists($path)) { continue }
    $h = Sha256 $path
    if ($try -eq 0 -or ($try % 20) -eq 0) { Log ('try ' + $try + ' ' + $path + ' hash=' + $h + ' expected=' + $expected) }
    if (-not $h) { $pending++; continue }
    if ($h -ne $expected) { Log ('left alone (changed): ' + $path); continue }
    try { [System.IO.File]::Delete($path) } catch { Log ('delete failed: ' + $_.Exception.Message) }
    if ([System.IO.File]::Exists($path)) { $pending++ } else { Log ('deleted ' + $path) }
  }
  if ($pending -eq 0) { break }
  [System.Threading.Thread]::Sleep(500)
}
foreach ($d in $dirs) {
  try {
    if ([System.IO.Directory]::Exists($d) -and ([System.IO.Directory]::GetFileSystemEntries($d).Length -eq 0)) {
      [System.IO.Directory]::Delete($d)
      Log ('removed directory ' + $d)
    }
  } catch { Log ('could not remove directory ' + $d + ': ' + $_.Exception.Message) }
}
Log 'helper done'
`;

/** What the encoded command runs: the script from the environment, never from the command line. */
const BOOTSTRAP = "& ([scriptblock]::Create($env:FERN_DEL_SCRIPT))";

export function encodedBootstrap(): string {
  return Buffer.from(BOOTSTRAP, "utf16le").toString("base64");
}

function windowsCmd(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root) {
    const p = join(root, "System32", "cmd.exe");
    if (existsSync(p)) return p;
  }
  return "cmd.exe";
}

export type SpawnFn = (cmd: string[], env: Record<string, string>) => void;

/**
 * Starts the helper. `dirs` are removed afterwards only if empty (deepest
 * first). `waitPid` is the process to wait for, normally ours.
 */
export function startDeleteHelper(
  jobs: readonly PendingDelete[],
  dirs: readonly string[],
  waitPid: number = process.pid,
  spawn: SpawnFn = spawnDetached,
): void {
  spawn(
    [
      windowsCmd(),
      "/d",
      "/c",
      "start",
      "",
      "/b",
      windowsPowerShell(),
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedBootstrap(),
    ],
    {
      ...cleanPowerShellEnv(),
      FERN_DEL_SCRIPT: DELETE_HELPER_SCRIPT,
      FERN_DEL_JOBS: jobs.map((j) => `${j.sha256}|${j.path}`).join("\n"),
      FERN_DEL_DIRS: dirs.join("\n"),
      FERN_DEL_PID: String(waitPid),
    },
  );
}

/** The one command that removes a leftover file by hand, in PowerShell. */
export function manualRemoveCommand(path: string): string {
  // PowerShell treats U+2018, U+2019, U+201A and U+201B as single quotes too.
  return `Remove-Item -LiteralPath '${path.replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}' -Force`;
}
