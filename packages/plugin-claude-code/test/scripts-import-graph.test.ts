// Same static resolver as packages/daemon/test/client-import-graph.test.ts
// (a small, deliberate duplication — see that file's doc comment for why
// a real bundler isn't worth pulling in for one assertion), applied to
// every thin hook script this plugin ships. These run on every prompt,
// tool call, and session start — they must never transitively pull in
// packages/store (bun:sqlite) or packages/embed (@huggingface/transformers).
//
// fern-command.ts and statusline.ts are intentionally NOT included here:
// they back an explicit user command, not a passive per-turn tap, and
// fern-command.ts's "/fern init" path needs @context-fern/cli/init (itself
// lightweight, but a different scope than the passive hooks').

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

const PASSIVE_HOOK_SCRIPTS = [
  "user-prompt-submit.ts",
  "post-tool-use.ts",
  "stop.ts",
  "session-start.ts",
];

for (const script of PASSIVE_HOOK_SCRIPTS) {
  test(`scripts/${script}'s import graph excludes packages/store, packages/embed, and @huggingface`, () => {
    const entry = resolve(import.meta.dir, "../scripts", script);
    const { files, externalPackages } = walk(entry);

    expect(files.size).toBeGreaterThan(1);

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
}
