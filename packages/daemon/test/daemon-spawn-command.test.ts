// spawnDaemonDetached() picks between two real spawn strategies based
// on whether the dev serve-entrypoint.ts exists on disk (a real path
// in `bun run`, a virtual non-existent one inside a `bun build
// --compile` binary — see client.ts's own doc comment and
// docs/decisions.md's PR 1/PR 3 entries). daemonSpawnCommand() is the
// pure decision extracted out of that function specifically so this
// branch is assertable on its real return value, not a mocked call —
// the end-to-end proof that the compiled-binary path actually works is
// scripts/smoke-test.ts's CHECK_C, run against a real compiled binary
// in .github/workflows/release.yml.

import { expect, test } from "bun:test";
import { daemonSpawnCommand } from "../src/client";

test("daemonSpawnCommand: dev checkout (entrypoint exists) uses bun run", () => {
  expect(daemonSpawnCommand(true)).toEqual([
    "bun",
    "run",
    expect.stringContaining("serve-entrypoint.ts"),
  ]);
});

test("daemonSpawnCommand: compiled binary (entrypoint missing) re-invokes itself with --internal-daemon", () => {
  expect(daemonSpawnCommand(false)).toEqual([
    process.execPath,
    "--internal-daemon",
  ]);
});
