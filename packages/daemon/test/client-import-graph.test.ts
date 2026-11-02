// A real bundler would tell us this instantly, but pulling one in just
// for a single import-graph assertion is a bigger dependency than the
// thing it's checking. This is a small static resolver: it extracts
// import specifiers via regex, resolves each with Bun's own resolver
// (so workspace "exports" subpaths and tsconfig behave exactly as they
// do for real code), and recurses only into first-party repo files —
// external packages are recorded by name, not walked into.
//
// The thing this guards: packages/daemon/src/client.ts is the module
// Claude Code hook scripts import (via the "@context-fern/daemon/client"
// subpath). Hooks run on every prompt/tool-call, so they must never
// transitively pull in packages/store (bun:sqlite) or packages/embed
// (@huggingface/transformers, a real ONNX model) — see client.ts's own
// module doc.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

interface WalkResult {
  files: Set<string>;
  externalPackages: Set<string>;
}

function walk(entry: string): WalkResult {
  const files = new Set<string>();
  const externalPackages = new Set<string>();
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || files.has(file)) continue;
    files.add(file);

    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith("node:") || specifier === "bun") {
        continue;
      }

      let resolved: string;
      try {
        resolved = Bun.resolveSync(specifier, dirname(file));
      } catch {
        continue; // type-only or otherwise unresolvable at this layer
      }

      const isFirstParty =
        resolved.startsWith(REPO_ROOT) &&
        !resolved.includes(`${sep}node_modules${sep}`);
      if (!isFirstParty) {
        externalPackages.add(specifier);
        continue;
      }
      stack.push(resolved);
    }
  }

  return { files, externalPackages };
}

test("client.ts's import graph excludes packages/store, packages/embed, and @huggingface", () => {
  const entry = resolve(import.meta.dir, "../src/client.ts");
  const { files, externalPackages } = walk(entry);

  expect(files.size).toBeGreaterThan(1); // sanity: the walk actually recursed

  for (const file of files) {
    expect(file).not.toMatch(/[\\/]packages[\\/]store[\\/]/);
    expect(file).not.toMatch(/[\\/]packages[\\/]embed[\\/]/);
  }
  for (const pkg of externalPackages) {
    expect(pkg).not.toMatch(/^@huggingface/);
    expect(pkg).not.toBe("@context-fern/store");
    expect(pkg).not.toBe("@context-fern/embed");
  }
});
