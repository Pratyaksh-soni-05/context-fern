import { expect, test } from "bun:test";
import { buildId } from "../src/build-id";

test("buildId is stable within a process (memoized)", () => {
  expect(buildId()).toBe(buildId());
});

test("buildId includes a git short sha when run inside a real checkout", () => {
  // This test suite only ever runs inside this repo's own git checkout,
  // so the sha branch (not the version-only fallback) is the one real
  // behavior worth pinning here — `git rev-parse --short HEAD` always
  // succeeds in CI and in a real dev checkout alike.
  expect(buildId()).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]+$/);
});
