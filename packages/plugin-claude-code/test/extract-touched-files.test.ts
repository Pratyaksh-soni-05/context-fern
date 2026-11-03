import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTouchedFiles } from "../src/extract-touched-files";

// A real absolute path for the current OS — "C:/repo" is Windows-only
// syntax; node:path's isAbsolute()/relative() treat it as a plain
// relative path on Linux/macOS, which silently broke this file's own
// relativization assumptions in CI (ubuntu-latest), not Windows.
const PROJECT = join(tmpdir(), "fern-extract-touched-files-test");

test("extractTouchedFiles relativizes a direct file_path for Read/Edit/Write", () => {
  const result = extractTouchedFiles(
    "Write",
    { file_path: join(PROJECT, "src", "auth.ts") },
    PROJECT,
  );
  expect(result).toEqual([{ path: "src/auth.ts", source: "tool_input" }]);
});

test("extractTouchedFiles extracts mentions from a shell command's text", () => {
  const result = extractTouchedFiles(
    "Bash",
    { command: "cat src/auth.ts && cat src/login.ts" },
    PROJECT,
  );
  expect(result.map((f) => f.path).sort()).toEqual([
    "src/auth.ts",
    "src/login.ts",
  ]);
  expect(result.every((f) => f.source === "command")).toBe(true);
});

test("extractTouchedFiles ignores tools with no extractable path", () => {
  expect(extractTouchedFiles("Glob", { pattern: "**/*.ts" }, PROJECT)).toEqual(
    [],
  );
});

test("extractTouchedFiles never records a .fern/ path — a brief file edited via the plain-English 'update the fern brief' flow must not show up in its own Files section", () => {
  const result = extractTouchedFiles(
    "Edit",
    { file_path: join(PROJECT, ".fern", "fronds", "greetings.md") },
    PROJECT,
  );
  expect(result).toEqual([]);
});

test("extractTouchedFiles never records .fern/ paths mentioned in a shell command either, but keeps real paths mentioned alongside them", () => {
  const result = extractTouchedFiles(
    "Bash",
    { command: "cat .fern/config.toml && cat src/auth.ts" },
    PROJECT,
  );
  expect(result).toEqual([{ path: "src/auth.ts", source: "command" }]);
});

test("extractTouchedFiles never records the .fern directory itself, not just paths under it", () => {
  const result = extractTouchedFiles(
    "Edit",
    { file_path: join(PROJECT, ".fern") },
    PROJECT,
  );
  expect(result).toEqual([]);
});
