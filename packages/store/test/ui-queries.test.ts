// fern ui's read-only query layer: listLeafletsWithDecisions (List view),
// getSessionStats (stat tiles), heatmapRows (Categories view),
// countSessionsForProjectPath (Start screen). See docs/decisions.md.

import { afterEach, expect, test } from "bun:test";
import { buildDecision, buildDecisionInverse } from "@context-fern/core";
import { pushRecentEntry } from "../src/briefs";
import { type FernStore, openFernStore } from "../src/fern-store";
import { type TempDir, withTempFernDir } from "./test-helpers";

let dir: TempDir | undefined;
let store: FernStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
  if (dir) await dir.cleanup();
  dir = undefined;
});

async function freshSession(): Promise<{
  store: FernStore;
  sessionId: string;
  stemId: string;
}> {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "suggest",
  });
  const stem = (await store.getTree(session.id)).fronds[0];
  if (!stem) throw new Error("no stem");
  return { store, sessionId: session.id, stemId: stem.id };
}

async function recordContinue(
  s: FernStore,
  sessionId: string,
  frondId: string,
  idx: number,
): Promise<void> {
  const before = await s.loadRouterState(sessionId);
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: idx,
    frondId,
    strayFrom: null,
    promptHash: `sha256:fake-${idx}`,
    tokenCount: 5,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: `decision-continue-${idx}`,
    createdAt: "2026-10-26T00:00:00Z",
    sessionId,
    leafletId: leaflet.id,
    action: "continue",
    target: frondId,
    stage: 0,
    signals: ["forced-continue"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "continue"),
  });
  await s.recordDecision(decision, null);
}

test("listLeafletsWithDecisions paginates and reports a real total", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  for (let i = 0; i < 7; i++) await recordContinue(s, sessionId, stemId, i);

  const page1 = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 3,
  });
  expect(page1.total).toBe(7);
  expect(page1.leaflets.map((l) => l.turn)).toEqual([0, 1, 2]);

  const page2 = await s.listLeafletsWithDecisions(sessionId, {
    offset: 3,
    limit: 3,
  });
  expect(page2.leaflets.map((l) => l.turn)).toEqual([3, 4, 5]);

  const page3 = await s.listLeafletsWithDecisions(sessionId, {
    offset: 6,
    limit: 3,
  });
  expect(page3.leaflets.map((l) => l.turn)).toEqual([6]);
});

test("a forced continue's confidence is null — not the real-looking placeholder 1 it stores internally", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  await recordContinue(s, sessionId, stemId, 0);

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.kind).toBe("continue");
  expect(page.leaflets[0]?.confidence).toBeNull();
});

test("a real stage-0 router decision's confidence passes through untouched", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const before = await s.loadRouterState(sessionId);
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 0,
    frondId: stemId,
    strayFrom: null,
    promptHash: "sha256:real-score",
    tokenCount: 5,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-real-score",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId,
    leafletId: leaflet.id,
    action: "continue",
    target: stemId,
    stage: 0,
    signals: ["similarity"],
    confidence: 0.82,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "continue"),
  });
  await s.recordDecision(decision, null);

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.confidence).toBe(0.82);
});

test("a manual decision's confidence (e.g. a forced 'new') is also null, not its stored placeholder 1", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const before = await s.loadRouterState(sessionId);
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "topic",
    colorIndex: 1,
  });
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:manual-new",
    tokenCount: 5,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-manual-new",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "new", frond.id),
  });
  await s.recordDecision(decision, null);

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.confidence).toBeNull();
});

test("promptPreview matches by the Recent entry's turn tag, not by position — a deduped duplicate leaves the later turn with no match", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "auth-refactor",
    colorIndex: 1,
  });
  for (let i = 0; i < 3; i++) await recordContinue(s, sessionId, frond.id, i);

  // Turn 0 and turn 1 push the exact same text — pushRecentEntry
  // collapses the consecutive duplicate, so only turn 0 gets a tag.
  await pushRecentEntry(frond.briefPath, 0, "fix the login bug");
  await pushRecentEntry(frond.briefPath, 1, "fix the login bug");
  await pushRecentEntry(frond.briefPath, 2, "add a retry");

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  const byTurn = new Map(page.leaflets.map((l) => [l.turn, l]));
  expect(byTurn.get(0)?.promptPreview).toBe("fix the login bug");
  expect(byTurn.get(1)?.promptPreview).toBeNull();
  expect(byTurn.get(2)?.promptPreview).toBe("add a retry");
});

