// Shared between playwright.config.ts (loaded by Playwright's own
// runner) and run-fixture-daemon.ts (a plain Bun script spawned as a
// subprocess via webServer.command — see that file's doc comment for
// why it can't be an ordinary import instead). Fixed, dedicated ports
// are a deliberate, scoped exception to "tests never bind a fixed
// port": that rule is about avoiding collisions among many bun:test
// files sharing one process/CI matrix; this is one serial Playwright
// run with its own reserved, clearly-non-default ports, picked for a
// webServer readiness URL Playwright's config needs to know statically
// (the daemon's own `firstPort: 0` pattern can't supply that). See
// docs/decisions.md.

export const E2E_DAEMON_PORT = 57420;
// A one-time code is consumed on first use — every spec file navigating
// to /ui needs its own fresh one, so run-fixture-daemon.ts runs a tiny
// unauthenticated helper server (test-fixture-only, never the real
// daemon's own surface) on this port, minting a new code per request.
export const E2E_HELPER_PORT = 57421;
