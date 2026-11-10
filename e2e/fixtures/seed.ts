// Seeds a temp project's .fern/fern.db with a small, realistic
// session via the real store API (never hand-rolled SQL) — synthetic
// text only, shaped like docs/design/blueprint/Prototype.dc.html's
// FRONDS/TURNS (never copied real content), so every Playwright
// screenshot spec has the same known fixture to render and compare
// against the design boards by eye.

import { join } from "node:path";
import {
  buildDecision,
  buildDecisionInverse,
  type DecisionAction,
  type RouterState,
} from "@context-fern/core";
import { type FernStore, openFernStore } from "@context-fern/store";

export interface SeedLeaflet {
  frond: string | null; // null = stem; a frond name otherwise
  action: DecisionAction;
  strayFrom?: string | null; // frond name (or "stem") this stray interrupted
  /** "combine" only: the other frond being combined into `frond`. */
  combineWith?: string;
}

// Mirrors Prototype.dc.html's TURNS shape (synthetic, not copied text).
const PLAN: SeedLeaflet[] = [
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
  { frond: "flaky-test", action: "merge" },
  { frond: "docker-build", action: "return" },
];

/**
 * Runs `plan` against a freshly created session via the real store API
 * (never hand-rolled SQL) — the shared mechanics behind both
 * `seedFixtureProject` (this file's own fixed PLAN, used by every
 * Playwright spec — unchanged, so none of their exact-count assertions
 * are at risk) and `bun run demo`'s richer dataset (`scripts/demo.ts`),
 * which calls this directly with its own, larger plan instead of
 * duplicating the turn-execution logic. See docs/decisions.md.
 */
export async function seedProjectFromPlan(
  store: FernStore,
  sessionId: string,
  plan: SeedLeaflet[],
  agentPrefix = "fixture",
): Promise<{ frondIdByName: Map<string, string>; decisionIds: string[] }> {
  const stem = (await store.getTree(sessionId)).fronds.find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("no stem frond");

  const frondIdByName = new Map<string, string>([["stem", stem.id]]);
  const decisionIds: string[] = [];
  let colorIndex = 1;
  let idx = 0;

  for (const turn of plan) {
    const before: RouterState = await store.loadRouterState(sessionId);

    let targetFrondId: string | null;
    if (turn.action === "stray") {
      targetFrondId = null;
    } else if (turn.frond && !frondIdByName.has(turn.frond)) {
      const frond = await store.createFrond({
        sessionId,
        parentId: stem.id,
        name: turn.frond,
        colorIndex: colorIndex++,
      });
      frondIdByName.set(turn.frond, frond.id);
      targetFrondId = frond.id;
    } else {
      targetFrondId = turn.frond
        ? (frondIdByName.get(turn.frond) ?? null)
        : stem.id;
    }

    if (turn.action === "merge") {
      if (!targetFrondId) throw new Error("merge needs a frond");
      await store.mergeFrond(targetFrondId);
      continue;
    }

    const strayFrom = turn.strayFrom
      ? (frondIdByName.get(turn.strayFrom) ?? null)
      : null;
    const leaflet = await store.recordLeaflet({
      sessionId,
      index: idx++,
      frondId: targetFrondId,
      strayFrom,
      promptHash: `sha256:${agentPrefix}-${idx}`,
      tokenCount: 4 + (idx % 6),
      filesTouched:
        turn.frond && turn.action !== "stray"
          ? [{ path: `src/${turn.frond}.ts`, source: "tool_input" as const }]
          : [],
    });

    const combineWithId =
      turn.action === "combine" && turn.combineWith
        ? frondIdByName.get(turn.combineWith)
        : undefined;
    const inverse =
      turn.action === "new"
        ? buildDecisionInverse(before, "new", targetFrondId ?? undefined)
        : buildDecisionInverse(before, turn.action);
    const decisionId = `${agentPrefix}-decision-${idx}`;
    const decision = buildDecision({
      id: decisionId,
      createdAt: new Date().toISOString(),
      sessionId,
      leafletId: leaflet.id,
      action: turn.action,
      target:
        turn.action === "return" ||
        turn.action === "continue" ||
        turn.action === "combine"
          ? targetFrondId
          : null,
      ...(combineWithId !== undefined ? { with: combineWithId } : {}),
      stage: turn.action === "continue" ? 0 : "manual",
      signals: [turn.action === "continue" ? "forced-continue" : "manual"],
      confidence: 0.75 + (idx % 20) / 100,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse,
    });
    await store.recordDecision(decision, null);
    decisionIds.push(decisionId);
  }

  return { frondIdByName, decisionIds };
}

export async function seedFixtureProject(projectPath: string): Promise<{
  store: FernStore;
  sessionId: string;
}> {
  const store = await openFernStore(join(projectPath, ".fern"));
  const session = await store.createSession({
    agent: "e2e-fixture",
    projectPath,
    mode: "suggest",
  });
  await seedProjectFromPlan(store, session.id, PLAN, "fixture");
  return { store, sessionId: session.id };
}