test("a leaflet directly on the stem resolves frondName 'stem' and still maps its own brief's tagged Recent entry", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  await recordContinue(s, sessionId, stemId, 0);
  const stem = (await s.getTree(sessionId)).fronds.find((f) => f.id === stemId);
  if (!stem) throw new Error("no stem");
  await pushRecentEntry(stem.briefPath, 0, "just a plain prompt");

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.frondName).toBe("stem");
  expect(page.leaflets[0]?.isStray).toBe(false);
  expect(page.leaflets[0]?.promptPreview).toBe("just a plain prompt");
});

test("a stray leaflet reports frondName 'stray', isStray true, and the frond it interrupted", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const before = await s.loadRouterState(sessionId);
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 0,
    frondId: null,
    strayFrom: stemId,
    promptHash: "sha256:fake-stray",
    tokenCount: 3,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-stray-1",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId,
    leafletId: leaflet.id,
    action: "stray",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "stray"),
  });
  await s.recordDecision(decision, null);

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.isStray).toBe(true);
  expect(page.leaflets[0]?.frondName).toBe("stray");
  expect(page.leaflets[0]?.strayFromFrondName).toBe("stem");
  expect(page.leaflets[0]?.kind).toBe("stray");
});

test("an undone decision's leaflet survives the undo (reparented to its prior frond, not deleted) and the query doesn't crash on the now-gone created frond", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const before = await s.loadRouterState(sessionId);
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "auth-refactor",
    colorIndex: 1,
  });
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:fake-new",
    tokenCount: 10,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-new-1",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "new", frond.id),
  });
  await s.recordDecision(decision, null);

  const beforeUndo = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(beforeUndo.leaflets[0]?.frondName).toBe("auth-refactor");

  await s.undoLast(sessionId); // deletes the frond, reparents the leaflet to the stem

  const afterUndo = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(afterUndo.leaflets[0]?.frondName).toBe("stem");
  expect(afterUndo.leaflets[0]?.kind).toBe("new");
});

test("getSessionStats counts frond openings, and undoing the opening takes it back out", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  expect((await s.getSessionStats(sessionId)).frondOpenings).toBe(0);

  const before = await s.loadRouterState(sessionId);
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "auth-refactor",
    colorIndex: 0,
    centroid: null,
  });
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:opening",
    tokenCount: 0,
    filesTouched: [],
  });
  await s.recordDecision(
    buildDecision({
      id: "decision-opening",
      createdAt: "2026-10-26T00:00:00Z",
      sessionId,
      leafletId: leaflet.id,
      action: "new",
      target: null,
      stage: "manual",
      signals: ["manual"],
      confidence: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse: buildDecisionInverse(before, "new", frond.id),
    }),
    null,
  );
  expect((await s.getSessionStats(sessionId)).frondOpenings).toBe(1);

  await s.undoLast(sessionId);
  expect((await s.getSessionStats(sessionId)).frondOpenings).toBe(0);
});

test("a leaflet on a frond that later got merged keeps its real frondName and its brief's tagged prompt text", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "flaky-test",
    colorIndex: 1,
  });
  await recordContinue(s, sessionId, frond.id, 0);
  await pushRecentEntry(frond.briefPath, 0, "stop checkout.spec flaking");

  await s.mergeFrond(frond.id);

  const page = await s.listLeafletsWithDecisions(sessionId, {
    offset: 0,
    limit: 10,
  });
  expect(page.leaflets[0]?.frondName).toBe("flaky-test");
  expect(page.leaflets[0]?.promptPreview).toBe("stop checkout.spec flaking");

  const fronds = await s.listFronds(sessionId);
  expect(fronds.find((f) => f.id === frond.id)?.status).toBe("merged");
});

