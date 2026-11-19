// `fern doctor` printed nothing at all on Windows during dogfooding —
// traced to an unbounded `isAlive()` call (no AbortSignal) that could
// hang indefinitely against a dead/wrong daemon.json entry, so the
// function never reached its own console.log. Fixed by bounding every
// isAlive() call in this package; this test pins "doctor always prints
// something, and does so promptly" rather than any specific line,
// since the model-cache and stage2 lines depend on real machine state
// this test doesn't control.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDoctorDeps, runDoctor } from "../src/commands/doctor";

let fakeHome: string;
let originalFernHome: string | undefined;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
});

afterEach(async () => {
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
});

async function runDoctorCapturingLogs(): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    // Never the real `claude`, even for a read-only list.
    await runDoctor(
      {},
      { ...realDoctorDeps(), runner: async () => ({ ok: false, output: "" }) },
    );
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test("fern doctor always prints a non-empty report, with no daemon.json present", async () => {
  const logs = await runDoctorCapturingLogs();
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.join("\n").length).toBeGreaterThan(0);
  expect(logs.join("\n")).toContain("daemon:");
});

test("fern doctor reports whether context-fern is on PATH, with the one command that fixes it when it is not", async () => {
  const originalPath = process.env.PATH;
  const shimDir = await mkdtemp(join(tmpdir(), "fern-shim-"));
  const name =
    process.platform === "win32" ? "context-fern.exe" : "context-fern";
  try {
    process.env.PATH = shimDir; // nothing on it
    const missing = (await runDoctorCapturingLogs()).join("\n");
    expect(missing).toContain("context-fern: not on PATH");
    expect(missing).toContain('run "bun link --global" in packages/cli');

    await Bun.write(join(shimDir, name), "");
    if (process.platform !== "win32") {
      await Bun.spawn(["chmod", "+x", join(shimDir, name)]).exited;
    }
    expect((await runDoctorCapturingLogs()).join("\n")).toContain(
      `context-fern: on PATH (${join(shimDir, name)})`,
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDir, { recursive: true, force: true });
  }
});

test("fern doctor completes promptly (doesn't hang) even with a daemon.json pointing at a dead pid/port", async () => {
  const { writeDaemonInfo } = await import("@context-fern/daemon");
  await writeDaemonInfo({
    port: 1, // nothing real ever listens on port 1
    pid: 999999,
    token: "x",
    startedAt: new Date().toISOString(),
    buildId: "stale",
  });

  const start = Date.now();
  const logs = await runDoctorCapturingLogs();
  expect(Date.now() - start).toBeLessThan(10_000);
  expect(logs.join("\n")).toContain("not running");
}, 15_000);
