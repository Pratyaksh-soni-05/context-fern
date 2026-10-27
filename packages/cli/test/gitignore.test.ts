import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToGitignore, gitignoreHasEntry } from "../src/gitignore";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test("gitignoreHasEntry is false when the file doesn't exist", async () => {
  dir = await mkdtemp(join(tmpdir(), "gi-"));
  expect(await gitignoreHasEntry(join(dir, ".gitignore"), ".fern/")).toBe(
    false,
  );
});

test("appendToGitignore creates the file when none exists", async () => {
  dir = await mkdtemp(join(tmpdir(), "gi-"));
  const path = join(dir, ".gitignore");
  await appendToGitignore(path, ".fern/");
  expect(await readFile(path, "utf-8")).toBe(".fern/\n");
});

test("appendToGitignore never rewrites or reorders existing lines, only appends", async () => {
  dir = await mkdtemp(join(tmpdir(), "gi-"));
  const path = join(dir, ".gitignore");
  await writeFile(path, "node_modules/\ndist/\n", "utf-8");

  await appendToGitignore(path, ".fern/");

  expect(await readFile(path, "utf-8")).toBe("node_modules/\ndist/\n.fern/\n");
});

test("appendToGitignore adds a trailing newline first if the file didn't end with one", async () => {
  dir = await mkdtemp(join(tmpdir(), "gi-"));
  const path = join(dir, ".gitignore");
  await writeFile(path, "node_modules/", "utf-8"); // no trailing newline

  await appendToGitignore(path, ".fern/");

  expect(await readFile(path, "utf-8")).toBe("node_modules/\n.fern/\n");
});

test("gitignoreHasEntry matches an exact existing line", async () => {
  dir = await mkdtemp(join(tmpdir(), "gi-"));
  const path = join(dir, ".gitignore");
  await writeFile(path, "node_modules/\n.fern/\n", "utf-8");

  expect(await gitignoreHasEntry(path, ".fern/")).toBe(true);
  expect(await gitignoreHasEntry(path, ".other/")).toBe(false);
});
