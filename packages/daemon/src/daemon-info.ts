// ~/.fern/daemon.json — one daemon per machine, spec/architecture.md's
// "random port written to ~/.fern/daemon.json". This is deliberately the
// OS user config dir (CONFIG_DIR under os.homedir()), never a project's
// own .fern/ — the daemon serves every project on the machine. Disk I/O
// from packages/daemon is a documented exception to CLAUDE.md's "only
// store touches disk" (architecture.md already prescribed this exact
// path); see docs/decisions.md.
//
// Every function below takes an optional `homeDir` override as its
// first argument — direct (in-process) callers, i.e. tests, should pass
// a temp directory explicitly rather than relying on `FERN_HOME`, so a
// test can never silently fall through to the real home dir just by
// forgetting an env-var reset. `FERN_HOME` (ENV_PREFIX's convention)
// remains the only channel for the daemon's own cross-process callers
// (the spawned daemon subprocess, hook scripts) — a function parameter
// can't cross a process boundary, so `fernHomeDir()` is still the
// default when `homeDir` is omitted. See docs/decisions.md.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, ENV_PREFIX } from "@context-fern/core";

export interface DaemonInfo {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

function fernHomeDir(): string {
  return process.env[`${ENV_PREFIX}HOME`] || homedir();
}

export function daemonInfoPath(homeDir: string = fernHomeDir()): string {
  return join(homeDir, CONFIG_DIR, "daemon.json");
}

export async function readDaemonInfo(
  homeDir: string = fernHomeDir(),
): Promise<DaemonInfo | null> {
  try {
    const text = await readFile(daemonInfoPath(homeDir), "utf-8");
    return JSON.parse(text) as DaemonInfo;
  } catch {
    return null;
  }
}

export async function writeDaemonInfo(
  info: DaemonInfo,
  homeDir: string = fernHomeDir(),
): Promise<void> {
  const dir = join(homeDir, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    daemonInfoPath(homeDir),
    JSON.stringify(info, null, 2),
    "utf-8",
  );
}

export async function deleteDaemonInfo(
  homeDir: string = fernHomeDir(),
): Promise<void> {
  await rm(daemonInfoPath(homeDir), { force: true });
}
