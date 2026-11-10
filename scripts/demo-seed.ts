// The data half of `bun run demo` (see demo.ts for the "start a daemon
// and open a browser" half) — kept separate, and exporting DEMO_PLAN/
// DEMO_UNDO_COUNT, so a test (e2e/tests/demo-data.spec.ts) can seed the
// exact same dataset and assert real UI counts against it, rather than
// a hand-copied number that can silently drift from what this file
// actually seeds. Synthetic data only — no real project, no real
// content, see CLAUDE.md's privacy rules.

import { join } from "node:path";
import {
  createBrief,
  type FernStore,
  openFernStore,
  pushRecentEntry,
  writeBriefSections,
} from "@context-fern/store";
import { type SeedLeaflet, seedProjectFromPlan } from "../e2e/fixtures/seed";

// At least 3 fronds (auth-refactor, docker-build, flaky-test), 2
// strays, several returns, one combine, one merge, a few undone
// decisions — see docs/decisions.md for why each shape matters:
// Categories' "card per frond (including merged)" needs a merged one
// to actually render; the undo-rate stat tile only shows a real ratio
// once there are >=5 actionable (non-continue) decisions.
export const DEMO_PLAN: SeedLeaflet[] = [
  { frond: null, action: "continue" },
  { frond: "auth-refactor", action: "new" },
  { frond: "auth-refactor", action: "continue" },
  { frond: null, action: "stray", strayFrom: "auth-refactor" },
  { frond: "docker-build", action: "new" },
  { frond: "docker-build", action: "continue" },
  { frond: null, action: "stray", strayFrom: "docker-build" },
  { frond: "auth-refactor", action: "return" },
  { frond: "auth-refactor", action: "continue" },
  { frond: "flaky-test", action: "new" },
  { frond: "flaky-test", action: "continue" },
  { frond: "docker-build", action: "return" },
  { frond: "docker-build", action: "continue" },
  { frond: "auth-refactor", action: "combine", combineWith: "docker-build" },
  { frond: "flaky-test", action: "merge" },
  { frond: "auth-refactor", action: "return" },
  // The last two actionable decisions — undone below, on purpose: both
  // are plain "return"s, never the "new"/"merge" that would delete a
  // frond or archive a brief out from under the rest of this seed.
  { frond: "docker-build", action: "return" },
  { frond: "auth-refactor", action: "return" },
];

/** How many trailing (most-recent-first) actionable decisions seedDemoProject() undoes via the real store.undoLast() — not a simulated/fake "undone" flag. */
export const DEMO_UNDO_COUNT = 2;

interface FrondBriefContent {
  goal: string;
  decided: string;
  open: string;
  files: string;
  recentTurn: number;
  recentText: string;
}

const BRIEF_CONTENT: Record<string, FrondBriefContent> = {
  "auth-refactor": {
    goal: "Refactor the auth middleware to use short-lived tokens.",
    decided: "Switch from session cookies to JWTs with a 15 minute TTL.",
    open: "Need to coordinate the mobile client's refresh flow.",
    files: "src/auth-refactor.ts",
    recentTurn: 2,
    recentText: "Switch session auth over to JWTs",
  },
  "docker-build": {
    goal: "Speed up the Docker build for CI.",
    decided: "Cache the dependency layer separately from the source layer.",
    open: "Multi-arch builds are still slow on CI.",
    files: "src/docker-build.ts",
    recentTurn: 5,
    recentText: "Cache the dependency layer in CI",
  },
  "flaky-test": {
    goal: "Stabilize the flaky integration test in the payments suite.",
    decided:
      "Root cause was a race in the test's own setup, not the code under test.",
    open: "",
    files: "src/flaky-test.ts",
    recentTurn: 10,
    recentText: "Found the race in the test's setup",
  },
};

/**
 * Seeds a temp project's `.fern/fern.db` with DEMO_PLAN via the real
 * store API (never hand-rolled SQL — same discipline as
 * e2e/fixtures/seed.ts), then writes real brief files (not empty
 * stubs) for every real frond, then undoes the last DEMO_UNDO_COUNT
 * actionable decisions via the real store.undoLast() — a genuine undo,
 * not a faked "undone" flag.
 */
export async function seedDemoProject(projectPath: string): Promise<{
  store: FernStore;
  sessionId: string;
}> {
  const store = await openFernStore(join(projectPath, ".fern"));
  const session = await store.createSession({
    agent: "fern-demo",
    projectPath,
    mode: "suggest",
  });
  const { frondIdByName } = await seedProjectFromPlan(
    store,
    session.id,
    DEMO_PLAN,
    "demo",
  );

  const { fronds } = await store.getTree(session.id);
  for (const [name, content] of Object.entries(BRIEF_CONTENT)) {
    const frond = fronds.find((f) => f.id === frondIdByName.get(name));
    if (!frond) continue;
    await createBrief(frond.briefPath);
    await writeBriefSections(frond.briefPath, {
      Goal: content.goal,
      Decided: content.decided,
      Open: content.open,
      Files: content.files,
    });
    await pushRecentEntry(
      frond.briefPath,
      content.recentTurn,
      content.recentText,
    );
  }

  for (let i = 0; i < DEMO_UNDO_COUNT; i++) {
    await store.undoLast(session.id);
  }

  return { store, sessionId: session.id };
}
