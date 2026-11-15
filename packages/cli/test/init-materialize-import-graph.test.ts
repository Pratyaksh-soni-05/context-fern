// Same static resolver as packages/cli/test/hooks/import-graph.test.ts
// and packages/daemon/test/client-import-graph.test.ts — see those
// files' doc comments for why a real bundler isn't worth pulling in for
// one assertion.
//
// commands/init-materialize.ts legitimately opens bun:sqlite
// (openFernStore) — unlike the hook/mcp entrypoints, this test does NOT
// forbid packages/store. It forbids packages/embed and the native
// dependency chain behind it specifically: the compiled binary crashed
// on a plain `fern init` (which never embeds anything) because
// touchRecentProject used to come from @context-fern/daemon's main
// barrel, which also re-exports startDaemon/createWarmEmbedder and so
// eagerly loads @huggingface/transformers + onnxruntime-node. See
// docs/decisions.md's PR 1 addendum entry on this bug.

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
        continue;
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

test("commands/init-materialize.ts's import graph excludes packages/embed and onnxruntime-node, but still legitimately includes packages/store", () => {
  const entry = resolve(import.meta.dir, "../src/commands/init-materialize.ts");
  const { files, externalPackages } = walk(entry);

  expect(files.size).toBeGreaterThan(1);

  let touchesStore = false;
  for (const file of files) {
    expect(file).not.toMatch(/[\\/]packages[\\/]embed[\\/]/);
    if (file.match(/[\\/]packages[\\/]store[\\/]/)) touchesStore = true;
  }
  expect(touchesStore).toBe(true);

  for (const pkg of externalPackages) {
    expect(pkg).not.toMatch(/^@huggingface/);
    expect(pkg).not.toBe("onnxruntime-node");
    expect(pkg).not.toBe("@context-fern/embed");
  }
});
