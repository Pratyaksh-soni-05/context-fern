// Proves test/preload.ts's env redirection is actually active — not
// just declared in bunfig.toml — and that every currently-known
// home-resolving function in this repo honors it when called with no
// explicit override, the exact failure mode behind the real incident
// documented in docs/decisions.md (2026-10-27): a code path fell
// through to a default `homedir()` with nothing injected, and it
// silently wrote into the maintainer's real ~/.claude/settings.json.
//
// Deliberately does NOT assert on `homedir()` itself returning the fake
// value — that call is not reliably patchable/env-sensitive across
// platforms in Bun (see test/preload.ts's module doc for the CI
// evidence). What's actually reliable, and what every guarded function
// checks first, is the plain env var `FERN_HOME`.
//
// If this file fails, do not relax it — find out why a path resolves
// into the real home dir and fix that instead.

import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runStatusline } from "../packages/cli/src/commands/statusline";
import { daemonInfoPath } from "../packages/daemon/src/daemon-info";

const REAL_HOME = process.env.__FERN_TEST_REAL_HOME__;
const FAKE_HOME = process.env.__FERN_TEST_FAKE_HOME__;

function assertOutsideRealHome(label: string, path: string): void {
  if (!REAL_HOME) return; // preload didn't run (e.g. this file invoked standalone) — nothing to check against
  expect(
    path.toLowerCase().startsWith(REAL_HOME.toLowerCase()),
    `${label} resolved to "${path}", which is inside the REAL home dir (${REAL_HOME}). A path fell through to an unoverridden default — see docs/decisions.md.`,
  ).toBe(false);
}

afterEach(async () => {
  if (FAKE_HOME) {
    await rm(join(FAKE_HOME, ".claude", "settings.json"), { force: true });
  }
});

test("test/preload.ts actually ran: HOME/USERPROFILE/FERN_HOME no longer point at the real home dir", () => {
  if (!REAL_HOME || !FAKE_HOME) {
    throw new Error(
      "test/preload.ts didn't run — __FERN_TEST_REAL_HOME__/__FERN_TEST_FAKE_HOME__ are unset. Check bunfig.toml's [test].preload.",
    );
  }
  expect(FAKE_HOME).not.toBe(REAL_HOME);
  expect(process.env.HOME).toBe(FAKE_HOME);
  expect(process.env.USERPROFILE).toBe(FAKE_HOME);
  expect(process.env.FERN_HOME).toBe(FAKE_HOME);
});

test("daemonInfoPath() called with no override never resolves into the real home dir", () => {
  assertOutsideRealHome("daemonInfoPath()", daemonInfoPath());
});

test("runStatusline() called with no homeDir override writes under FERN_HOME, never the real home dir — the exact function behind the real incident", async () => {
  if (!REAL_HOME || !FAKE_HOME) throw new Error("test/preload.ts didn't run");

  await runStatusline({ install: "true" }); // no third argument — simulates the exact call that caused the incident

  const written = await readFile(
    join(FAKE_HOME, ".claude", "settings.json"),
    "utf-8",
  );
  expect(JSON.parse(written).statusLine).toBeTruthy();
  assertOutsideRealHome(
    "runStatusline()'s default homeDir",
    join(FAKE_HOME, ".claude", "settings.json"),
  );
});

// modelCacheDir() (packages/embed) is deliberately NOT covered here —
// LOCALAPPDATA/XDG_CACHE_HOME are intentionally left unredirected (see
// test/preload.ts) so real-embedder tests reuse the actual downloaded
// model cache instead of a fresh ~25MB download every run. It's a
// large, non-sensitive, reusable binary cache, not "config" in the
// sense that caused the real incident this guard exists for.
