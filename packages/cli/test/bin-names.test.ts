// docs/spec.md §14: "Two binary names ship from the one executable" —
// `fern` for interactive use, `context-fern` (CLI_BINARY_NAME) for every
// machine-invoked entry point the Claude Code plugin owns. A future
// edit to package.json's "bin" field that drops one, or points them at
// different files, would silently break that guarantee with nothing
// else here to catch it.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME } from "@context-fern/core";

test("package.json ships both CLI_NAME and CLI_BINARY_NAME as bin entries pointing at the same entrypoint", async () => {
  const pkg = JSON.parse(
    await Bun.file(join(import.meta.dir, "../package.json")).text(),
  ) as { bin: Record<string, string> };

  expect(pkg.bin[CLI_NAME]).toBeDefined();
  expect(pkg.bin[CLI_BINARY_NAME]).toBeDefined();
  expect(pkg.bin[CLI_NAME]).toBe(pkg.bin[CLI_BINARY_NAME]);
});
