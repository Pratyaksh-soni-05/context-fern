// `fern daemon stop` as a user runs it, against a real hung stand-in process:
// what it prints and whether the process survives. The checks themselves are
// covered in packages/daemon/test/stop-hung-daemon.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDaemonInfo } from "@context-fern/daemon";
import { buildId } from "../../daemon/src/build-id";

const CLI = join(import.meta.dir, "../src/index.ts");
const HUNG = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
console.log(s.port);
setInterval(() => {}, 1e6);
`;

let work: string;
let home: string;
let savedHome: string | undefined;
const children: { kill: () => void; exited: Promise<unknown> }[] = [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function start(fileName: string) {
  const dir = mkdtempSync(join(work, "p-"));
  writeFileSync(join(dir, fileName), HUNG);
  const child = Bun.spawn({
    cmd: ["bun", "run", join(dir, fileName)],
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
  return { pid: child.pid, port: Number(text.trim()) };
}

async function stopViaCli() {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, "daemon", "stop"],
    env: { ...process.env, FERN_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), exitCode };
}

const record = (pid: number, port: number) =>
  writeDaemonInfo({
    port,
    pid,
    token: "t",
    startedAt: new Date().toISOString(),
    buildId: buildId(),
  });

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fern-stop-cli-"));
  home = join(work, "home");
  mkdirSync(home);
  savedHome = process.env.FERN_HOME;
  process.env.FERN_HOME = home;
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

test("a hung daemon: `fern daemon stop` says it was not answering and was stopped, and it is gone", async () => {
  const hung = await start("serve-entrypoint.ts");
  await record(hung.pid, hung.port);

  const out = await stopViaCli();

  expect(out.exitCode).toBe(0);
  expect(out.stdout).toBe(
    `fern ▸ daemon (pid ${hung.pid}) was not answering and was stopped`,
  );
  expect(alive(hung.pid)).toBe(false);
}, 60_000);

test("a recycled pid: it does not say 'not running' about a program that is running, names it, and leaves it alone", async () => {
  const other = await start("unrelated.ts");
  await record(other.pid, other.port);

  const out = await stopViaCli();

  expect(out.stdout).toContain(
    "daemon not running (removed a stale daemon.json;",
  );
  expect(out.stdout).toContain(
    `pid ${other.pid} now belongs to another program`,
  );
  expect(out.stdout).toContain("unrelated.ts");
  expect(out.stdout).toContain("was not touched");
  expect(alive(other.pid)).toBe(true);
}, 60_000);

test("an alive pid that cannot be confirmed as the daemon: it says what it found, that nothing was stopped, and keeps daemon.json", async () => {
  const lookalike = await start("serve-entrypoint.ts");
  const elsewhere = await start("unrelated.ts");
  await record(lookalike.pid, elsewhere.port);

  const out = await stopViaCli();

  expect(out.stdout).toContain(
    `daemon not stopped: daemon.json names pid ${lookalike.pid}, which is running but does not answer`,
  );
  expect(out.stdout).toContain(`does not hold port ${elsewhere.port}`);
  expect(out.stdout).toContain("nothing was stopped and daemon.json was kept");
  expect(out.stdout).not.toContain("not running");
  expect(alive(lookalike.pid)).toBe(true);
}, 60_000);
