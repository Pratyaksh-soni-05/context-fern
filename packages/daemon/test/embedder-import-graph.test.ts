// The daemon must be able to start, degraded, when the ONNX runtime cannot
// load: a native sidecar that is missing, or that fails its pinned checksum
// (patches/onnxruntime-node), throws while onnxruntime-node is being
// imported. That only degrades gracefully if nothing the daemon imports
// statically reaches it; the heavy embedder is imported dynamically inside
// `loadEmbedder`'s try/catch. Same static resolver as the other
// import-graph tests, restricted to static `from "..."` imports.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const STATIC_FROM = /\bfrom\s*["']([^"']+)["']/g;

function walk(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || files.has(file)) continue;
    files.add(file);
    for (const m of readFileSync(file, "utf-8").matchAll(STATIC_FROM)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:") || spec === "bun") continue;
      let resolved: string;
      try {
        resolved = Bun.resolveSync(spec, dirname(file));
      } catch {
        continue;
      }
      const firstParty =
        resolved.startsWith(REPO_ROOT) &&
        !resolved.includes(`${sep}node_modules${sep}`);
      if (firstParty) stack.push(resolved);
      else externals.add(spec);
    }
  }
  return { files, externals };
}

test("the daemon's embedder module and server reach no ONNX runtime code through static imports", () => {
  for (const entry of ["src/embedder.ts", "src/server.ts"]) {
    const { files, externals } = walk(resolve(import.meta.dir, "..", entry));
    for (const f of files) {
      expect(f.replaceAll("\\", "/")).not.toMatch(
        /embed\/src\/transformers-embedder\.ts$/,
      );
      expect(f.replaceAll("\\", "/")).not.toMatch(/embed\/src\/index\.ts$/);
    }
    for (const pkg of externals) {
      expect(pkg).not.toMatch(/^@huggingface/);
      expect(pkg).not.toBe("onnxruntime-node");
    }
  }
});
