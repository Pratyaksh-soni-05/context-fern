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
import { createHash } from "node:crypto";
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

test("the sidecar patch also looks in <exe-dir>/../share/context-fern, where a pip/uv wheel can put it", () => {
  const source = readFileSync(
    join(REPO_ROOT, "node_modules/onnxruntime-node/dist/binding.js"),
    "utf-8",
  );
  expect(source).toContain('"share", "context-fern"');
});

// The native sidecar is verified against SHA-256s pinned in the patch before
// it is loaded (a swapped .node would run arbitrary code in the daemon). The
// pins must describe the real files of the exact pinned onnxruntime-node
// version, or every install would refuse to load; this checks the host
// platform's pins against the installed package, and CI runs it on Linux,
// Windows and (through the release build) macOS.
test("the sidecar checksums pinned in the patch equal the installed onnxruntime-node's own files for this platform", () => {
  const source = readFileSync(
    join(REPO_ROOT, "node_modules/onnxruntime-node/dist/binding.js"),
    "utf-8",
  );
  const block = /const sidecarPins = (\{[\s\S]*?\n\});/.exec(source)?.[1];
  expect(block).toBeDefined();
  const pins = JSON.parse(
    (block as string).replace(/,(\s*[}\]])/g, "$1"),
  ) as Record<string, Record<string, string>>;
  const key = `${process.platform}-${process.arch}`;
  const mine = pins[key];
  if (!mine) return; // a platform we do not ship (darwin-x64, win-arm64): nothing to compare
  const dir = join(
    REPO_ROOT,
    "node_modules/onnxruntime-node/bin/napi-v6",
    process.platform,
    process.arch,
  );
  for (const [file, pinned] of Object.entries(mine)) {
    const actual = createHash("sha256")
      .update(readFileSync(join(dir, file)))
      .digest("hex");
    expect({ key, file, sha: actual }).toEqual({ key, file, sha: pinned });
  }
  expect(Object.keys(pins).sort()).toEqual(
    ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"].sort(),
  );
});
