// Safe for spec files to import (plain fetch, no bun:sqlite) — asks
// run-fixture-daemon.ts's helper server for a fresh one-time code/URL.
// Each spec file needs its own: the code is consumed on first use, so
// reusing one across multiple tests would strand every test after the
// first on a dead code (see docs/decisions.md).

import { E2E_HELPER_PORT } from "./constants";

export interface Fixture {
  url: string;
  /** The fixture project's real display name — POST /projects/open sets
   * this to basename(path) the moment any spec opens it (the same real
   * behaviour `fern init`/`fern ui` use), so specs must read this back
   * rather than assume a fixed name. See docs/decisions.md. */
  projectName: string;
}

/** The second, demo-shaped project run-fixture-daemon.ts seeds (scripts/demo-seed.ts's DEMO_PLAN) — opened via the Start screen's folder-path form, not the recent-projects list, since it's deliberately not touched into that registry. */
export async function getDemoProjectPath(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${E2E_HELPER_PORT}/demo-project`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (res.ok) {
        const { path } = (await res.json()) as { path: string };
        return path;
      }
    } catch {
      // helper server not up yet, or this one attempt timed out — retry.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("fixture helper server never became reachable");
}

export async function mintFixture(): Promise<Fixture> {
  for (let i = 0; i < 50; i++) {
    try {
      // A timeout is required here, not optional — a plain fetch() can
      // hang indefinitely on a flaky connection instead of rejecting,
      // which would silently burn this whole retry loop on a single
      // stuck attempt. See run-fixture-daemon.ts's matching comment.
      const res = await fetch(`http://127.0.0.1:${E2E_HELPER_PORT}/mint-code`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const { url, projectName } = (await res.json()) as {
          url: string;
          projectName: string;
        };
        return { url, projectName };
      }
    } catch {
      // helper server not up yet, or this one attempt timed out —
      // webServer's own readiness check only waits for the real
      // daemon's /ui, not this second server; either way, just retry.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("fixture helper server never became reachable");
}
