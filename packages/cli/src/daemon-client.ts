// Talks to the daemon over HTTP; starts it if it isn't running. This is
// genuinely new territory in this repo (no prior Bun.spawn/subprocess
// code) — see docs/decisions.md for the monorepo-relative entrypoint
// path limitation (no packaged distribution exists yet to resolve
// against instead).

import { join } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import {
  type DaemonInfo,
  readDaemonInfo,
  TOKEN_HEADER,
} from "@context-fern/daemon";

const ENTRYPOINT = join(
  import.meta.dir,
  "../../daemon/src/serve-entrypoint.ts",
);
const POLL_INTERVAL_MS = 100;
const MAX_POLLS = 50; // ~5s — the embedder's warm-up is the slow part

function daemonUrl(info: DaemonInfo, path: string): string {
  return `http://127.0.0.1:${info.port}${path}`;
}

function daemonHeaders(info: DaemonInfo, extra: Record<string, string> = {}) {
  return {
    host: `127.0.0.1:${info.port}`,
    [TOKEN_HEADER]: info.token,
    ...extra,
  };
}

async function isAlive(info: DaemonInfo): Promise<boolean> {
  try {
    await fetch(daemonUrl(info, "/status"), { headers: daemonHeaders(info) });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDaemonRunning(): Promise<DaemonInfo> {
  const existing = await readDaemonInfo();
  if (existing && (await isAlive(existing))) return existing;

  Bun.spawn({
    cmd: ["bun", "run", ENTRYPOINT],
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const info = await readDaemonInfo();
    if (info && (await isAlive(info))) return info;
  }
  throw new Error(`Timed out waiting for the ${CLI_NAME} daemon to start.`);
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const info = await ensureDaemonRunning();
  const res = await fetch(daemonUrl(info, path), {
    method: "POST",
    headers: daemonHeaders(info, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `daemon error (${res.status})`,
    );
  }
  return json;
}

export async function getJson(path: string): Promise<Record<string, unknown>> {
  const info = await ensureDaemonRunning();
  const res = await fetch(daemonUrl(info, path), {
    headers: daemonHeaders(info),
  });
  const json = await parseJson(res);
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `daemon error (${res.status})`,
    );
  }
  return json;
}

export type { DaemonInfo };
export { isAlive };
