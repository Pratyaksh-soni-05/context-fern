import { expect, test } from "bun:test";
import { modelCacheDir } from "../src/cache-dir";

test("resolves to a path under the OS user cache dir, not the repo", () => {
  const dir = modelCacheDir();
  expect(dir).toContain("models");
  expect(dir).not.toContain("alpha-context-tree");
  // not a relative/repo-local path
  expect(dir.startsWith(".")).toBe(false);
});

test("is deterministic for a given environment", () => {
  expect(modelCacheDir()).toBe(modelCacheDir());
});
