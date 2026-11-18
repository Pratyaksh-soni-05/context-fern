// What happens when `context-fern` is not on PATH (install put it in a
// directory the user has not added yet, or a new terminal has not been
// opened): every hook must fail open. Claude Code treats a hook whose
// command cannot be started as a non-blocking error and carries on with
// the prompt; only a hook that actually runs and exits 2 blocks one.
//
// Two halves, because each proves something different:
//  - this file spawns every command in hooks.json the way Claude Code
//    does (exec form, no shell) with PATH lacking the binary, and asserts
//    the failure is "could not start", never exit code 2 and never output;
//  - the real Claude Code behaviour was checked by hand against
//    Claude Code 2.1.326 (`claude -p` with hooks naming a missing
//    command completed normally; a control hook exiting 2 blocked the
//    prompt) and is recorded in docs/decisions.md. Not run in CI: it
//    needs a signed-in `claude` and spends quota.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_BINARY_NAME } from "@context-fern/core";

const HOOKS_JSON = join(
  import.meta.dir,
  "../../../plugin-claude-code/hooks/hooks.json",
);

interface HookCommand {
  type: string;
  command: string;
  args?: string[];
}
interface HooksFile {
  hooks: Record<string, { hooks: HookCommand[] }[]>;
}

const hooks = JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as HooksFile;
const commands = Object.entries(hooks.hooks).flatMap(([event, groups]) =>
  groups.flatMap((g) => g.hooks.map((h) => ({ event, ...h }))),
);

test("every hook command is the bare machine-invoked name in exec form, so a missing binary cannot be wrapped into a blocking exit code", () => {
  expect(commands.length).toBeGreaterThan(0);
  for (const c of commands) {
    expect(c.command).toBe(CLI_BINARY_NAME);
    expect(Array.isArray(c.args)).toBe(true);
  }
});

test("with context-fern not on PATH, each hook fails to start: no exit code 2, no output, nothing that could block a prompt", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "fern-empty-path-"));
  try {
    for (const c of commands) {
      const r = spawnSync(c.command, c.args ?? [], {
        env: { PATH: emptyDir, Path: emptyDir },
        input: JSON.stringify({ prompt: "hello" }),
        encoding: "utf-8",
        timeout: 10_000,
      });
      // Node says ENOENT, Bun says "Executable not found in $PATH": either way it never started.
      expect(r.error?.message ?? "").toMatch(/ENOENT|not found/i);
      expect(r.status).not.toBe(2);
      expect(r.stdout ?? "").toBe("");
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
