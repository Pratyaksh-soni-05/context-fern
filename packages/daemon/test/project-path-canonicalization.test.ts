// Regression coverage for a real bug report: `fern ui` run from a
// Windows short path (C:\Users\USERNA~1\...) showed zero fronds/
// leaflets for a project that Claude Code's own hooks — using the long
// path (C:\Users\User Name\...) — had already recorded real
// history for. Root cause: `sessions.project_path` was matched by exact
// SQL string equality everywhere, so two spellings of the same real
// directory looked like two different projects, and the daemon silently
// opened a brand-new, empty session under whichever spelling it saw
// first. canonicalizeProjectPath() (client.ts) plus the migration in
// project-registry.ts's openProject() fix this: the in-memory registry
// and `sessions.project_path` lookups now key on one canonical spelling,
// and a historical row stored under an old spelling gets renamed onto
// the canonical one (not duplicated) the first time it's reopened.
//
// Windows-specific assertions (short path, mixed case) are guarded with
// test.skipIf(process.platform !== "win32") so this file runs clean on
// the Linux CI job too — the trailing-slash case is real on every OS
// and runs unconditionally.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFernStore } from "@context-fern/store";
import { canonicalizeProjectPath } from "../src/client";
import { closeAllProjects, getOrOpenProject } from "../src/project-registry";

let fakeHome: string;
let originalFernHome: string | undefined;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
});

afterEach(async () => {
  await closeAllProjects();
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
});

async function freshProjectDir(): Promise<string> {
  const base = join(tmpdir(), `fern canon test ${Date.now()}-${Math.random()}`);
  await mkdir(base, { recursive: true });
  return await mkdtemp(join(base, "run-"));
}

/** Seeds a real frond directly via the store API, under `projectPathSpelling` (which may deliberately NOT be canonical — simulating a session recorded before canonicalization existed). Returns the frond name to look for after reopening. */
async function seedFrondUnderSpelling(
  realProjectDir: string,
  projectPathSpelling: string,
): Promise<string> {
  const fernDir = join(realProjectDir, ".fern");
  const store = await openFernStore(fernDir);
  try {
    const session = await store.createSession({
      agent: "test",
      projectPath: projectPathSpelling,
      mode: "suggest",
    });
    const { fronds } = await store.getTree(session.id);
    const stem = fronds.find((f) => f.parentId === null);
    if (!stem) throw new Error("no stem frond created");
    await store.createFrond({
      sessionId: session.id,
      parentId: stem.id,
      name: "greetings",
      colorIndex: 1,
    });
  } finally {
    store.close();
  }
  return "greetings";
}

/** Opens via project-registry.ts's real getOrOpenProject() (the actual daemon code path, not a direct store call) and asserts the seeded frond is found — i.e. the real history, not a fresh empty session. */
async function assertFrondFoundViaGetOrOpenProject(
  openPathSpelling: string,
  expectedFrondName: string,
): Promise<void> {
  const state = await getOrOpenProject(openPathSpelling);
  const names = [...state.frondNames.values()];
  expect(names).toContain(expectedFrondName);
}

test("a trailing slash resolves to the same session as the bare path (every OS)", async () => {
  const dir = await freshProjectDir();
  await seedFrondUnderSpelling(dir, dir); // written under the bare (canonical) spelling
  await closeAllProjects(); // force a real reopen, not an in-memory cache hit

  const withSlash =
    dir.endsWith("/") || dir.endsWith("\\")
      ? dir
      : `${dir}${process.platform === "win32" ? "\\" : "/"}`;
  await assertFrondFoundViaGetOrOpenProject(withSlash, "greetings");
});

test("a session recorded under a trailing-slash spelling is found (and migrated) when reopened via the bare path", async () => {
  const dir = await freshProjectDir();
  const canonical = canonicalizeProjectPath(dir);
  const withSlash = `${canonical}${process.platform === "win32" ? "\\" : "/"}`;
  await seedFrondUnderSpelling(dir, withSlash); // written under the NON-canonical (trailing-slash) spelling
  await closeAllProjects();

  await assertFrondFoundViaGetOrOpenProject(canonical, "greetings");
});

test.skipIf(process.platform !== "win32")(
  "a session recorded under a mixed-case spelling is found (and migrated) when reopened via the real-cased path — Windows only",
  async () => {
    const dir = await freshProjectDir();
    const canonical = canonicalizeProjectPath(dir);
    const mixedCase = canonical.toUpperCase();
    await seedFrondUnderSpelling(dir, mixedCase); // written under the NON-canonical (uppercased) spelling
    await closeAllProjects();

    await assertFrondFoundViaGetOrOpenProject(canonical, "greetings");
  },
);

test.skipIf(process.platform !== "win32")(
  "a session recorded under a Windows 8.3 short-path spelling is found (and migrated) when reopened via the real long path — Windows only",
  async () => {
    const dir = await freshProjectDir();
    const canonical = canonicalizeProjectPath(dir);

    // A real short-path alias from the OS itself (FileSystemObject's
    // ShortPath), not a hand-rolled guess at 8.3 truncation rules —
    // the same real mechanism the original bug report hit via
    // C:\Users\USERNA~1\... vs C:\Users\User Name\....
    const psScript = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${JSON.stringify(dir)}).ShortPath`;
    const shortPath = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript],
      { encoding: "utf-8" },
    ).trim();
    expect(shortPath.length).toBeGreaterThan(0);

    await seedFrondUnderSpelling(dir, shortPath); // written under the short-path spelling
    await closeAllProjects();

    await assertFrondFoundViaGetOrOpenProject(canonical, "greetings");
    // And the reverse direction: written canonical, reopened via the
    // short path — the actual shape of the original bug report (hooks
    // wrote under the long path; `fern ui` opened via the short one).
    await closeAllProjects();
    const dir2 = await freshProjectDir();
    const canonical2 = canonicalizeProjectPath(dir2);
    await seedFrondUnderSpelling(dir2, canonical2);
    await closeAllProjects();
    const psScript2 = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${JSON.stringify(dir2)}).ShortPath`;
    const shortPath2 = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript2],
      { encoding: "utf-8" },
    ).trim();
    await assertFrondFoundViaGetOrOpenProject(shortPath2, "greetings");
  },
  // Two cold powershell.exe launches (each loads the COM scripting runtime
  // and may be scanned by Defender on a fresh runner) can pass bun's 5 s
  // default on a loaded Windows CI box; nothing here is a perf check.
  30_000,
);

test("canonicalizeProjectPath itself: trailing slash normalizes away (every OS)", async () => {
  const dir = await freshProjectDir();
  const withSlash = `${dir}${process.platform === "win32" ? "\\" : "/"}`;
  expect(canonicalizeProjectPath(withSlash)).toBe(canonicalizeProjectPath(dir));
});

test.skipIf(process.platform !== "win32")(
  "canonicalizeProjectPath itself: case differences normalize away — Windows only",
  async () => {
    const dir = await freshProjectDir();
    expect(canonicalizeProjectPath(dir.toUpperCase())).toBe(
      canonicalizeProjectPath(dir),
    );
    expect(canonicalizeProjectPath(dir.toLowerCase())).toBe(
      canonicalizeProjectPath(dir),
    );
  },
);
