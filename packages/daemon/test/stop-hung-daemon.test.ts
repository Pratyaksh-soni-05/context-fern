// `fern daemon stop` on a daemon that accepts connections and never answers.
// A hung daemon cannot prove it is ours by answering, so it is judged by its
// process: the command line must be one of the two ways we start a daemon and
// the port in daemon.json must be listened on by that same pid. Driven with
// real hung processes in both command-line forms (a source daemon and a
// compiled binary), and with unrelated processes standing in for a recycled pid.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_BINARY_NAME } from "@context-fern/core";
import { buildId } from "../src/build-id";
import { stopRunningDaemon } from "../src/client";
import { readDaemonInfo, writeDaemonInfo } from "../src/daemon-info";
import {
  isDaemonCommandLine,
  type ProcessInspector,
  Undetermined,
} from "../src/process-inspect";

const HUNG = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
console.log(s.port);
setInterval(() => {}, 1e6);
`;

let work: string;
let fakeHome: string;
let compiledExe: string;
const children: { kill: () => void }[] = [];
const saved: Record<string, string | undefined> = {};

const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    if (text.includes("\n")) break;
  }
  reader.releaseLock();
  return text.split("\n")[0]?.trim() ?? "";
}

/** A real process that listens on a port and never answers. */
async function startHung(cmd: string[], cwd: string) {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "ignore" });
  children.push({ kill: () => child.kill() });
  const port = Number(await firstLine(child.stdout));
  if (!Number.isInteger(port))
    throw new Error(`stand-in printed no port: ${cmd.join(" ")}`);
  return { pid: child.pid, port, kill: () => child.kill() };
}

/** `bun run <dir>/serve-entrypoint.ts`: the source form of a daemon's command line. */
async function startHungSourceDaemon() {
  const dir = mkdtempSync(join(work, "src-"));
  writeFileSync(join(dir, "serve-entrypoint.ts"), HUNG);
  return startHung(["bun", "run", join(dir, "serve-entrypoint.ts")], dir);
}

/** An unrelated program that listens on a port: standing in for whatever now owns a recycled pid. */
async function startUnrelated() {
  const dir = mkdtempSync(join(work, "other-"));
  writeFileSync(join(dir, "unrelated.ts"), HUNG);
  return startHung(["bun", "run", join(dir, "unrelated.ts")], dir);
}

function record(pid: number, port: number) {
  return writeDaemonInfo({
    port,
    pid,
    token: "t",
    startedAt: new Date().toISOString(),
    buildId: buildId(),
  });
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "fern-hung-work-"));
  // A real compiled binary named like ours, for the `<exe> --internal-daemon` form.
  const dir = join(work, "compiled");
  mkdirSync(dir);
  writeFileSync(join(dir, "hung.ts"), HUNG);
  compiledExe = join(
    dir,
    process.platform === "win32" ? `${CLI_BINARY_NAME}.exe` : CLI_BINARY_NAME,
  );
  const built = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "--compile",
      join(dir, "hung.ts"),
      "--outfile",
      compiledExe,
    ],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0)
    throw new Error(
      `could not compile the stand-in: ${built.stderr.toString()}`,
    );
}, 180_000);

afterAll(() => {
  rmSync(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}, 60_000);

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "fern-hung-home-"));
  for (const k of ["FERN_HOME"]) saved[k] = process.env[k];
  process.env.FERN_HOME = fakeHome;
});

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await mkdir(fakeHome, { recursive: true });
  await rm(fakeHome, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
});

test("the two ways a daemon is started are recognised, and nothing else is", () => {
  for (const ok of [
    "bun run C:\\repo\\packages\\daemon\\src\\serve-entrypoint.ts",
    'bun run "C:\\Users\\a b\\repo\\packages\\daemon\\src\\serve-entrypoint.ts"',
    '"C:\\Users\\a\\.bun\\bin\\bun.exe" run "C:\\repo\\serve-entrypoint.ts"',
    "bun run /home/u/repo/packages/daemon/src/serve-entrypoint.ts",
    '/usr/local/bin/bun run "/opt/my repo/serve-entrypoint.ts"',
    '"/home/my user/.local/bin/context-fern" --internal-daemon',
    '"/Users/Jo Doe/.local/bin/fern" --internal-daemon',
    '"C:\\Users\\a\\AppData\\Local\\context-fern\\bin\\context-fern.exe" --internal-daemon',
    "C:\\x\\fern.exe --internal-daemon",
    "/home/u/.local/bin/context-fern --internal-daemon",
    "/home/u/.local/bin/fern --internal-daemon",
    "context-fern --internal-daemon",
  ])
    expect(isDaemonCommandLine(ok), ok).toBe(true);
  for (const bad of [
    "bun test packages/daemon",
    "bun run packages/cli/src/index.ts hook Stop",
    "bun run /repo/serve-entrypoint.tsx",
    "bun run /repo/not-serve-entrypoint.ts.bak",
    "node /repo/serve-entrypoint.ts",
    "bun /repo/serve-entrypoint.ts",
    "context-fern hook UserPromptSubmit",
    "context-fern --internal-daemon --extra",
    "evil-context-fern --internal-daemon",
    "/bin/sh -c context-fern --internal-daemon",
    "/bin/sh -c /x/context-fern --internal-daemon",
    "python /x/fern --internal-daemon",
    "bun run /tmp/evil.ts /y/serve-entrypoint.ts",
    "/x/bun run /y/serve-entrypoint.ts --extra",
    "sudo /x/context-fern --internal-daemon",
    "notepad.exe",
    "",
  ])
    expect(isDaemonCommandLine(bad), JSON.stringify(bad)).toBe(false);
});

test("a hung daemon started from source is stopped: the process is gone and daemon.json removed", async () => {
  const hung = await startHungSourceDaemon();
  await record(hung.pid, hung.port);
  expect(exists(hung.pid)).toBe(true);

  const result = await stopRunningDaemon(5000, { killUnresponsive: true });

  expect(result.state).toBe("unresponsive-stopped");
  expect(exists(hung.pid)).toBe(false);
  expect(await readDaemonInfo()).toBeNull();
}, 60_000);

test("a hung compiled daemon (`context-fern --internal-daemon`) is stopped too", async () => {
  const hung = await startHung(
    [compiledExe, "--internal-daemon"],
    join(work, "compiled"),
  );
  await record(hung.pid, hung.port);

  const result = await stopRunningDaemon(5000, { killUnresponsive: true });

  expect(result.state).toBe("unresponsive-stopped");
  expect(exists(hung.pid)).toBe(false);
  expect(await readDaemonInfo()).toBeNull();
}, 60_000);

test("a caller that did not ask for it (hooks, uninstall) never stops a hung daemon: it is reported and left, daemon.json kept", async () => {
  const hung = await startHungSourceDaemon();
  await record(hung.pid, hung.port);

  const result = await stopRunningDaemon();

  expect(result.state).toBe("unresponsive-left");
  if (result.state === "unresponsive-left") {
    expect(result.pid).toBe(hung.pid);
    expect(result.why).toContain("does not answer");
  }
  expect(exists(hung.pid)).toBe(true);
  expect(await readDaemonInfo()).not.toBeNull();
}, 60_000);

test("a stale daemon.json whose pid now belongs to an unrelated program is removed and the program is never touched, even if it holds the recorded port", async () => {
  const other = await startUnrelated();
  // The worst case: the recycled pid's program is also the one listening on the recorded port.
  await record(other.pid, other.port);

  const result = await stopRunningDaemon(5000, { killUnresponsive: true });

  expect(result.state).toBe("stale-removed");
  if (result.state === "stale-removed") {
    expect(result.pidReused?.pid).toBe(other.pid);
    expect(result.pidReused?.commandLine).toContain("unrelated.ts");
  }
  expect(exists(other.pid)).toBe(true);
  expect(await readDaemonInfo()).toBeNull();

  // And the same with the port somewhere else entirely.
  await record(other.pid, 1);
  const again = await stopRunningDaemon(5000, { killUnresponsive: true });
  expect(again.state).toBe("stale-removed");
  expect(exists(other.pid)).toBe(true);
}, 60_000);

test("a process whose command line looks like ours but does not hold the recorded port is not stopped: it is reported and left, daemon.json kept", async () => {
  const lookalike = await startHungSourceDaemon();
  const elsewhere = await startUnrelated(); // the recorded port belongs to someone else
  await record(lookalike.pid, elsewhere.port);

  const result = await stopRunningDaemon(5000, { killUnresponsive: true });

  expect(result.state).toBe("unresponsive-left");
  if (result.state === "unresponsive-left") {
    expect(result.why).toContain(`does not hold port ${elsewhere.port}`);
  }
  expect(exists(lookalike.pid)).toBe(true);
  expect(exists(elsewhere.pid)).toBe(true);
  expect(await readDaemonInfo()).not.toBeNull();
}, 60_000);

test("if a lookup cannot be made, nothing is stopped and what was found is reported", async () => {
  const hung = await startHungSourceDaemon();
  await record(hung.pid, hung.port);
  const broken = (what: "commandLine" | "holdsPort"): ProcessInspector => ({
    commandLine: async () => {
      if (what === "commandLine")
        throw new Undetermined("no permission to read the process");
      return "bun run /x/serve-entrypoint.ts";
    },
    holdsPort: async () => {
      throw new Undetermined("lsof is not available");
    },
  });

  for (const what of ["commandLine", "holdsPort"] as const) {
    const result = await stopRunningDaemon(5000, {
      killUnresponsive: true,
      inspector: broken(what),
    });
    expect(result.state, what).toBe("unresponsive-left");
    if (result.state === "unresponsive-left") {
      expect(result.why, what).toContain(
        what === "commandLine"
          ? "no permission to read the process"
          : "lsof is not available",
      );
    }
    expect(exists(hung.pid), what).toBe(true);
    expect(await readDaemonInfo(), what).not.toBeNull();
  }
}, 60_000);

test("a daemon.json whose pid or port is not a plain positive integer is stale: nothing is looked up or signalled", async () => {
  const bystander = await startUnrelated();
  for (const [pid, port] of [
    [0, 5000],
    [1, 5000],
    [-1, 5000],
    [1.5, 5000],
    ["12", 5000],
    [bystander.pid, 0],
    [bystander.pid, 70000],
    [bystander.pid, "80"],
    [bystander.pid, 2.5],
  ] as const) {
    await writeDaemonInfo({
      port: port as number,
      pid: pid as number,
      token: "t",
      startedAt: new Date().toISOString(),
      buildId: buildId(),
    });
    const result = await stopRunningDaemon(5000, { killUnresponsive: true });
    expect(result, `pid ${pid} port ${port}`).toEqual({
      state: "stale-removed",
    });
    expect(await readDaemonInfo()).toBeNull();
    expect(exists(bystander.pid)).toBe(true);
  }
}, 60_000);

test.skipIf(process.platform === "win32")(
  "a hung daemon that ignores the terminate request is killed after the recheck",
  async () => {
    const dir = mkdtempSync(join(work, "stubborn-"));
    writeFileSync(
      join(dir, "serve-entrypoint.ts"),
      `process.on("SIGTERM", () => {});
