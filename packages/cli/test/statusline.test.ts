import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatusline } from "../src/commands/statusline";

let fakeHome: string;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "fern-claude-home-"));
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

async function readSettings(): Promise<Record<string, unknown>> {
  const text = await readFile(
    join(fakeHome, ".claude", "settings.json"),
    "utf-8",
  );
  return JSON.parse(text) as Record<string, unknown>;
}

test("with no --install flag, prints usage and touches nothing", async () => {
  await runStatusline({}, fakeHome);
  const exists = await readFile(
    join(fakeHome, ".claude", "settings.json"),
    "utf-8",
  ).catch(() => null);
  expect(exists).toBeNull();
});

test("installs into a fresh ~/.claude/settings.json with no prior file", async () => {
  await runStatusline({ install: "true" }, fakeHome);
  const settings = await readSettings();
  const statusLine = settings.statusLine as { type: string; command: string };
  expect(statusLine.type).toBe("command");
  expect(statusLine.command).toContain("statusline.ts");
});

test("preserves existing settings.json content when adding statusLine", async () => {
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ someOtherSetting: "keep-me" }),
    "utf-8",
  );

  await runStatusline({ install: "true" }, fakeHome);

  const settings = await readSettings();
  expect(settings.someOtherSetting).toBe("keep-me");
  expect(settings.statusLine).toBeTruthy();
});

test("never overwrites an existing statusLine entry — backs up and prints the snippet instead", async () => {
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  const original = { statusLine: { type: "command", command: "echo mine" } };
  await writeFile(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify(original),
    "utf-8",
  );

  await runStatusline({ install: "true" }, fakeHome);

  const settings = await readSettings();
  expect(settings).toEqual(original);
});

test("a prior non-statusLine settings.json gets backed up before the write", async () => {
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  const { writeFile, readdir } = await import("node:fs/promises");
  await writeFile(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ someOtherSetting: "keep-me" }),
    "utf-8",
  );

  await runStatusline({ install: "true" }, fakeHome);

  const entries = await readdir(join(fakeHome, ".claude"));
  expect(entries.some((e) => e.endsWith(".bak"))).toBe(true);
});
