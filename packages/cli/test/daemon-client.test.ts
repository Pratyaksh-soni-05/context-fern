import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllProjects,
  type DaemonHandle,
  startDaemon,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";
import {
  ensureDaemonRunning,
  getJson,
  isAlive,
  postJson,
} from "../src/daemon-client";

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;
let projectDir: string;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });
  projectDir = await mkdtemp(join(tmpdir(), "fern-proj-"));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  await closeAllProjects();
});

test("ensureDaemonRunning reuses an already-running daemon (reads daemon.json, doesn't spawn)", async () => {
  const info = await ensureDaemonRunning();
  expect(info.port).toBe(daemon?.port ?? -1);
  expect(info.token).toBe(daemon?.token ?? "");
});

test("isAlive is true for a running daemon", async () => {
  const info = await ensureDaemonRunning();
  expect(await isAlive(info)).toBe(true);
});

test("isAlive is false once the daemon has stopped", async () => {
  const info = await ensureDaemonRunning();
  await daemon?.stop();
  daemon = undefined;
  expect(await isAlive(info)).toBe(false);
});

test("postJson attaches the token and surfaces the daemon's error message on failure", async () => {
  await expect(postJson("/undo", { projectPath: projectDir })).rejects.toThrow(
    /nothing to undo/i,
  );
});

test("getJson round-trips a real /status call", async () => {
  const res = await getJson(
    `/status?projectPath=${encodeURIComponent(projectDir)}`,
  );
  expect(res.ok).toBe(true);
  expect(typeof res.receipt).toBe("string");
});
