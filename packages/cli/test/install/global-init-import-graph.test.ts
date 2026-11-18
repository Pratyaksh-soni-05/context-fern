// `context-fern init` must never load the model runtime: a plain init on a
// compiled binary printed a spurious ONNX error when it reached
// @huggingface/transformers through a barrel (docs/decisions.md, PR 1
// addendum). install/global-init.ts needs the model's checksums and the
// cache path, so it imports them from embed's two light subpaths. Same
// static resolver as init-materialize-import-graph.test.ts.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
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

const posix = (f: string) => f.replaceAll("\\", "/");

test("install/global-init.ts reaches packages/embed only through its two light files, never the transformers/onnxruntime chain", () => {
  const entry = resolve(import.meta.dir, "../../src/install/global-init.ts");
  const { files, externalPackages } = walk(entry);

  const embedFiles = [...files]
    .map(posix)
    .filter((f) => f.includes("/packages/embed/"))
    .map((f) => f.split("/").pop())
    .sort();
  expect(embedFiles).toEqual(["cache-dir.ts", "model-integrity.ts"]);

  for (const pkg of externalPackages) {
    expect(pkg).not.toMatch(/^@huggingface/);
    expect(pkg).not.toBe("onnxruntime-node");
    expect(pkg).not.toBe("@context-fern/embed");
  }
  for (const f of [...files].map(posix)) {
    expect(f).not.toMatch(/\/daemon\/src\/(server|embedder)\.ts$/);
  }
});
