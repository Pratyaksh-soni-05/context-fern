// materializeAndRegisterProject — the heavy half of `fern init`,
// deliberately NOT in commands/init.ts (which fern-dispatch.ts imports
// via the lightweight "@context-fern/cli/init" subpath; see
// packages/plugin-claude-code/test/scripts-import-graph.test.ts and
// docs/decisions.md on why this had to be a separate module).

import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentProjects } from "@context-fern/daemon";
import { canonicalizeProjectPath } from "@context-fern/daemon/client";
import { materializeAndRegisterProject } from "../src/commands/init-materialize";

let fakeHome: string;
let originalFernHome: string | undefined;
let projectDir: string;

afterEach(async () => {
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

async function setUp(): Promise<void> {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  const base = join(tmpdir(), `fern init-materialize test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  projectDir = await mkdtemp(join(base, "run-"));
}

test("creates .fern/fern.db and registers the project with sessionCount 0", async () => {
  await setUp();
  await materializeAndRegisterProject(projectDir);

  await access(join(projectDir, ".fern", "fern.db")); // throws (failing the test) if missing

  const projects = await listRecentProjects(fakeHome);
  expect(projects).toHaveLength(1);
  // Canonicalized — on this real mkdtemp'd directory that can mean the
  // real on-disk casing or an expanded short name, not necessarily
  // projectDir's own raw string.
  expect(projects[0]?.path).toBe(canonicalizeProjectPath(projectDir));
  expect(projects[0]?.sessionCount).toBe(0);
});

test("is idempotent — calling it twice never duplicates the registry entry", async () => {
  await setUp();
  await materializeAndRegisterProject(projectDir);
  await materializeAndRegisterProject(projectDir);

  const projects = await listRecentProjects(fakeHome);
  expect(projects).toHaveLength(1);
});
