// ~/.fern/projects.json's atomic read/write and resolveProjectPath's
// .fern/fern.db validation. Never touches the real home dir — every
// call passes an explicit temp `homeDir`.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeProjectPath } from "../src/client";
import {
  clearRecentProjects,
  listRecentProjects,
  projectsFilePath,
  resolveProjectPath,
  touchRecentProject,
} from "../src/project-registry-file";

let homeDir: string | undefined;

afterEach(async () => {
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

async function freshHome(): Promise<string> {
  const base = join(tmpdir(), `fern projects-file test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  homeDir = await mkdtemp(join(base, "home-"));
  return homeDir;
}

test("listRecentProjects is empty before anything is touched", async () => {
  const home = await freshHome();
  expect(await listRecentProjects(home)).toEqual([]);
});

test("touchRecentProject records a project; listRecentProjects returns it", async () => {
  const home = await freshHome();
  await touchRecentProject("/repo-a", "repo-a", 3, home);

  const projects = await listRecentProjects(home);
  expect(projects).toHaveLength(1);
  // Canonicalized, not the raw string verbatim — /repo-a doesn't exist
  // on disk, so this is canonicalizeProjectPath()'s fallback form
  // (platform-resolved, never thrown), not a real-path expansion; see
  // the canonicalization-specific tests for the cases that do exist.
  expect(projects[0]?.path).toBe(canonicalizeProjectPath("/repo-a"));
  expect(projects[0]?.name).toBe("repo-a");
  expect(projects[0]?.sessionCount).toBe(3);
  expect(typeof projects[0]?.lastOpenedAt).toBe("string");
});

test("listRecentProjects orders most-recently-opened first", async () => {
  const home = await freshHome();
  await touchRecentProject("/repo-a", "repo-a", 1, home);
  await new Promise((r) => setTimeout(r, 5));
  await touchRecentProject("/repo-b", "repo-b", 1, home);

  const projects = await listRecentProjects(home);
  expect(projects.map((p) => p.path)).toEqual([
    canonicalizeProjectPath("/repo-b"),
    canonicalizeProjectPath("/repo-a"),
  ]);
});

test("touching the same path again replaces its entry rather than duplicating it", async () => {
  const home = await freshHome();
  await touchRecentProject("/repo-a", "repo-a", 1, home);
  await touchRecentProject("/repo-a", "repo-a", 5, home);

  const projects = await listRecentProjects(home);
  expect(projects).toHaveLength(1);
  expect(projects[0]?.sessionCount).toBe(5);
});

test("the projects file is written atomically — no .tmp file left behind after a successful touch", async () => {
  const home = await freshHome();
  await touchRecentProject("/repo-a", "repo-a", 1, home);

  const dir = join(home, ".fern");
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(dir);
  expect(entries).toContain("projects.json");
  expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);

  const raw = await readFile(projectsFilePath(home), "utf-8");
  expect(() => JSON.parse(raw)).not.toThrow();
});

test("clearRecentProjects removes the file entirely", async () => {
  const home = await freshHome();
  await touchRecentProject("/repo-a", "repo-a", 1, home);
  await clearRecentProjects(home);
  expect(await listRecentProjects(home)).toEqual([]);
});

test("a malformed projects.json is treated as empty rather than throwing", async () => {
  const home = await freshHome();
  await mkdir(join(home, ".fern"), { recursive: true });
  await writeFile(projectsFilePath(home), "not json at all", "utf-8");
  expect(await listRecentProjects(home)).toEqual([]);
});

test("resolveProjectPath returns null for a path with no .fern/ at all", async () => {
  const base = join(tmpdir(), `fern resolve-path test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "run-"));
  try {
    expect(await resolveProjectPath(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectPath returns null for a path with .fern/ but no fern.db yet (fern init alone, before the daemon ever opened it)", async () => {
  const base = join(tmpdir(), `fern resolve-path test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "run-"));
  try {
    await mkdir(join(dir, ".fern"), { recursive: true });
    expect(await resolveProjectPath(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectPath resolves a real path once .fern/fern.db exists", async () => {
  const base = join(tmpdir(), `fern resolve-path test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "run-"));
  try {
    await mkdir(join(dir, ".fern"), { recursive: true });
    await writeFile(join(dir, ".fern", "fern.db"), "", "utf-8");
    const resolved = await resolveProjectPath(dir);
    expect(resolved).not.toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectPath returns null for a nonexistent path", async () => {
  expect(
    await resolveProjectPath("/this/path/definitely/does/not/exist/anywhere"),
  ).toBeNull();
});
