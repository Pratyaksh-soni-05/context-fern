// Lightweight HTTP client for talking to the daemon — deliberately
// excludes packages/store and packages/embed from its import graph (see
// packages/daemon/test/client-import-graph.test.ts) so Claude Code hook
// scripts can import this without pulling in SQLite or the ONNX
// embedder. Exported as the "@context-fern/daemon/client" subpath;
// server.ts/project-registry.ts/embedder.ts must never be imported here.
//
// Three different "is the daemon up" needs, kept separate on purpose:
//   - isDaemonRunning(): read-only check for a current daemon — its one
//     side effect is stopping and forgetting a daemon it finds running
//     stale code (see its own doc comment).
//   - spawnDaemonDetached(): fire-and-forget spawn, never polls/waits —
//     for SessionStart, which must return immediately.
//   - ensureDaemonRunning(): spawns AND polls until ready — for the CLI,
//     which needs a live daemon to answer and is fine waiting ~5s for one.
// Every other hook must call the raw, non-spawning helpers below and
// fail silently (no daemon call at all) if the daemon isn't already up.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import { buildId } from "./build-id";
import {
  type DaemonInfo,
  deleteDaemonInfo,
  readDaemonInfo,
} from "./daemon-info";
import { TOKEN_HEADER } from "./protocol";

const ENTRYPOINT = join(import.meta.dir, "serve-entrypoint.ts");
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

export async function isAlive(
  info: DaemonInfo,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await fetch(daemonUrl(info, "/status"), {
      headers: daemonHeaders(info),
      ...(signal ? { signal } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure peek, no side effect at all: true if a recorded daemon exists
 * and its `buildId` doesn't match this process's own code. Exists so a
 * caller that wants to show a different message for "stale, about to
 * be replaced" vs. "never started" (the explicit `/fern ...` command
 * path) can check *before* calling `isDaemonRunning()`, which is the
 * one that actually acts on a stale daemon.
 */
export async function isDaemonStale(): Promise<boolean> {
  const info = await readDaemonInfo();
  return info !== null && info.buildId !== buildId();
}

/**
 * Read daemon.json and check liveness. No side effect — never spawns —
 * with one exception: a daemon whose `buildId` doesn't match this
 * process's own code is stale (left running from an older checkout —
 * the real cause of a stray-daemon incident during dogfooding, see
 * docs/decisions.md) and gets stopped and its daemon.json removed
 * rather than treated as "running." This never spawns a replacement
 * itself — every caller already has its own "if null, maybe spawn"
 * logic for the plain down-daemon case, and spawning here too would
 * double-spawn once `ensureDaemonRunning` (which calls this first)
 * also spawns on the null it gets back.
 */
export async function isDaemonRunning(
  signal?: AbortSignal,
): Promise<DaemonInfo | null> {
  const info = await readDaemonInfo();
  if (!info) return null;
  const alive = await isAlive(info, signal);
  if (info.buildId !== buildId()) {
    if (alive) {
      try {
        process.kill(info.pid);
      } catch {
        // already gone
      }
    }
    await deleteDaemonInfo();
    return null;
  }
  return alive ? info : null;
}

/** Fire-and-forget: spawns the daemon detached and returns immediately. Never polls, never waits — the only daemon-start call a hook may make. */
export function spawnDaemonDetached(): void {
  Bun.spawn({
    cmd: ["bun", "run", ENTRYPOINT],
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawns (if needed) and polls until ready. For the CLI only — hooks must never call this; use spawnDaemonDetached() or the raw*Json helpers instead. */
export async function ensureDaemonRunning(): Promise<DaemonInfo> {
  const existing = await isDaemonRunning();
  if (existing) return existing;

  spawnDaemonDetached();

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const info = await isDaemonRunning();
    if (info) return info;
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

function errorFrom(json: Record<string, unknown>, status: number): Error {
  return new Error(
    typeof json.error === "string" ? json.error : `daemon error (${status})`,
  );
}

/** Raw call assuming the daemon is already running — no spawn, no poll. Hooks must check isDaemonRunning() themselves first and no-op silently if it returns null. */
export async function rawPostJson(
  info: DaemonInfo,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(daemonUrl(info, path), {
    method: "POST",
    headers: daemonHeaders(info, { "content-type": "application/json" }),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const json = await parseJson(res);
  if (!res.ok) throw errorFrom(json, res.status);
  return json;
}

export async function rawGetJson(
  info: DaemonInfo,
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(daemonUrl(info, path), {
    headers: daemonHeaders(info),
    ...(signal ? { signal } : {}),
  });
  const json = await parseJson(res);
  if (!res.ok) throw errorFrom(json, res.status);
  return json;
}

/** Ensure + call — for the CLI, which wants a live daemon and is fine waiting for one. Hooks must not use this (see module doc). */
export async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const info = await ensureDaemonRunning();
  return rawPostJson(info, path, body);
}

export async function getJson(path: string): Promise<Record<string, unknown>> {
  const info = await ensureDaemonRunning();
  return rawGetJson(info, path);
}

function isSamePath(a: string, b: string): boolean {
  // Windows paths can differ only in case (drive letter, etc.) — the
  // filesystem itself is case-insensitive there, so the comparison must be.
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Walks upward from `cwd` looking for a `.fern/` directory, checking at
 * every level up to and including the git root, then stopping — a hook
 * must never walk above the enclosing git repo. Returns null if none is
 * found; callers (hooks) must no-op entirely in that case, since
 * installing the plugin globally must never create `.fern/` anywhere by
 * itself.
 *
 * Also stops at — and never accepts a `.fern/` found exactly in — the
 * user's home directory, whichever of that or the git root comes first.
 * A `.fern/` directly under the home dir is bookkeeping for the daemon
 * itself (or debugging leftovers), never a real project; without this,
 * every uninitialized folder under the home directory would look
 * initialized the moment one stray `.fern/` landed there. `homeDir`
 * defaults to `os.homedir()` but is overridable so this is directly
 * testable without relying on an env-var/native-call override to work —
 * see docs/decisions.md on why that's not reliable cross-platform.
 */
export function findFernDir(
  cwd: string,
  homeDir: string = homedir(),
): string | null {
  const home = resolve(homeDir);
  let dir = resolve(cwd);
  for (;;) {
    if (isSamePath(dir, home)) return null;
    const fernPath = join(dir, ".fern");
    if (existsSync(fernPath)) return fernPath;
    if (existsSync(join(dir, ".git"))) return null; // checked the git root itself; stop
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

export type { DaemonInfo };