test("getSessionStats: undo rate is 'n/a' (null) under 5 actionable decisions, even with many continues", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  for (let i = 0; i < 20; i++) await recordContinue(s, sessionId, stemId, i);

  const before = await s.loadRouterState(sessionId);
  const frond = await s.createFrond({
    sessionId,
    parentId: stemId,
    name: "auth-refactor",
    colorIndex: 1,
  });
  const leaflet = await s.recordLeaflet({
    sessionId,
    index: 20,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:fake-new",
    tokenCount: 10,
    filesTouched: [],
  });
  await s.recordDecision(
    buildDecision({
      id: "decision-new-only",
      createdAt: "2026-10-26T00:00:00Z",
      sessionId,
      leafletId: leaflet.id,
      action: "new",
      target: null,
      stage: "manual",
      signals: ["manual"],
      confidence: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse: buildDecisionInverse(before, "new", frond.id),
    }),
    null,
  );

  const stats = await s.getSessionStats(sessionId);
  expect(stats.undo).toBeNull();
});

test("getSessionStats: undo rate counts only actionable (non-continue) decisions, with exactly one undone", async () => {
  const { store: s, sessionId, stemId } = await freshSession();

  // Many plain continues — these must never count toward the denominator.
  for (let i = 0; i < 30; i++) await recordContinue(s, sessionId, stemId, i);

  // Five actionable decisions, each creating its own frond.
  let turn = 30;
  for (let i = 0; i < 5; i++) {
    const before = await s.loadRouterState(sessionId);
    const frond = await s.createFrond({
      sessionId,
      parentId: stemId,
      name: `topic-${i}`,
      colorIndex: i + 1,
    });
    const leaflet = await s.recordLeaflet({
      sessionId,
      index: turn++,
      frondId: frond.id,
      strayFrom: null,
      promptHash: `sha256:fake-new-${i}`,
      tokenCount: 10,
      filesTouched: [],
    });
    await s.recordDecision(
      buildDecision({
        id: `decision-new-${i}`,
        createdAt: "2026-10-26T00:00:00Z",
        sessionId,
        leafletId: leaflet.id,
        action: "new",
        target: null,
        stage: "manual",
        signals: ["manual"],
        confidence: 1,
        tokensBefore: 0,
        tokensAfter: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inverse: buildDecisionInverse(before, "new", frond.id),
      }),
      null,
    );
  }

  // Undo the most recent actionable decision (the 5th "new").
  await s.undoLast(sessionId);

  const stats = await s.getSessionStats(sessionId);
  expect(stats.undo).toEqual({ count: 1, of: 5 });
});

test("heatmapRows aggregates into at most maxColumns buckets for a long session", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  for (let i = 0; i < 10; i++) await recordContinue(s, sessionId, stemId, i);

  const { rows, turnsPerCell } = await s.heatmapRows(sessionId, 3);
  expect(turnsPerCell).toBe(4); // ceil(10 / 3)
  for (const row of rows) {
    expect(row.cells.length).toBeLessThanOrEqual(3);
  }
  const stemRow = rows.find((r) => r.frondName === "stem");
  expect(stemRow?.cells.every((c) => c === "stem" || c === null)).toBe(true);
});

test("heatmapRows includes a stray row even with zero strays, and turnsPerCell is 1 for a short session", async () => {
  const { store: s, sessionId, stemId } = await freshSession();
  await recordContinue(s, sessionId, stemId, 0);

  const { rows, turnsPerCell } = await s.heatmapRows(sessionId, 60);
  expect(turnsPerCell).toBe(1);
  expect(rows.some((r) => r.frondName === "stray")).toBe(true);
});

test("countSessionsForProjectPath counts only sessions for that exact path", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  await store.createSession({
    agent: "claude-code",
    projectPath: "/repo-a",
    mode: "suggest",
  });
  await store.createSession({
    agent: "claude-code",
    projectPath: "/repo-a",
    mode: "suggest",
  });
  await store.createSession({
    agent: "claude-code",
    projectPath: "/repo-b",
    mode: "suggest",
  });

  expect(await store.countSessionsForProjectPath("/repo-a")).toBe(2);
  expect(await store.countSessionsForProjectPath("/repo-b")).toBe(1);
  expect(await store.countSessionsForProjectPath("/repo-c")).toBe(0);
});
