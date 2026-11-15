// Same static resolver as packages/daemon/test/client-import-graph.test.ts
// (a small, deliberate duplication — see that file's doc comment for why
// a real bundler isn't worth pulling in for one assertion), applied to
// the CLI subcommands that fire on every prompt, tool call, and session
// start (and the MCP server, which runs for the whole life of a Claude
// Code session). These must never transitively pull in packages/store
// (bun:sqlite) or packages/embed (@huggingface/transformers) — moved
// from packages/plugin-claude-code/test/scripts-import-graph.test.ts
// (see docs/decisions.md's Phase-4 PR 2 entry) now that the walk starts
// from commands/hook.ts directly rather than a separate scripts/*.ts
// wrapper per event.
//
// This walk is accurate regardless of how index.ts's own switch is
// written (static or dynamic per-case imports) — it never passes
// through index.ts at all, starting instead from each command module
// these tests name directly. index.ts's switch being dynamic-import-per-
// case is what makes that guarantee *matter* at runtime (so invoking
// "hook" doesn't also eagerly load route.ts's store/embed imports just
// by sharing an entrypoint file) — this test documents and enforces the
// narrower, load-bearing claim: the hook/mcp code itself never needs
// them, deliberately, not just "doesn't happen to get loaded first".
//
// commands/fern-fallback.ts is included too — it's reached from
// commands/fern.md the same fixed, no-stdin way hooks are reached from
// hooks.json, and must stay just as light.

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

const PASSIVE_ENTRYPOINTS = [
  "../../src/commands/hook.ts",
  "../../src/commands/fern-fallback.ts",
  "../../src/commands/mcp.ts",
];

for (const entrypoint of PASSIVE_ENTRYPOINTS) {
  test(`${entrypoint}'s import graph excludes packages/store, packages/embed, and @huggingface`, () => {
    const entry = resolve(import.meta.dir, entrypoint);
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
