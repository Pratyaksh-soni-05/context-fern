// Every function under test takes the temp home dir as an explicit
// argument — no FERN_HOME env mutation needed here, so there's nothing
// to forget to reset and no path back to the real home dir even if a
// call site drops the argument by mistake (see docs/decisions.md).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
      buildId: "0.0.0+abc123",
    },
    home,
  );

  const info = await readDaemonInfo(home);
  expect(info).toEqual({
    port: 7420,
    pid: 12345,
    token: "secret-token",
    startedAt: "2026-10-27T00:00:00Z",
    buildId: "0.0.0+abc123",
  });
});

test("deleteDaemonInfo removes the file; readDaemonInfo then returns null again", async () => {
  const home = await freshFakeHome();
  await writeDaemonInfo(
    {
      port: 7420,
      pid: 1,
      token: "x",
      startedAt: "2026-10-27T00:00:00Z",
      buildId: "0.0.0+abc123",
    },
    home,
  );
  await deleteDaemonInfo(home);
  expect(await readDaemonInfo(home)).toBeNull();
});

// Found by an adversarial security review: daemon.json holds the raw
// token that grants full access to every daemon endpoint, and the
// write had no explicit file mode — on a shared Linux/macOS box with a
// permissive umask (e.g. 022) the file could end up world-readable.
// `mode` is POSIX-only (meaningless on Windows, which uses ACLs
// instead) — these two assertions only run where they mean anything.
test.skipIf(process.platform === "win32")(
  "writeDaemonInfo creates daemon.json readable/writable by the owner only — POSIX only",
  async () => {
    const home = await freshFakeHome();
    await writeDaemonInfo(
      {
        port: 7420,
        pid: 1,
        token: "secret-token",
        startedAt: "2026-10-27T00:00:00Z",
        buildId: "0.0.0+abc123",
      },
      home,
    );
    const stats = await stat(daemonInfoPath(home));
    expect(stats.mode & 0o777).toBe(0o600);
  },
);

test.skipIf(process.platform === "win32")(
  "writeDaemonInfo creates the .fern directory accessible by the owner only — POSIX only",
  async () => {
    const home = await freshFakeHome();
    await writeDaemonInfo(
      {
        port: 7420,
        pid: 1,
        token: "secret-token",
        startedAt: "2026-10-27T00:00:00Z",
        buildId: "0.0.0+abc123",
      },
      home,
    );
    const stats = await stat(join(home, ".fern"));
    expect(stats.mode & 0o777).toBe(0o700);
  },
);

test("two different home dirs never see each other's daemon.json", async () => {
  const homeA = await mkdtemp(join(tmpdir(), "fern-home-a-"));
  const homeB = await mkdtemp(join(tmpdir(), "fern-home-b-"));
  try {
    await writeDaemonInfo(
      {
        port: 1,
        pid: 1,
        token: "a",
        startedAt: "2026-10-27T00:00:00Z",
        buildId: "0.0.0+abc123",
      },
      homeA,
    );
    expect(await readDaemonInfo(homeB)).toBeNull();
  } finally {
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});
