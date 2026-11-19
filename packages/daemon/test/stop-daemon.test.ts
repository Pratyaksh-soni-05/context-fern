// stopRunningDaemon must not return until the daemon process has really
// exited (a caller about to delete the executable would otherwise race it),
// and it must never signal a process just because a stale daemon.json names
// its pid. Driven with a real daemon in its own process.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopRunningDaemon } from "../src/client";
import {
  daemonInfoPath,
  readDaemonInfo,
  writeDaemonInfo,
} from "../src/daemon-info";

const ENTRYPOINT = join(import.meta.dir, "../src/serve-entrypoint.ts");
let fakeHome: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "fern-stop-test-"));
  for (const k of ["FERN_HOME", "LOCALAPPDATA", "XDG_CACHE_HOME"]) {
    saved[k] = process.env[k];
  }
  process.env.FERN_HOME = fakeHome;
  // Keep the real model cache out of it: the daemon degrades without one.
  process.env.LOCALAPPDATA = join(fakeHome, "local");
  process.env.XDG_CACHE_HOME = join(fakeHome, "cache");
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(fakeHome, { recursive: true, force: true });
});

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForDaemon(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const info = await readDaemonInfo();
    if (info) return info.pid;
    await Bun.sleep(100);
  }
  throw new Error("the test daemon never wrote daemon.json");
}

test("with no daemon recorded it says so and does nothing", async () => {
  expect(await stopRunningDaemon()).toEqual({ state: "not-running" });
});

test("it returns only after the daemon process has exited, and removes daemon.json", async () => {
  const child = Bun.spawn({
    cmd: ["bun", "run", ENTRYPOINT],
    env: { ...process.env },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const pid = await waitForDaemon();
    expect(exists(pid)).toBe(true);

    const result = await stopRunningDaemon();

    expect(result.state).toBe("stopped");
    // The point: at the moment it returns, the process is already gone.
    expect(exists(pid)).toBe(false);
    expect(await readDaemonInfo()).toBeNull();
  } finally {
    child.kill();
  }
}, 60_000);

test("a stale daemon.json is removed but the pid it names is never signalled", async () => {
  // This very test process is a live, unrelated process: the pid is real and
  // nothing answers on the port. If the helper killed it, this test would die.
  await writeDaemonInfo({
    port: 1,
    pid: process.pid,
    token: "not-a-real-token",
    startedAt: new Date().toISOString(),
    buildId: "stale",
  });
  expect(await Bun.file(daemonInfoPath()).exists()).toBe(true);

  const result = await stopRunningDaemon();

  expect(result).toEqual({ state: "stale-removed" });
  expect(exists(process.pid)).toBe(true);
  expect(await readDaemonInfo()).toBeNull();
});

test("a stale daemon.json whose port is now held by some OTHER server never gets the recorded pid killed, even if that server answers 200 or {ok:true}", async () => {
  for (const reply of [
    () => new Response("hello from some other local service"),
    () => Response.json({ ok: true }), // looks a bit like ours, but is not a project list
    () => Response.json({ ok: true, projects: [] }), // the old response shape, no pid or build id
    () =>
      Response.json({
        ok: true,
        projects: [],
        pid: process.pid + 1,
        buildId: "stale",
      }), // another daemon's pid
    () =>
      Response.json({
        ok: true,
        projects: [],
        pid: process.pid,
        buildId: "other",
      }), // right pid, wrong build
  ]) {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: reply });
    try {
      // The pid is this very test process: a live, unrelated process.
      await writeDaemonInfo({
        port: other.port as number,
        pid: process.pid,
        token: "not-a-real-token",
        startedAt: new Date().toISOString(),
        buildId: "stale",
      });
      const result = await stopRunningDaemon();
      expect(result).toEqual({ state: "stale-removed" });
      expect(exists(process.pid)).toBe(true);
      expect(await readDaemonInfo()).toBeNull();
    } finally {
      other.stop(true);
    }
  }
});
