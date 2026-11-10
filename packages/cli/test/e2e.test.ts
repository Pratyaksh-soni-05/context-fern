// Real end-to-end: spawns the actual `fern` CLI as subprocesses (not
// in-process function calls) against a real daemon the CLI itself
// starts — proving the whole pipeline (CLI -> spawn daemon -> HTTP ->
// store -> SQLite) works, not just its pieces in isolation. Slow (real
// ONNX model load on first call) by nature, like the daemon's own
// latency test.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentProjects, readDaemonInfo } from "@context-fern/daemon";
import { canonicalizeProjectPath } from "@context-fern/daemon/client";

const CLI_ENTRYPOINT = join(import.meta.dir, "../src/index.ts");

let fakeHome: string;
let projectDir: string;
let originalFernHome: string | undefined;

beforeAll(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome; // so readDaemonInfo() in this process agrees with the spawned CLI's env
  // the project path itself contains a space — the real reported failure mode.
  const base = join(tmpdir(), `fern e2e test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
});

afterAll(async () => {
  // best-effort: stop whatever daemon this test started
  await runCli(["daemon", "stop"]);
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CLI_ENTRYPOINT, ...args],
    cwd: projectDir,
    env: { ...process.env, FERN_HOME: fakeHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

test("fern init creates .fern/config.toml and skips .gitignore with --no", async () => {
  const res = runCli(["init", "--no"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("created .fern/config.toml");

  const configText = await Bun.file(
    join(projectDir, ".fern", "config.toml"),
  ).text();
  expect(configText).toContain("[thresholds]");
}, 30_000);

test("fern init also materializes .fern/fern.db and registers the project in ~/.fern/projects.json — fern ui's Start screen requires both", async () => {
  // Reuses the same projectDir the previous test already ran `fern init`
  // against — this checks the materialize step's own effects, not init
  // itself (already covered above).
  const dbExists = await Bun.file(
    join(projectDir, ".fern", "fern.db"),
  ).exists();
  expect(dbExists).toBe(true);

  const projects = await listRecentProjects(fakeHome);
  expect(
    projects.some((p) => p.path === canonicalizeProjectPath(projectDir)),
  ).toBe(true);
}, 30_000);

test("fern new creates a frond (spawning the daemon on first use)", async () => {
  const res = runCli(["new", "docker-build"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("fern ▸ on docker-build");

  const info = await readDaemonInfo();
  expect(info).not.toBeNull();
}, 60_000); // first call pays the real ONNX model load

test("fern tree shows the new frond as active, under the stem", () => {
  const res = runCli(["tree"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("docker-build");
  expect(res.stdout).toContain("active");
  expect(res.stdout).toContain("roots: 0 memories");
}, 30_000);

test("fern undo removes the frond", () => {
  const undo = runCli(["undo"]);
  expect(undo.exitCode).toBe(0);
  expect(undo.stdout).toContain("fern ▸ undone");

  const tree = runCli(["tree"]);
  expect(tree.stdout).not.toContain("docker-build");
}, 30_000);

test("fern daemon status reports running, then fern daemon stop removes daemon.json", async () => {
  const status = runCli(["daemon", "status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("running");

  const stop = runCli(["daemon", "stop"]);
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toContain("stopped");

  expect(await readDaemonInfo()).toBeNull();
}, 30_000);
