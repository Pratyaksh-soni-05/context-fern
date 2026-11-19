// The from-source dev flow, end to end. hooks.json and plugin.json run
// `context-fern` by bare name (exec form: PATH lookup, no shell), so a
// source checkout only works if `bun link --global` in packages/cli
// really puts a runnable `context-fern` on PATH. hook-subprocess.test.ts
// spawns `bun run src/index.ts` and so would pass even if that link were
// broken; this one links into a throwaway BUN_INSTALL (the developer's
// real global bin directory is never touched) and then drives the linked
// name the way Claude Code does — bare name, PATH, JSON on stdin.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME } from "@context-fern/core";
import {
  closeAllProjects,
  type DaemonHandle,
  getOrOpenProject,
  startDaemon,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";

const CLI_PACKAGE_DIR = join(import.meta.dir, "../..");
const EXE = process.platform === "win32" ? ".exe" : "";

let bunInstall: string;
let fakeHome: string;
let projectDir: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle;

beforeAll(async () => {
  bunInstall = await mkdtemp(join(tmpdir(), "fern-bun-install-"));
  const link = Bun.spawn({
    cmd: ["bun", "link", "--global"],
    cwd: CLI_PACKAGE_DIR,
    env: { ...process.env, BUN_INSTALL: bunInstall },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await link.exited).toBe(0);

  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });

  // The project path contains a space, the real reported Windows failure.
  const base = join(tmpdir(), `fern link test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
  await mkdir(join(projectDir, ".fern"), { recursive: true });
  await getOrOpenProject(projectDir);
}, 120_000);

afterAll(async () => {
  await daemon?.stop();
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await closeAllProjects();
  await rm(bunInstall, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

// Async spawn: the daemon runs in this same process, so a synchronous
// spawn would block the event loop it needs to answer the child.
async function run(
  args: string[],
  stdin?: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [CLI_BINARY_NAME, ...args], // bare name, resolved through PATH only
    cwd: projectDir,
    env: {
      ...process.env,
      FERN_HOME: fakeHome,
      PATH: `${join(bunInstall, "bin")}${delimiter}${process.env.PATH}`,
    },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    const sink = proc.stdin as NonNullable<typeof proc.stdin>;
    sink.write(JSON.stringify(stdin));
    await sink.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", name), "utf-8"),
  );
}

test("bun link --global puts both context-fern and fern on the PATH as real executables", () => {
  for (const name of [CLI_BINARY_NAME, CLI_NAME]) {
    expect(existsSync(join(bunInstall, "bin", `${name}${EXE}`))).toBe(true);
  }
});

test("the linked context-fern answers a UserPromptSubmit hook by bare name, and the Stop hook records the turn", async () => {
  const prompt = await run(["hook", "UserPromptSubmit"], {
    ...fixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "fix the login bug in the auth module",
  });
  expect(prompt.exitCode).toBe(0);
  expect(
    JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext,
  ).toContain("Active frond");

  const stop = await run(["hook", "Stop"], {
    ...fixture("stop.json"),
    cwd: projectDir,
  });
  expect(stop.exitCode).toBe(0);

  const status = await run(["status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("1 leaflet");
}, 60_000);

test("the linked context-fern also serves the fern-fallback and doctor subcommands the plugin points at", async () => {
  expect((await run(["fern-fallback"])).exitCode).toBe(0);
  const doctor = await run(["doctor"]);
  // doctor exits 1 on any problem (for example no model downloaded on a clean CI
  // machine), so health is not what this test is about: the linked binary must
  // serve the subcommand and print the report.
  expect([0, 1]).toContain(doctor.exitCode);
  expect(doctor.stdout).toContain("context-fern: on PATH");
}, 60_000);
