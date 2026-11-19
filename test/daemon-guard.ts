// Loaded before every test run (bunfig.toml's [test].preload, after
// preload.ts). A test that starts a daemon must stop it; this fails the run
// when one is still alive after the last test, so a leak is caught where it
// happens instead of showing up days later as a pile of orphaned processes
// that make later runs fail (docs/decisions.md, 2026-11-19).
//
// It only counts daemon processes started from this checkout that were not
// already alive when the run began, so a daemon you are running yourself is
// never touched. Leaked ones are killed and named, and the run fails (the hook
// is a bun:test afterAll, which runs once at the end of the run; process 'exit'
// and 'beforeExit' handlers do not fire in `bun test`).
// FERN_TEST_ALLOW_DAEMON_LEAKS=1 turns the failure into a warning (the kill
// still happens).

import { afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { daemonPids, kill, listProcesses } from "./support/daemon-processes";

const REPO_ROOT = resolve(join(import.meta.dir, ".."));
const before = new Set(daemonPids(listProcesses(), REPO_ROOT));

afterAll(() => {
  const leaked = daemonPids(listProcesses(), REPO_ROOT).filter(
    (pid) => !before.has(pid),
  );
  if (leaked.length === 0) return;
  for (const pid of leaked) kill(pid);
  const message = `${leaked.length} daemon process${leaked.length === 1 ? "" : "es"} started by the tests ${leaked.length === 1 ? "was" : "were"} still running after the last test (pid ${leaked.join(", ")}); killed. Every test that starts a daemon must stop it in afterEach/afterAll.`;
  if (process.env.FERN_TEST_ALLOW_DAEMON_LEAKS === "1") {
    console.error(`warning: ${message}`);
    return;
  }
  throw new Error(message);
});
