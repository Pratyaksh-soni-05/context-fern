// The `context-fern hook <event>` and `context-fern fern-fallback`
// subcommands as real OS subprocesses (not in-process function calls) —
// proving stdin JSON in, stdout JSON out, and exit code 0 actually work
// across a process boundary, and that a project path containing a space
// (the real reported Windows failure mode, see docs/decisions.md)
// survives the whole round trip. hook-handlers.test.ts already covers
// the handlers' own logic in depth; this file is deliberately narrow —
// one happy-path check per event, plus the two true end-to-end flows
// that only a real process boundary ever caught. Spawns `bun run
// packages/cli/src/index.ts ...` rather than a compiled `context-fern`
// binary — there's no compiled artifact in a test run, and this already
// exercises the real subcommand dispatch (argv parsing, stdin/stdout
// framing, exit code) as a genuine separate process; the PR 1 spike
// already covers whether a *compiled* binary behaves the same way.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import {
  closeAllProjects,
  type DaemonHandle,
  getOrOpenProject,
  startDaemon,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";

// Fixture payloads with the real stdin shape from a live `claude --debug`
// run on 2.1.312, synthetic values — see hook-handlers.test.ts's loadFixture doc comment.
// biome-ignore lint/suspicious/noExplicitAny: JSON.parse's return type.
function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", name), "utf-8"),
  );
}

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

  // The project path itself contains a space — the real reported
  // Windows failure mode (see docs/decisions.md).
  const base = join(tmpdir(), `fern scripts test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
  await mkdir(join(projectDir, ".fern"), { recursive: true });
  // Pre-warm the project's SQLite file/schema outside the timed window —
  // a cold first open can be slow enough to blow the hooks' internal
  // 300ms budget, which is about hook responsiveness, not store setup.
  await getOrOpenProject(projectDir);
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

const CLI_ENTRYPOINT = join(import.meta.dir, "../../src/index.ts");

// Bun.spawnSync would block this process's event loop while the daemon
// above runs in-process in this same test file — the daemon's Bun.serve
// needs that very event loop to answer the subprocess's request, so a
// synchronous spawn here would deadlock (the child connects and sends
// its request, but nothing is left to run the server's fetch handler
// and write a response). Bun.spawn (async) keeps the parent's event
// loop free the whole time.
async function runCli(
  args: string[],
  stdin?: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRYPOINT, ...args],
    env: { ...process.env, FERN_HOME: fakeHome },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    // Non-null: this branch only runs when stdio above was "pipe", not
    // "ignore", so proc.stdin is always a real FileSink here.
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

function runHook(
  event: string,
  stdin: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCli(["hook", event], stdin);
}

test("context-fern hook UserPromptSubmit round-trips a plain prompt against the real daemon", async () => {
  const res = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
  });
  expect(res.exitCode).toBe(0);
  const output = JSON.parse(res.stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
}, 15_000);

test("context-fern hook UserPromptSubmit blocks a '/fern status' command with zero model turns", async () => {
  const res = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
  });
  expect(res.exitCode).toBe(0);
  const output = JSON.parse(res.stdout);
  expect(output.decision).toBe("block");
  expect(output.reason).toStartWith("fern ▸ ");
}, 15_000);

test("context-fern hook PostToolUse exits 0 with an empty result for a passive tool call", async () => {
  const res = await runHook("PostToolUse", {
    ...loadFixture("post-tool-use.read.json"),
    cwd: projectDir,
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts" },
  });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({});
}, 15_000);

test("context-fern hook Stop exits 0 with an empty result when nothing is pending", async () => {
  const res = await runHook("Stop", {
    ...loadFixture("stop.json"),
    cwd: projectDir,
    last_assistant_message: "done",
  });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({});
}, 15_000);

test("context-fern hook SessionStart exits 0 with an empty result on startup", async () => {
  const res = await runHook("SessionStart", {
    ...loadFixture("session-start.startup.json"),
    cwd: projectDir,
  });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({});
}, 15_000);

test("statusline.ts prints the exact spec format ('fern ▸ <frond> · <n> fronds · <s> strays'), reading cwd from stdin JSON like Claude Code's real statusLine protocol", async () => {
  await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new greetings",
  });

  const entrypoint = join(
    import.meta.dir,
    "../../../plugin-claude-code/scripts/statusline.ts",
  );
  const proc = Bun.spawn({
    cmd: ["bun", "run", entrypoint],
    env: { ...process.env, FERN_HOME: fakeHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The real protocol: JSON session data on stdin, including cwd —
  // confirmed against the current docs, see docs/decisions.md.
  proc.stdin.write(JSON.stringify({ session_id: "s1", cwd: projectDir }));
  await proc.stdin.end();
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(`${CLI_NAME} ▸ greetings · 1 frond · 0 strays`);
}, 15_000);

// context-fern fern-fallback's only remaining job: report that the hook
// didn't run, plus daemon status — it takes no argv at all, the same
// fixed-literal contract fern-command.ts --fallback had (see
// docs/decisions.md on why the old argument-passing design was removed
// rather than hardened).
test("true end-to-end: real spawned UserPromptSubmit -> PostToolUse -> Stop subprocesses fill the brief on disk, read directly from the filesystem", async () => {
  // Every piece here is a real OS process talking to a real (if
  // FakeEmbedder-backed) daemon over real HTTP — not an in-process
  // function call — specifically because an earlier round's brief-fill
  // tests all passed this way while the real, interactive flow still
  // left the brief empty (see docs/decisions.md): a real duplicate
  // /fern new wiped it back to blank, a bug no in-process test ever
  // exercised the code path for.
  const created = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new greetings",
  });
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).reason).toContain("fern ▸ on greetings");

  const prompt1 = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "lets wire up a friendly hello world greeting page",
  });
  expect(prompt1.exitCode).toBe(0);

  const touched = await runHook("PostToolUse", {
    ...loadFixture("post-tool-use.read.json"),
    cwd: projectDir,
    tool_name: "Write",
    tool_input: { file_path: join(projectDir, "index.html"), content: "x" },
  });
  expect(touched.exitCode).toBe(0);

  const stop1 = await runHook("Stop", {
    ...loadFixture("stop.json"),
    cwd: projectDir,
  });
  expect(stop1.exitCode).toBe(0);

  // A second real prompt + Stop — finalizeExchange runs defensively at
  // the top of the next /prompt too, but going through the real
  // UserPromptSubmit -> Stop pair again is what the dogfood session
  // actually did ("4 prompts"), so that's what this exercises.
  const prompt2 = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "now add some css styling",
  });
  expect(prompt2.exitCode).toBe(0);
  const stop2 = await runHook("Stop", {
    ...loadFixture("stop.json"),
    cwd: projectDir,
  });
  expect(stop2.exitCode).toBe(0);

  const briefPath = join(projectDir, ".fern", "fronds", "greetings.md");
  const briefText = readFileSync(briefPath, "utf-8");
  expect(briefText).toContain(
    "lets wire up a friendly hello world greeting page",
  );
  expect(briefText).toContain("index.html");
  expect(briefText).toContain("now add some css styling");
}, 20_000);

test("true end-to-end regression: a real duplicate '/fern new greetings' never wipes the real content already there", async () => {
  await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new greetings",
  });
  await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "lets wire up a friendly hello world greeting page",
  });
  await runHook("Stop", {
    ...loadFixture("stop.json"),
    cwd: projectDir,
  });

  const briefPath = join(projectDir, ".fern", "fronds", "greetings.md");
  expect(readFileSync(briefPath, "utf-8")).toContain(
    "lets wire up a friendly hello world greeting page",
  );

  // The exact dogfood sequence: typing "/fern new greetings" again,
  // once real content already exists.
  const duplicate = await runHook("UserPromptSubmit", {
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new greetings",
  });
  expect(JSON.parse(duplicate.stdout).reason).toBe(
    "fern ▸ greetings already exists · switched",
  );
  expect(readFileSync(briefPath, "utf-8")).toContain(
    "lets wire up a friendly hello world greeting page",
  );
}, 20_000);

test("context-fern fern-fallback reports the hook didn't run, plus daemon status", async () => {
  const res = await runCli(["fern-fallback"]);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain(`the ${CLI_NAME} hook didn't run`);
  expect(res.stdout).toContain("daemon running on 127.0.0.1:");
}, 15_000);
