// `fern mode isolate` and `/fern mode isolate` must say that isolate mode is
// not available in this release and fail, never silently become suggest. They
// are refused before any daemon is started, so each test runs against an empty
// FERN_HOME and checks that no daemon came up.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import { readDaemonInfo } from "@context-fern/daemon";
import { dispatchFernCommand } from "../src/hooks/fern-dispatch";

const CLI_ENTRYPOINT = join(import.meta.dir, "../src/index.ts");
let fakeHome: string;
let workDir: string;
let originalFernHome: string | undefined;

beforeAll(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-mode-home-"));
  workDir = await mkdtemp(join(tmpdir(), "fern-mode-work-"));
  process.env.FERN_HOME = fakeHome;
});

afterAll(async () => {
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

function runCli(args: string[]) {
  const res = Bun.spawnSync(["bun", CLI_ENTRYPOINT, ...args], {
    cwd: workDir,
    env: { ...process.env, FERN_HOME: fakeHome },
  });
  return {
    code: res.exitCode,
    out: res.stdout.toString(),
    err: res.stderr.toString(),
  };
}

test("`fern mode isolate` exits 1 and says isolate mode is not available in this release", async () => {
  const res = runCli(["mode", "isolate"]);
  expect(res.code).toBe(1);
  expect(res.err).toContain("isolate mode is not available in this release");
  expect(res.err).toContain(`${CLI_NAME} mode suggest`);
  expect(res.out).not.toContain("mode isolate");
  expect(await readDaemonInfo()).toBeNull();
}, 30_000);

test("`fern mode` with nothing, or with something that is not a mode, exits 1 and names the modes", async () => {
  const none = runCli(["mode"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("observe|suggest");
  expect(none.err).not.toContain("isolate");

  const bad = runCli(["mode", "bogus"]);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("is not a mode");
  expect(await readDaemonInfo()).toBeNull();
}, 30_000);

test("/fern mode isolate answers that isolate mode is not available, without waking a daemon", async () => {
  const receipt = await dispatchFernCommand({
    projectPath: workDir,
    rest: ["mode", "isolate"],
    ensureDaemon: true,
  });
  expect(receipt).toContain("isolate mode is not available in this release");
  expect(receipt).not.toContain("▸ mode isolate");
  expect(await readDaemonInfo()).toBeNull();
});
