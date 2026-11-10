// Chromium-only, matching the plan's decision (Chromium on the Windows
// CI runner is slow and flaky — this suite runs in the Linux CI job
// only; see docs/decisions.md). webServer spawns a plain Bun script
// (run-fixture-daemon.ts) as a real OS subprocess, never an import —
// Playwright's own config/spec loader can't resolve `bun:sqlite`. /ui
// needs no credential at all (see server.ts), so it's a safe,
// auth-free readiness URL.

import { defineConfig } from "@playwright/test";
import { E2E_DAEMON_PORT } from "./fixtures/constants";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // Every spec shares one fixture daemon and one seeded session (see
  // fixtures/run-fixture-daemon.ts) — not an isolated environment per
  // test — so cross-file worker parallelism (Playwright's default even
  // with fullyParallel: false) is a real race, not just slower than
  // necessary. One worker keeps every test serial against that shared state.
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_DAEMON_PORT}`,
    screenshot: "off",
    // Matches the design boards' own canvas size (Prototype.dc.html's
    // $preview is 1440x960) — the app shell's fixed-height sections
    // (header, stat tiles) were designed against that, and a smaller
    // default viewport clips the bottom row instead of scrolling it.
    viewport: { width: 1440, height: 960 },
  },
  webServer: {
    command: "bun run ./fixtures/run-fixture-daemon.ts",
    url: `http://127.0.0.1:${E2E_DAEMON_PORT}/ui`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
