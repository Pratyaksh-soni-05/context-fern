// Finds daemon processes started from this checkout, so the test run can
// notice one that outlives it. A daemon the CLI spawns is detached and its
// pid is known only through daemon.json, which names one daemon even when
// several raced to start (and none when the test gave up first), so the only
// reliable way to account for them is the process list.

import { spawnSync } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  commandLine: string;
}

/** `Get-CimInstance ... | ConvertTo-Json` output (one object, or an array of them). */
export function parseWindowsProcessJson(text: string): ProcessEntry[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessEntry[] = [];
  for (const r of rows as {
    ProcessId?: number;
    CommandLine?: string | null;
  }[]) {
    if (typeof r.ProcessId === "number" && typeof r.CommandLine === "string")
      out.push({ pid: r.ProcessId, commandLine: r.CommandLine });
  }
  return out;
}

/** `ps -eo pid=,args=` output. */
export function parsePsOutput(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), commandLine: m[2] as string });
  }
  return out;
}

export function listProcesses(): ProcessEntry[] {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve-entrypoint*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf-8", windowsHide: true },
    );
    return parseWindowsProcessJson(r.stdout ?? "");
  }
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8" });
  return parsePsOutput(r.stdout ?? "");
}

const normalize = (s: string) => s.replaceAll("\\", "/").toLowerCase();

/** Daemon processes whose entry point lives under `repoRoot`. */
export function daemonPids(
  processes: ProcessEntry[],
  repoRoot: string,
): number[] {
  const root = normalize(repoRoot);
  return processes
    .filter((p) => {
      const c = normalize(p.commandLine);
      return c.includes("serve-entrypoint") && c.includes(`${root}/`);
    })
    .map((p) => p.pid);
}

export function kill(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

/**
 * Kills daemon processes from this checkout that were not alive in `before`,
 * and keeps looking until none shows up for `quietPolls` polls in a row (a
 * daemon that is still starting has not written daemon.json yet, so
 * `fern daemon stop` cannot see it). Returns how many it had to kill.
 */
export async function killDaemonsStartedSince(
  before: ReadonlySet<number>,
  repoRoot: string,
  options: { deadlineMs?: number; quietPolls?: number; pollMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + (options.deadlineMs ?? 30_000);
  const quietPolls = options.quietPolls ?? 3;
  let killed = 0;
  let quiet = 0;
  while (Date.now() < deadline && quiet < quietPolls) {
    const fresh = daemonPids(listProcesses(), repoRoot).filter(
      (pid) => !before.has(pid),
    );
    if (fresh.length === 0) quiet++;
    else {
      quiet = 0;
      for (const pid of fresh) kill(pid);
      killed += fresh.length;
    }
    await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
  }
  return killed;
}
