// Loaded before every test file in every `bun test` invocation (see
// bunfig.toml's [test].preload). Redirects HOME, USERPROFILE,
// HOMEDRIVE/HOMEPATH, APPDATA, and FERN_HOME to one shared fake
// directory for the whole test run, so no test can ever write into the
// real home directory just by forgetting to inject or override a path.
//
// This exists because that happened for real: a test in this repo once
// fell through to a default `homedir()` with no override at all and
// silently wrote a stray entry into the maintainer's actual
// ~/.claude/settings.json (found and fixed the same day — see
// docs/decisions.md). Per-test env mutation (e.g. `process.env.FERN_HOME
// = fakeHome`) is still how individual test files isolate from each
// OTHER; this preload is the backstop for the case where that isolation
// is missing, wrong, or simply never written.
//
// Why FERN_HOME specifically, and not a monkey-patched `os.homedir()`:
// an earlier version of this file tried patching `os.homedir` itself
// (via the require()'d CommonJS object, since the frozen ESM namespace
// from `import * as os` rejects assignment). That patch is NOT reliably
// visible across Bun's require()/import boundary on every platform —
// confirmed on CI: even after patching, a separate file's
// `import { homedir } from "node:os"` still returned the real path on
// ubuntu-latest, while the identical code worked on windows-latest.
// `os.homedir()`'s own env-sensitivity is equally unreliable (passed on
// Windows, failed on Linux, for the same `process.env.HOME` mutation).
// Neither side of that call is safe to depend on cross-platform.
//
// The actually-reliable fix: every home-dependent function in
// production code (packages/daemon/src/daemon-info.ts,
// packages/cli/src/commands/statusline.ts) checks `process.env.FERN_HOME`
// — a plain JS env read, not a native call — before ever falling back
// to `os.homedir()`. This preload sets FERN_HOME unconditionally, so
// that check is what actually protects every test, on every platform.
// `os.homedir()` itself is left unpatched; HOME/USERPROFILE/APPDATA are
// still redirected as defense-in-depth for any future code that calls
// it directly, but nothing here depends on that redirection working.
//
// Deliberately NOT redirected: LOCALAPPDATA / XDG_CACHE_HOME. Those back
// packages/embed's model cache (modelCacheDir()) — a large, non-
// sensitive, reusable binary cache, not "config" in the sense that
// caused the incident above. Redirecting it would force every real-
// embedder test (packages/daemon/test/latency.test.ts,
// packages/cli/test/e2e.test.ts) to re-download the ~25MB model into a
// fresh directory on every run instead of reusing the real cache.
// modelCacheDir() still takes an explicit override parameter for any
// test that specifically wants to sandbox it.
//
// `__FERN_TEST_REAL_HOME__` stashes the real value (captured before any
// override) so test/guard-real-home.test.ts can prove this redirection
// is actually active, rather than trusting it is.

import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir();
process.env.__FERN_TEST_REAL_HOME__ = REAL_HOME;

const FAKE_HOME = mkdtempSync(join(tmpdir(), "fern-test-home-"));
mkdirSync(join(FAKE_HOME, "AppData", "Roaming"), { recursive: true });
mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });

process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.HOMEDRIVE = FAKE_HOME.slice(0, 2);
process.env.HOMEPATH = FAKE_HOME.slice(2);
process.env.APPDATA = join(FAKE_HOME, "AppData", "Roaming");
process.env.FERN_HOME = FAKE_HOME;
process.env.__FERN_TEST_FAKE_HOME__ = FAKE_HOME;
