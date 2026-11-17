// Real failure mode, tested directly (docs/decisions.md, PR 1 addendum):
// `bun install` alone does NOT fail loudly when a dependency bump makes
// a patch stop applying — it prints a `warn: ... patch no longer
// applies` line and exits 0. A silent, unpatched @huggingface/transformers
// or onnxruntime-node would crash (or silently reintroduce a network/sharp
// dependency) in the compiled binary this release pipeline ships, with
// nothing in CI catching it. These tests read the actually-installed
// files and fail the build — not warn — if either patch's effect is
// missing, or if the pinned version in patchedDependencies has drifted
// from what's actually installed (the half-applied state `bun install`
// leaves behind on a version bump).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");

function installedVersion(pkg: string): string {
  const pkgJsonPath = join(REPO_ROOT, "node_modules", pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
    version: string;
  };
  return pkgJson.version;
}

function pinnedPatchVersion(pkg: string): string {
  const rootPkgJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { patchedDependencies?: Record<string, string> };
  const key = Object.keys(rootPkgJson.patchedDependencies ?? {}).find((k) =>
    k.startsWith(`${pkg}@`),
  );
  if (!key) throw new Error(`no patchedDependencies entry for ${pkg}`);
  return key.slice(pkg.length + 1);
}

test("@huggingface/transformers is pinned to the exact version its patch was written against", () => {
  expect(pinnedPatchVersion("@huggingface/transformers")).toBe(
    installedVersion("@huggingface/transformers"),
  );
});

test("onnxruntime-node is pinned to the exact version its patch was written against", () => {
  expect(pinnedPatchVersion("onnxruntime-node")).toBe(
    installedVersion("onnxruntime-node"),
  );
});

test("the sharp patch is actually present in the installed transformers.node.mjs, not silently dropped", () => {
  const source = readFileSync(
    join(
      REPO_ROOT,
      "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    ),
    "utf-8",
  );
  expect(source).not.toContain('import sharp from "sharp"');
  expect(source).toContain("const sharp = /** @type {any} */ ({});");
});

test("the onnxruntime-node createRequire patch is actually present in the installed transformers.node.mjs, not silently dropped", () => {
  const source = readFileSync(
    join(
      REPO_ROOT,
      "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    ),
    "utf-8",
  );
  expect(source).not.toContain("createRequire(import.meta.url ?? __filename)");
  expect(source).toContain(
    'import onnxruntimeNodePatched from "onnxruntime-node"',
  );
});

test("the onnxruntime-node sidecar patch is actually present in the installed binding.js, not silently dropped", () => {
  const source = readFileSync(
    join(REPO_ROOT, "node_modules/onnxruntime-node/dist/binding.js"),
    "utf-8",
  );
  expect(source).toContain("onnxruntime-native");
  expect(source).toContain("process.execPath");
});
