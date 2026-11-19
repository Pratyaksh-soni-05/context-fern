import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStatuslineCommand,
  renderStatusline,
  runStatusline,
  statuslineCommand,
} from "../src/commands/statusline";

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

test("rendering writes nothing to settings.json, and with no project and no daemon it prints the off line", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await renderStatusline({ cwd: fakeHome });
  } finally {
    console.log = log;
  }
  expect(lines).toEqual(["fern ▸ off"]);
  const exists = await readFile(
    join(fakeHome, ".claude", "settings.json"),
    "utf-8",
  ).catch(() => null);
  expect(exists).toBeNull();
});

test("a shipped binary writes `context-fern statusline`: no Bun, no repository path", () => {
  expect(
    statuslineCommand(
      "C:/Users/a/AppData/Local/context-fern/bin/context-fern.exe",
    ),
  ).toBe("context-fern statusline");
  expect(statuslineCommand("/home/a/.local/bin/fern")).toBe(
    "context-fern statusline",
  );
  // From a source checkout (bun) it is still the repository script.
  expect(statuslineCommand("/usr/local/bin/bun")).toContain("statusline.ts");
});

test("the command an install records is classified, and so are the old forms and a stranger's", () => {
  expect(classifyStatuslineCommand("context-fern statusline")).toBe("current");
  expect(
    classifyStatuslineCommand(
      '"C:\\Users\\a\\bin\\context-fern.exe" statusline',
    ),
  ).toBe("current");
  expect(
    classifyStatuslineCommand(
      'bun run "C:\\work\\alpha\\packages\\plugin-claude-code\\scripts\\statusline.ts"',
    ),
  ).toBe("legacy-bun");
  // The one old string is the quoted form; fern never wrote an unquoted one.
  expect(
    classifyStatuslineCommand(
      "bun run /home/a/alpha/packages/plugin-claude-code/scripts/statusline.ts",
    ),
  ).toBe("other");
  expect(classifyStatuslineCommand("echo mine")).toBe("other");
  expect(classifyStatuslineCommand("fern statusline && rm -rf /")).toBe(
    "other",
  );
  expect(classifyStatuslineCommand(undefined)).toBe("other");
});

test("installing reports exactly what it wrote, including the backup, so an install manifest can record it", async () => {
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ a: 1 }),
    "utf-8",
  );
  const outcome = await runStatusline({ install: "true" }, fakeHome);
  expect(outcome?.state).toBe("added");
  if (outcome?.state === "added") {
    expect(outcome.file).toBe(join(fakeHome, ".claude", "settings.json"));
    expect(outcome.backupPath?.endsWith(".bak")).toBe(true);
    expect(outcome.command).toBe(statuslineCommand());
  }
  expect((await runStatusline({ install: "true" }, fakeHome))?.state).toBe(
    "already-present",
  );
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

test("a composite or decorated command is the user's own, not fern's, so uninstall and doctor leave it alone", () => {
  for (const mine of [
    "echo hi; /x/context-fern statusline",
    "FOO=1 /opt/context-fern statusline",
    "context-fern statusline && other",
    "context-fern statusline | tee log",
    "$(context-fern) statusline",
    "bun run /x/plugin-claude-code/scripts/statusline.ts; rm x",
    '"/x y/context-fern" statusline; rm x',
  ]) {
    expect(classifyStatuslineCommand(mine)).toBe("other");
  }
  // A plain path prefix, quoted or not, is still recognised.
  expect(
    classifyStatuslineCommand("/home/a/.local/bin/context-fern statusline"),
  ).toBe("current");
  expect(
    classifyStatuslineCommand('"/home/a b/.local/bin/context-fern" statusline'),
  ).toBe("current");
});
