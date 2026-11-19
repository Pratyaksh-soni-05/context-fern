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

import { existsSync, realpathSync } from "node:fs";
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
 * Whether what answers on the recorded port is really a fern daemon, not
 * merely something that completes an HTTP request (`isAlive` accepts any
 * response). It asks for `/projects` with the daemon's token and requires the
 * answer to carry the daemon's own `pid` and `buildId`, equal to the ones in
 * daemon.json, so a server that merely copies the response shape, or a
 * different fern daemon, is not taken for the recorded one. This, not
 * `isAlive`, is what gates sending a signal to the recorded pid: a stale
 * daemon.json whose port a different server now holds, and whose pid has been
 * recycled, must never get an unrelated process killed.
 */
export async function isOurDaemon(
  info: DaemonInfo,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(daemonUrl(info, "/projects"), {
      headers: daemonHeaders(info),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      ok?: unknown;
      projects?: unknown;
      pid?: unknown;
      buildId?: unknown;
    };
    return (
      body.ok === true &&
      Array.isArray(body.projects) &&
      body.pid === info.pid &&
      typeof body.buildId === "string" &&
      body.buildId === info.buildId
    );
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
    if (alive && (await isOurDaemon(info, signal))) {
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

/**
 * Spawns `cmd` fully detached from this process — stdio ignored,
 * unref'd immediately — so the child (and whatever it execs or hands
 * off to) survives this process exiting right after the call returns.
 * The hazard this guards against is real, not theoretical: on Windows,
 * a child spawned without `detached: true` can be torn down by the OS
 * once its own un-detached parent exits, even when the parent exits
 * only moments after the spawn call — which is exactly the shape of
 * every caller here (spawn, then return, then the caller's own process
 * exits almost immediately after). This was the actual cause of `fern
 * ui`'s browser intermittently never completing its navigation before
 * this helper existed — see docs/decisions.md. Every detached spawn in
 * this codebase must go through this one function, not call
 * `Bun.spawn` directly, so this can't regress at a new call site.
 */
export function spawnDetached(
  cmd: string[],
  env?: Record<string, string>,
): void {
  Bun.spawn({
    cmd,
    // Added to the current environment, never interpolated into `cmd`: the
    // way a caller hands a detached child values it must not splice into a
    // command line.
    ...(env ? { env: { ...process.env, ...env } } : {}),
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();
}

/**
 * Pure decision, factored out so it's directly unit-testable without
 * mocking `Bun.spawn` or touching a real process: given whether the dev
 * `serve-entrypoint.ts` exists on disk, which command spawns the
 * daemon. Inside a `bun build --compile` binary, `import.meta.dir`
 * doesn't point at a real file (there is no "../serve-entrypoint.ts" to
 * run), and `bun`/the source tree may not even be installed on the end
 * user's machine — `bun run <path>` cannot work there.
 * `[process.execPath, "--internal-daemon"]` instead re-invokes this
 * exact same executable (the compiled binary is its own daemon
 * entrypoint via index.ts's own internal-daemon branch, handled outside
 * main()'s process.exit() wrapper so the server's own open socket keeps
 * the process alive) — this is also exactly correct for a `bun run` dev
 * checkout as long as `--internal-daemon` resolves back to this same
 * source tree, but the cheap, reliable signal to tell the two cases
 * apart is the entrypoint file's own existence, not guessing from
 * process.execPath's name. See docs/decisions.md's PR 1 spike finding
 * on this exact bug.
 */
export function daemonSpawnCommand(entrypointExists: boolean): string[] {
  return entrypointExists
    ? ["bun", "run", ENTRYPOINT]
    : [process.execPath, "--internal-daemon"];
}

/** Fire-and-forget: spawns the daemon detached and returns immediately. Never polls, never waits — the only daemon-start call a hook may make. */
export function spawnDaemonDetached(): void {
  spawnDetached(daemonSpawnCommand(existsSync(ENTRYPOINT)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StopResult =
  | { state: "not-running" }
  /** daemon.json named a daemon that does not answer: the file is removed, the pid is never touched (it may have been recycled for an unrelated process). */
  | { state: "stale-removed" }
  | { state: "stopped"; pid: number; waitedMs: number }
  | { state: "timeout"; pid: number };

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: gone. EPERM: it exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stops the daemon recorded in daemon.json and WAITS until its process has
 * exited before returning, so a caller that is about to delete or replace
 * the executable (uninstall) is not racing a process that still holds it
 * (on Windows a running image cannot be deleted). The kill only happens if
 * what answers on the recorded port proves it is a fern daemon
 * (`isOurDaemon`), so a stale file can never get an unrelated process
 * killed. `timeoutMs` bounds the wait.
 */
export async function stopRunningDaemon(timeoutMs = 5000): Promise<StopResult> {
  const info = await readDaemonInfo();
  if (!info) return { state: "not-running" };
  // Verified, not merely answering: anything else is a stale file, and the pid
  // it names is never signalled.
  if (!(await isOurDaemon(info, AbortSignal.timeout(2000)))) {
    await deleteDaemonInfo();
    return { state: "stale-removed" };
  }
  try {
    process.kill(info.pid);
  } catch {
    // already gone
  }
  const started = Date.now();
  while (processExists(info.pid)) {
    if (Date.now() - started >= timeoutMs) {
      return { state: "timeout", pid: info.pid };
    }
    await sleep(50);
  }
  await deleteDaemonInfo();
  return { state: "stopped", pid: info.pid, waitedMs: Date.now() - started };
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

export function isSamePath(a: string, b: string): boolean {
  // Windows paths can differ only in case (drive letter, etc.) — the
  // filesystem itself is case-insensitive there, so the comparison must be.
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

// Memoized per raw input string, not per process lifetime overall — a
// failed/nonexistent-path resolution is never cached (see below), only
// a successful native-realpath one. The daemon process is long-lived,
// so this turns "one real syscall the first time a given raw path is
// seen" into "free" for every later call with that same raw string —
// load-bearing for hot paths like /prompt, which every passive hook
// call hits once per turn.
const canonicalPathCache = new Map<string, string>();

/**
 * Resolves `rawPath` to one canonical identity for "this real project
 * directory" — the same bug class as two differently-spelled paths
 * (a Windows 8.3 short name vs. the long form, a case difference, a
 * trailing separator) landing in `sessions.project_path` as if they
 * were two different projects, each with its own empty session. Used
 * everywhere a project's identity is derived from a raw path: the CLI,
 * the Claude Code hooks, the daemon's in-memory project registry and
 * `~/.fern/projects.json`, and any daemon endpoint that takes a
 * `projectPath` (indirectly, via `getOrOpenProject`).
 *
 * `fs.realpathSync.native` (not the plain JS-implemented `fs.realpath`)
 * is what actually expands a Windows 8.3 short name and resolves
 * symlinks via the OS itself — it also returns the path in its real,
 * on-disk casing, which already normalizes ordinary case differences
 * without a separate lowercasing step (full case-insensitive EQUALITY
 * still goes through `isSamePath` as a backstop, for the one case this
 * doesn't cover: the path doesn't exist yet, so native resolution
 * fails and the fallback below preserves whatever casing the caller
 * passed in).
 *
 * Never throws: a path that doesn't exist (yet, or any longer) falls
 * back to a plain `path.resolve()` — every real caller here is
 * opening a path that's expected to exist, and a canonicalization
 * helper throwing on a transient/nonexistent path would be a worse
 * failure mode than a slightly-less-canonical fallback string.
 */
export function canonicalizeProjectPath(rawPath: string): string {
  const cached = canonicalPathCache.get(rawPath);
  if (cached !== undefined) return cached;

  const resolved = resolve(rawPath).replace(/[\\/]+$/, "") || resolve(rawPath);
  try {
    const native = realpathSync.native(resolved);
    canonicalPathCache.set(rawPath, native);
    return native;
  } catch {
    return resolved; // not cached — try native resolution again next time
  }
}

/** Test-only: clears the memoization cache so a test that creates/removes temp directories under colliding raw paths doesn't see a stale resolution from an earlier test. */
export function clearCanonicalProjectPathCache(): void {
  canonicalPathCache.clear();
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
