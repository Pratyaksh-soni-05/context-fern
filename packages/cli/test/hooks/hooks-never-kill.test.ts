// Hooks must never kill anything on the strength of a daemon that does not
// answer. The only place a hung daemon is stopped is `fern daemon stop`
// (stopRunningDaemon with killUnresponsive). (A daemon of an older build that
// DOES answer and proves it is ours can still be stopped by isDaemonRunning;
// that verified path is older than this one and is not what this file is about.) Proven two ways: the hook sources
// do not contain any way to stop a process or reach that option, and real hooks
// run against a real hung stand-in daemon leave it alive.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonInfo, writeDaemonInfo } from "@context-fern/daemon";
import { stopRunningDaemon } from "@context-fern/daemon/client";
import { buildId } from "../../../daemon/src/build-id";
import {
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
} from "../../src/hooks/hook-handlers";

const HOOKS_DIR = join(import.meta.dir, "../../src/hooks");

test("no hook source can stop a process or reach the unresponsive-daemon kill", () => {
  const forbidden = [
    "process.kill",
    "stopRunningDaemon",
    "killUnresponsive",
    "inspectDaemonProcess",
    "taskkill",
    "SIGKILL",
    "Stop-Process",
  ];
  const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(3);
  for (const f of files) {
    const text = readFileSync(join(HOOKS_DIR, f), "utf-8");
    for (const word of forbidden)
      expect(text, `${f}: ${word}`).not.toContain(word);
  }
});

const HUNG = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
console.log(s.port);
setInterval(() => {}, 1e6);
`;
let work: string;
let projectDir: string;
let savedHome: string | undefined;
const children: { kill: () => void; exited: Promise<unknown> }[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fern-hooks-kill-"));
  savedHome = process.env.FERN_HOME;
  process.env.FERN_HOME = join(work, "home");
  mkdirSync(process.env.FERN_HOME);
  projectDir = join(work, "proj");
  mkdirSync(join(projectDir, ".fern"), { recursive: true });
});
afterEach(async () => {
  const running = children.splice(0);
  for (const c of running) c.kill();
  await Promise.all(running.map((c) => c.exited)); // a killed process holds its directory until it is gone
  if (savedHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = savedHome;
  rmSync(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

test("every hook run against a hung daemon that looks exactly like ours, current build or stale, leaves it running", async () => {
  // A real hung process whose command line is the source daemon form.
  const dir = join(work, "daemon");
  mkdirSync(dir);
  writeFileSync(join(dir, "serve-entrypoint.ts"), HUNG);
  const child = Bun.spawn({
    cmd: ["bun", "run", join(dir, "serve-entrypoint.ts")],
    cwd: dir,
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push({ kill: () => child.kill(), exited: child.exited });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = Number(text.trim());

  // Spawning a replacement is not what is under test, and the real one binds the real port.
  const noSpawn = { spawnDaemonDetached: () => {} };
  for (const build of [buildId(), "an-older-build"]) {
    await writeDaemonInfo({
      port,
      pid: child.pid,
      token: "t",
      startedAt: new Date().toISOString(),
      buildId: build,
    });
    const base = { session_id: "s1", cwd: projectDir };
    await handleSessionStart(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      noSpawn,
    );
    const resumed = await handleSessionStart(
      { ...base, hook_event_name: "SessionStart", source: "resume" },
      noSpawn,
    );
    // Not vacuous: against the current build the hook really did try the daemon and gave up on it.
    if (build === buildId())
      expect(resumed.systemMessage).toContain("couldn't restore");
    await handleUserPromptSubmit(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "add a badge" },
      noSpawn,
    );
    await handleUserPromptSubmit(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "/fern status" },
      noSpawn,
    );
    await handlePostToolUse({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(projectDir, "a.txt"), content: "x" },
    });
    await handleStop({
      ...base,
      hook_event_name: "Stop",
      last_assistant_message: "done",
      stop_reason: "end_turn",
    });
    expect(alive(child.pid), `build ${build}`).toBe(true);
    // And its record survives, even for a stale build, so `fern daemon stop` can still find it.
    expect(await readDaemonInfo(), `build ${build}`).not.toBeNull();
  }
  // The way out is still there after all of that: `fern daemon stop` stops it.
  const stopped = await stopRunningDaemon(5000, { killUnresponsive: true });
  expect(stopped.state).toBe("unresponsive-stopped");
  expect(alive(child.pid)).toBe(false);
}, 120_000);
