import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonInfoPath,
  deleteDaemonInfo,
  readDaemonInfo,
  writeDaemonInfo,
} from "../src/daemon-info";

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

test("daemonInfoPath resolves under FERN_HOME/.fern, never the real home dir in tests", () => {
  expect(daemonInfoPath()).toBe(join(fakeHome, ".fern", "daemon.json"));
});

test("readDaemonInfo returns null when nothing has been written yet", async () => {
  expect(await readDaemonInfo()).toBeNull();
});

test("writeDaemonInfo creates the directory and readDaemonInfo round-trips it", async () => {
  await writeDaemonInfo({
    port: 7420,
    pid: 12345,
    token: "secret-token",
    startedAt: "2026-10-27T00:00:00Z",
  });

  const info = await readDaemonInfo();
  expect(info).toEqual({
    port: 7420,
    pid: 12345,
    token: "secret-token",
    startedAt: "2026-10-27T00:00:00Z",
  });
});

test("deleteDaemonInfo removes the file; readDaemonInfo then returns null again", async () => {
  await writeDaemonInfo({
    port: 7420,
    pid: 1,
    token: "x",
    startedAt: "2026-10-27T00:00:00Z",
  });
  await deleteDaemonInfo();
  expect(await readDaemonInfo()).toBeNull();
});
