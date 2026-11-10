// Guards against token drift: packages/ui/src/design/tokens.css's
// `:root { ... }` block and reusable-pattern classes must stay
// byte-identical to docs/design/tokens.css, the locked source of
// truth. Only the font-loading preamble is allowed to differ
// (self-hosted @font-face here vs. the dev-only Google @import there —
// see docs/decisions.md).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_TOKENS_PATH = join(
  import.meta.dir,
  "../../../docs/design/tokens.css",
);
const UI_TOKENS_PATH = join(import.meta.dir, "../src/design/tokens.css");
const END_MARKER = "/* END OF LOCKED TOKENS";

function lockedBlock(path: string, trimToMarker: boolean): string {
  const text = readFileSync(path, "utf-8");
  // Match only a `:root {` that starts its own line — the preamble
  // comments mention the literal text `:root {` in prose, which a bare
  // indexOf would match instead of the real rule.
  const match = /^:root \{/m.exec(text);
  if (!match) throw new Error(`:root { not found in ${path}`);
  const start = match.index;
  const end = trimToMarker ? text.indexOf(END_MARKER) : text.length;
  if (trimToMarker && end === -1) {
    throw new Error(`${END_MARKER} not found in ${path}`);
  }
  return text.slice(start, end).trimEnd();
}

test("packages/ui's :root tokens and reusable patterns match docs/design/tokens.css exactly", () => {
  const docs = lockedBlock(DOCS_TOKENS_PATH, false);
  const ui = lockedBlock(UI_TOKENS_PATH, true);
  expect(ui).toBe(docs);
});
