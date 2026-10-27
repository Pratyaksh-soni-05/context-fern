// ~/.fern/daemon.json — one daemon per machine, spec/architecture.md's
// "random port written to ~/.fern/daemon.json". This is deliberately the
// OS user config dir (CONFIG_DIR under os.homedir()), never a project's
// own .fern/ — the daemon serves every project on the machine. Disk I/O
// from packages/daemon is a documented exception to CLAUDE.md's "only
// store touches disk" (architecture.md already prescribed this exact
// path); see docs/decisions.md.
//
// `FERN_HOME` (ENV_PREFIX's convention) overrides the home dir used here
// — tests set it to a temp dir so they never touch the real machine's
// ~/.fern/daemon.json.

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

export function daemonInfoPath(): string {
  return join(fernHomeDir(), CONFIG_DIR, "daemon.json");
}

export async function readDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const text = await readFile(daemonInfoPath(), "utf-8");
    return JSON.parse(text) as DaemonInfo;
  } catch {
    return null;
  }
}

export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  const dir = join(fernHomeDir(), CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(daemonInfoPath(), JSON.stringify(info, null, 2), "utf-8");
}

export async function deleteDaemonInfo(): Promise<void> {
  await rm(daemonInfoPath(), { force: true });
}
