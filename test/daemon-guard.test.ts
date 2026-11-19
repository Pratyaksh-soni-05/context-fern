// The guard that fails a test run when a test leaves a daemon running
// (test/daemon-guard.ts). Both halves are proven for real: the process list
// parsers on sample output, and a whole `bun test` run whose only test
// leaks a stand-in daemon.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonPids,
  parsePsOutput,
  parseWindowsProcessJson,
} from "./support/daemon-processes";

const ROOT = resolve(join(import.meta.dir, ".."));
const slash = (p: string) => p.replaceAll("\\", "/");

test("daemon processes are recognised by their entry point under this checkout, on both platforms' list formats", () => {
  const entry = `${slash(ROOT)}/packages/daemon/src/serve-entrypoint.ts`;
  const win = parseWindowsProcessJson(
    JSON.stringify([
      {
        ProcessId: 11,
        CommandLine: `bun run "${ROOT}\\packages\\daemon\\src\\serve-entrypoint.ts"`,
      },
      {
        ProcessId: 12,
        CommandLine:
          'bun run "C:\\elsewhere\\packages\\daemon\\src\\serve-entrypoint.ts"',
      },
      { ProcessId: 13, CommandLine: null },
    ]),
  );
  expect(daemonPids(win, ROOT)).toEqual([11]);
  // PowerShell prints a lone object, not an array.
  expect(
    parseWindowsProcessJson(
      JSON.stringify({ ProcessId: 5, CommandLine: `bun ${entry}` }),
    ),
  ).toEqual([{ pid: 5, commandLine: `bun ${entry}` }]);
  expect(parseWindowsProcessJson("")).toEqual([]);

  const ps = parsePsOutput(
    `  21 bun run ${entry}\n  22 bun run /other/repo/packages/daemon/src/serve-entrypoint.ts\n  23 bash\n`,
  );
  expect(daemonPids(ps, ROOT)).toEqual([21]);
});

test("a run whose test leaves a daemon running fails, kills it and says so; one that cleans up passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fern-guard-"));
  try {
    const marker = `${slash(ROOT)}/guard-test/serve-entrypoint.ts`;
    const leaky = join(dir, "leaky.test.ts");
    writeFileSync(
      leaky,
      `import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
test("starts a stand-in daemon and forgets it", () => {
  const child = spawn("bun", ["-e", "setTimeout(() => {}, 120000)", ${JSON.stringify(marker)}], { detached: true, stdio: "ignore" });
  child.unref();
  expect(child.pid).toBeGreaterThan(0);
});
`,
    );
    const tidy = join(dir, "tidy.test.ts");
    writeFileSync(
      tidy,
      `import { test, expect } from "bun:test";
test("starts nothing", () => { expect(1).toBe(1); });
`,
    );
    const run = (file: string) =>
      spawnSync(
        "bun",
        ["test", "--preload", join(ROOT, "test", "daemon-guard.ts"), file],
        { cwd: dir, encoding: "utf-8" },
      );
    const leak = run(leaky);
    expect(leak.status).not.toBe(0);
    expect(`${leak.stdout}${leak.stderr}`).toContain(
      "still running after the last test",
    );
    const clean = run(tidy);
    expect(clean.status).toBe(0);
    expect(`${clean.stdout}${clean.stderr}`).not.toContain("still running");
  } finally {
    // A killed process can hold its working directory for a moment on Windows.
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}, 120_000);
