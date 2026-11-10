// Loaded via `bun test -r` for packages/ui's tests only (see root
// package.json's "test" script) — NOT the repo-wide test/preload.ts.
// happy-dom's global URL/File/etc. polyfills replace Bun's native
// ones process-wide once registered; @huggingface/transformers (the
// real embedder other packages' tests exercise) throws on happy-dom's
// stricter URL implementation. Scoping registration to a separate
// `bun test` invocation, rather than the shared preload, is what keeps
// that other half of the suite on the real, native globals. See
// docs/decisions.md.
//
// Real `-r`/`--preload` is required for correct ordering (not just an
// ordinary import first in a test file): @testing-library/dom's
// `screen` singleton checks for a global `document` exactly once, at
// its own module-load time, and permanently throws a "no document"
// error from every query afterward if none was present then —
// confirmed empirically that same-file import order alone doesn't
// control this reliably.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("window" in globalThis)) {
  GlobalRegistrator.register();
}

const { expect } = await import("bun:test");
// biome-ignore lint/suspicious/noExplicitAny: extending bun:test's expect with jest-dom's matchers has no first-party types for this combination.
const matchers: any = await import("@testing-library/jest-dom/matchers");
expect.extend(matchers);
