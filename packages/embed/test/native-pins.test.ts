// The TypeScript copy of the native pins (used by `fern doctor`) must be
// identical to the table in the patched onnxruntime-node binding.js, which is
// what actually refuses to load a changed file. Two copies exist only because a
// compiled binary cannot read the patched file; this test is what keeps them
// from drifting.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PINS, nativePinsFor } from "../src/native-pins";

const REPO_ROOT = join(import.meta.dir, "../../..");

function patchedTable(): Record<string, Record<string, string>> {
  const source = readFileSync(
    join(REPO_ROOT, "node_modules/onnxruntime-node/dist/binding.js"),
    "utf-8",
  );
  const block = /const sidecarPins = (\{[\s\S]*?\n\});/.exec(source)?.[1];
  expect(block).toBeDefined();
  return JSON.parse((block as string).replace(/,(\s*[}\]])/g, "$1")) as Record<
    string,
    Record<string, string>
  >;
}

test("the doctor's pins equal the table in the patched binding.js, platform by platform and file by file", () => {
  expect(NATIVE_PINS).toEqual(patchedTable());
});

test("every pin is a SHA-256, and each platform pins exactly the binding plus one runtime library", () => {
  for (const [platform, files] of Object.entries(NATIVE_PINS)) {
    expect(Object.keys(files).length, platform).toBe(2);
    expect(Object.keys(files)).toContain("onnxruntime_binding.node");
    for (const sha of Object.values(files))
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("nativePinsFor answers for shipped platforms and is undefined for the rest", () => {
  expect(nativePinsFor("win32", "x64")?.["onnxruntime.dll"]).toBeDefined();
  expect(nativePinsFor("darwin", "x64")).toBeUndefined();
  expect(nativePinsFor("win32", "arm64")).toBeUndefined();
});
