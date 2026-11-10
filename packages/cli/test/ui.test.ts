// `fern ui`'s CLI entrypoint: the one-time code never appears in what
// gets printed, the browser is opened at the right URL, and (when run
// from inside an already-initialized project) the recent-projects
// registry gets touched — all without a real browser or the real home
// dir. Never touches the real home dir — every run isolates via a temp
// FERN_HOME.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllProjects,
  type DaemonHandle,
  listRecentProjects,
  startDaemon,
} from "@context-fern/daemon";
import { canonicalizeProjectPath } from "@context-fern/daemon/client";
import { FakeEmbedder } from "@context-fern/embed";
import { openFernStore } from "@context-fern/store";
import { runUi } from "../src/commands/ui";

let fakeHome: string;
let originalFernHome: string | undefined;
let originalCwd: string;
let daemon: DaemonHandle | undefined;
let projectDir: string;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });

  originalCwd = process.cwd();
  const base = join(tmpdir(), `fern ui-cli test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  await daemon?.stop();
  daemon = undefined;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  await closeAllProjects();
});

test("runUi opens the browser at /ui with a one-time code in the fragment, and never prints the code itself", async () => {
  process.chdir(projectDir); // no .fern/ here — runUi must still work, just skip the touch

  let openedUrl: string | undefined;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await runUi((url) => {
      openedUrl = url;
    });
  } finally {
    console.log = originalLog;
  }

  expect(openedUrl).toBeDefined();
  const match = /^http:\/\/127\.0\.0\.1:\d+\/ui#code=(.+)$/.exec(
    openedUrl ?? "",
  );
  expect(match).not.toBeNull();
  const code = match?.[1] ?? "";
  expect(code.length).toBeGreaterThan(0);

  // The printed receipt names the daemon URL but never the code itself.
  expect(logs.some((l) => l.includes("opening fern ui"))).toBe(true);
  expect(logs.some((l) => l.includes(code))).toBe(false);
});

test("runUi touches the recent-projects registry for an already-initialized project it's run from inside", async () => {
  const fernDir = join(projectDir, ".fern");
  const store = await openFernStore(fernDir);
  store.close();
  process.chdir(projectDir);

  await runUi(() => {});

  const projects = await listRecentProjects(fakeHome);
  expect(
    projects.some((p) => p.path === canonicalizeProjectPath(projectDir)),
  ).toBe(true);
});

test("runUi never creates .fern/ for an uninitialized project it's run from inside", async () => {
  process.chdir(projectDir);
  await runUi(() => {});

  await expect(access(join(projectDir, ".fern"))).rejects.toThrow();
});
