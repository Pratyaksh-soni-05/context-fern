// Moved from packages/cli/test/daemon-client.test.ts now that the
// client lives in this package (see src/client.ts's module doc for why).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedder } from "@context-fern/embed";
import {
  ensureDaemonRunning,
  findFernDir,
  getJson,
  isAlive,
  isDaemonRunning,
  postJson,
} from "../src/client";
import { closeAllProjects } from "../src/project-registry";
import { type DaemonHandle, startDaemon } from "../src/server";

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

test("isDaemonRunning returns the info for a live daemon and never spawns", async () => {
  const info = await isDaemonRunning();
  expect(info?.port).toBe(daemon?.port ?? -1);
});

test("isDaemonRunning returns null when the daemon is down, without spawning one", async () => {
  await daemon?.stop();
  daemon = undefined;
  expect(await isDaemonRunning()).toBeNull();
  // No daemon.json should have been written by isDaemonRunning itself.
  const { readDaemonInfo } = await import("../src/daemon-info");
  expect(await readDaemonInfo()).toBeNull();
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

test("findFernDir finds .fern/ in the given directory", async () => {
  await mkdir(join(projectDir, ".fern"));
  expect(findFernDir(projectDir)).toBe(join(projectDir, ".fern"));
});

test("findFernDir walks upward to find .fern/ in an ancestor", async () => {
  await mkdir(join(projectDir, ".fern"));
  const nested = join(projectDir, "src", "deep", "nested dir");
  await mkdir(nested, { recursive: true });
  expect(findFernDir(nested)).toBe(join(projectDir, ".fern"));
});

test("findFernDir stops at the git root and returns null if nothing is found", async () => {
  await mkdir(join(projectDir, ".git"));
  const nested = join(projectDir, "src");
  await mkdir(nested, { recursive: true });
  expect(findFernDir(nested)).toBeNull();
});

test("findFernDir returns null when there is no .fern/ anywhere up to the git root", async () => {
  // A `.git` at a known point bounds the walk — without one, this test
  // would depend on the real filesystem above os.tmpdir() having no
  // ambient .fern/ anywhere in its ancestry, which isn't guaranteed (and
  // wasn't true on the machine this was written on; see docs/decisions.md).
  await mkdir(join(projectDir, ".git"));
  const nested = join(projectDir, "no", "fern", "here");
  await mkdir(nested, { recursive: true });
  expect(findFernDir(nested)).toBeNull();
});

// A real `.fern/` landed directly under the maintainer's home directory
// during live debugging (see docs/decisions.md) — without the guard
// below, every uninitialized folder under the home dir would have
// looked initialized from that point on. `homeDir` is overridable
// specifically so this is testable without relying on an env-var/
// native-call override of the real home dir, which isn't reliable
// cross-platform (same reasoning as daemon-info.ts's `homeDir` param).

test("findFernDir never treats a .fern/ directly inside the home dir as a project", async () => {
  await mkdir(join(projectDir, ".fern"));
  expect(findFernDir(projectDir, projectDir)).toBeNull();
});

test("findFernDir stops at the home dir boundary even when a nested folder under it is otherwise uninitialized", async () => {
  await mkdir(join(projectDir, ".fern"));
  const nested = join(projectDir, "some", "unrelated", "scratch dir");
  await mkdir(nested, { recursive: true });
  // Without the home-dir guard this would incorrectly find
  // projectDir/.fern while walking up from `nested`.
  expect(findFernDir(nested, projectDir)).toBeNull();
});

test("findFernDir still finds a real project .fern/ below the home dir, as long as it isn't the home dir itself", async () => {
  const home = join(projectDir, "home");
  const project = join(home, "my-project");
  await mkdir(join(project, ".fern"), { recursive: true });
  expect(findFernDir(project, home)).toBe(join(project, ".fern"));
});

test("findFernDir's home-dir comparison is case-insensitive on Windows", () => {
  if (process.platform !== "win32") return;
  const upper = projectDir.toUpperCase();
  expect(findFernDir(projectDir, upper)).toBeNull();
});
