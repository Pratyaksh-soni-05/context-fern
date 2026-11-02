// `runStatusline` reaches outside the project into the real
// ~/.claude/settings.json with no override point in `runInit`, so these
// tests only exercise branches that are provably safe by inspection:
// the ones that skip the statusline offer and never call it at all.
// (A prior version of this logic shared one --yes/--no flag between the
// .gitignore offer and the statusline offer, which let the zero-model-
// turn "/fern init" path silently write to the real settings.json — see
// docs/decisions.md. These tests lock in the fix.)

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init";

let projectDir: string;
let originalCwd: string;

async function runInitCapturingLogs(
  flags: Record<string, string>,
): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await runInit(flags);
  } finally {
    console.log = originalLog;
  }
  return logs;
}

beforeEach(async () => {
  originalCwd = process.cwd();
  projectDir = await mkdtemp(join(tmpdir(), "fern-init-test-"));
  process.chdir(projectDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(projectDir, { recursive: true, force: true });
});

test("statusline: 'no' skips only the statusline offer — --yes still confirms the unrelated .gitignore offer", async () => {
  const logs = await runInitCapturingLogs({ yes: "true", statusline: "no" });
  expect(logs.some((l) => l.includes("skipped statusline"))).toBe(true);
  expect(logs.some((l) => l.includes("added .fern/ to .gitignore"))).toBe(true);
});

test("a bare --no (no explicit --statusline) still skips the statusline offer, matching the pre-existing CLI behaviour", async () => {
  const logs = await runInitCapturingLogs({ no: "true" });
  expect(logs.some((l) => l.includes("skipped statusline"))).toBe(true);
  expect(logs.some((l) => l.includes(".gitignore"))).toBeTruthy();
});

test("the zero-model-turn /fern init path's exact flags ({yes: 'true', statusline: 'no'}) never mention installing a statusline", async () => {
  const logs = await runInitCapturingLogs({ yes: "true", statusline: "no" });
  expect(logs.some((l) => l.includes("added statusLine"))).toBe(false);
});