${HUNG}`,
    );
    const hung = await startHung(
      ["bun", "run", join(dir, "serve-entrypoint.ts")],
      dir,
    );
    await record(hung.pid, hung.port);

    const result = await stopRunningDaemon(5000, { killUnresponsive: true });

    expect(result.state).toBe("unresponsive-stopped");
    expect(exists(hung.pid)).toBe(false);
  },
  60_000,
);

test("a daemon that is only slow (answers after the first probe, before the second) is not treated as hung", async () => {
  const dir = mkdtempSync(join(work, "slow-"));
  writeFileSync(
    join(dir, "serve-entrypoint.ts"),
    `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => {
  await Bun.sleep(3500);
  return Response.json({ ok: true, projects: [], pid: process.pid, buildId: process.env.SLOW_BUILD });
} });
console.log(s.port);
setInterval(() => {}, 1e6);
`,
  );
  const child = Bun.spawn({
    cmd: ["bun", "run", join(dir, "serve-entrypoint.ts")],
    cwd: dir,
    env: { ...process.env, SLOW_BUILD: buildId() },
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push({ kill: () => child.kill() });
  const port = Number(await firstLine(child.stdout));
  await record(child.pid, port);

  const result = await stopRunningDaemon(5000, { killUnresponsive: true });

  // It answered the second, longer probe, so it was stopped as an ordinary daemon, not as a hung one.
  expect(result.state).toBe("stopped");
  expect(exists(child.pid)).toBe(false);
}, 60_000);

test("a recorded pid that is gone is just a stale file: removed, nothing signalled, no claim about another program", async () => {
  const gone = await startUnrelated();
  gone.kill();
  while (exists(gone.pid)) await Bun.sleep(50);
  await record(gone.pid, gone.port);

  expect(await stopRunningDaemon(5000, { killUnresponsive: true })).toEqual({
    state: "stale-removed",
  });
  expect(await readDaemonInfo()).toBeNull();
}, 60_000);
