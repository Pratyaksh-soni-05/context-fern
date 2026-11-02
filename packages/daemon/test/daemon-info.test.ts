// Every function under test takes the temp home dir as an explicit
// argument — no FERN_HOME env mutation needed here, so there's nothing
// to forget to reset and no path back to the real home dir even if a
// call site drops the argument by mistake (see docs/decisions.md).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonInfoPath,
  deleteDaemonInfo,
  readDaemonInfo,
  writeDaemonInfo,
} from "../src/daemon-info";

let fakeHome: string | undefined;

afterEach(async () => {
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
  fakeHome = undefined;
});

async function freshFakeHome(): Promise<string> {
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  return fakeHome;
}

test("daemonInfoPath resolves under the given home dir's .fern, never the real home dir", async () => {
  const home = await freshFakeHome();
  expect(daemonInfoPath(home)).toBe(join(home, ".fern", "daemon.json"));
});

test("readDaemonInfo returns null when nothing has been written yet", async () => {
  const home = await freshFakeHome();
  expect(await readDaemonInfo(home)).toBeNull();
});

test("writeDaemonInfo creates the directory and readDaemonInfo round-trips it", async () => {
  const home = await freshFakeHome();
  await writeDaemonInfo(
    {
      port: 7420,
      pid: 12345,
      token: "secret-token",
      startedAt: "2026-10-27T00:00:00Z",
    },
    home,
  );

  const info = await readDaemonInfo(home);
  expect(info).toEqual({
    port: 7420,
    pid: 12345,
    token: "secret-token",
    startedAt: "2026-10-27T00:00:00Z",
  });
});

test("deleteDaemonInfo removes the file; readDaemonInfo then returns null again", async () => {
  const home = await freshFakeHome();
  await writeDaemonInfo(
    { port: 7420, pid: 1, token: "x", startedAt: "2026-10-27T00:00:00Z" },
    home,
  );
  await deleteDaemonInfo(home);
  expect(await readDaemonInfo(home)).toBeNull();
});

test("two different home dirs never see each other's daemon.json", async () => {
  const homeA = await mkdtemp(join(tmpdir(), "fern-home-a-"));
  const homeB = await mkdtemp(join(tmpdir(), "fern-home-b-"));
  try {
    await writeDaemonInfo(
      { port: 1, pid: 1, token: "a", startedAt: "2026-10-27T00:00:00Z" },
      homeA,
    );
    expect(await readDaemonInfo(homeB)).toBeNull();
  } finally {
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});
