import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDecision, buildDecisionInverse } from "@context-fern/core";
import { readBrief } from "../src/briefs";
import { type FernStore, openFernStore } from "../src/fern-store";
import { type TempDir, withTempFernDir } from "./test-helpers";
import { applyTurn } from "./undo-helpers";

let dir: TempDir | undefined;
let store: FernStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
  if (dir) await dir.cleanup();
  dir = undefined;
});

async function freshSession() {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  return { store, session };
}

test("undoLast skips no-op continues and reaches back to the newest real decision: prompt, /fern new x, prompt, prompt, undo removes x", async () => {
  const { store, session } = await freshSession();

  await applyTurn(store, session.id, "continue", { target: null }); // prompt 1 (nothing active yet)
  const newX = await applyTurn(store, session.id, "new", { newFrondName: "x" });
  const x = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "x",
  );
  if (!x) throw new Error("not created");
  const continue2 = await applyTurn(store, session.id, "continue", {
    target: x.id,
  }); // prompt 2
  const continue3 = await applyTurn(store, session.id, "continue", {
    target: x.id,
  }); // prompt 3

  await store.undoLast(session.id);

  const { fronds } = await store.getTree(session.id);
  expect(fronds.map((f) => f.name)).toEqual(["stem"]); // x is gone

  const rows = store.db
    .query("SELECT id, action, undone FROM decisions ORDER BY seq ASC")
    .all() as { id: string; action: string; undone: number }[];
  expect(rows.map((r) => r.action)).toEqual([
    "continue",
    "new",
    "continue",
    "continue",
  ]);
  // the two trailing continues are untouched — skipped, not undone
  expect(rows.find((r) => r.id === continue2.id)?.undone).toBe(0);
  expect(rows.find((r) => r.id === continue3.id)?.undone).toBe(0);
  expect(rows.find((r) => r.id === newX.id)?.undone).toBe(1);
});

test("undo new: deletes the created frond, restores the prior active frond", async () => {
  const { store, session } = await freshSession();
  const stem = (await store.getTree(session.id)).fronds[0];

  const decision = await applyTurn(store, session.id, "new", {
    newFrondName: "auth",
  });
  let state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).not.toBeNull();

  await store.undoLast(session.id);

  state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).toBeNull();
  expect(Object.keys(state.fronds)).toHaveLength(0);
  const { fronds } = await store.getTree(session.id);
  expect(fronds.map((f) => f.id)).toEqual([stem?.id ?? ""]);

  const undone = store.db
    .query("SELECT undone FROM decisions WHERE id = ?")
    .get(decision.id) as { undone: number };
  expect(undone.undone).toBe(1);
});

test("undo new: an untouched brief is deleted; a user-edited brief is archived to .fern/fronds/.undone/", async () => {
  const { store, session } = await freshSession();

  const untouched = await applyTurn(store, session.id, "new", {
    newFrondName: "untouched",
  });
  const untouchedFrond = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "untouched",
  );
  await store.undoLast(session.id);
  await expect(
    readFile(untouchedFrond?.briefPath ?? "", "utf-8"),
  ).rejects.toThrow();

  await applyTurn(store, session.id, "new", { newFrondName: "edited" });
  const editedFrond = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "edited",
  );
  // simulate the user hand-editing the file directly — writeBriefSections
  // is a SYSTEM write and would not register as a user edit.
  await writeFile(
    editedFrond?.briefPath ?? "",
    "## Goal\n\n\n## Decided\n\n\n## Open\n\n\n## Files\n\n\n## Notes\n\nmy own investigation\n",
    "utf-8",
  );
  await store.undoLast(session.id);

  const decisionId = store.db
    .query("SELECT id FROM decisions ORDER BY seq DESC LIMIT 1")
    .get() as { id: string };
  const archived = await readBrief(
    join(dir?.path ?? "", "fronds", ".undone", `edited-${decisionId.id}.md`),
  );
  expect(archived.Notes).toBe("my own investigation");
  void untouched;
});

test("undo return: restores the previously-active frond and rests the returned-to one", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  await applyTurn(store, session.id, "new", { newFrondName: "topic-b" });

  await applyTurn(store, session.id, "return", { target: topicA?.id ?? null });
  let state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).toBe(topicA?.id ?? "");

  await store.undoLast(session.id);
  state = await store.loadRouterState(session.id);
  const topicB = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-b",
  );
  expect(state.activeFrondId).toBe(topicB?.id ?? "");
  expect(state.fronds[topicA?.id ?? ""]?.status).toBe("resting");
});

test("undo stray: a stray after an active topic reassigns the leaflet back to it", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );

  const decision = await applyTurn(store, session.id, "stray");
  await store.undoLast(session.id);

  const leafletRow = store.db
    .query("SELECT frond_id, stray_from FROM leaflets WHERE id = ?")
    .get(decision.leafletId) as {
    frond_id: string | null;
    stray_from: string | null;
  };
  expect(leafletRow.frond_id).toBe(topicA?.id ?? "");
  expect(leafletRow.stray_from).toBeNull();
});

test("undo stray: a LEADING stray (nothing active yet) reassigns the leaflet to the stem, not a bare null", async () => {
  const { store, session } = await freshSession();
  const stem = (await store.getTree(session.id)).fronds[0];

  const decision = await applyTurn(store, session.id, "stray");
  await store.undoLast(session.id);

  const leafletRow = store.db
    .query("SELECT frond_id FROM leaflets WHERE id = ?")
    .get(decision.leafletId) as { frond_id: string | null };
  expect(leafletRow.frond_id).toBe(stem?.id ?? "");
});

test("markStray (the real manual command) reassigns the leaflet, and its undo restores the leaflet's OWN prior frond — never the session's current active frond", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  if (!topicA) throw new Error("not created");

  // a plain leaflet that lands on topic-a (as if it were a "continue")
  const oldLeaflet = await store.recordLeaflet({
    sessionId: session.id,
    index: 1,
    frondId: topicA.id,
    strayFrom: null,
    promptHash: "sha256:old",
    tokenCount: 5,
    filesTouched: [],
  });

  // the session moves on to a different topic
  await applyTurn(store, session.id, "new", { newFrondName: "topic-b" });
  const topicBState = await store.loadRouterState(session.id);
  expect(topicBState.activeFrondId).not.toBe(topicA.id);

  // now retroactively mark the OLD leaflet (on topic-a, not the current
  // topic) stray — markStray must never touch the session's active frond
  const strayDecision = await store.markStray(oldLeaflet.id, topicA.id);
  const afterMark = await store.loadRouterState(session.id);
  expect(afterMark.activeFrondId).toBe(topicBState.activeFrondId); // unchanged

  await store.undoLast(session.id); // undoes the markStray (the newest decision)

  const leafletRow = store.db
    .query("SELECT frond_id, stray_from FROM leaflets WHERE id = ?")
    .get(oldLeaflet.id) as {
    frond_id: string | null;
    stray_from: string | null;
  };
  expect(leafletRow.frond_id).toBe(topicA.id); // restored to ITS OWN prior frond
  expect(leafletRow.stray_from).toBeNull();

  const afterUndo = await store.loadRouterState(session.id);
  expect(afterUndo.activeFrondId).toBe(topicBState.activeFrondId); // still unchanged
  void strayDecision;
});

test("combine: recordDecision activates the primary target and leaves the 'with' frond untouched; undo restores both prior statuses", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  await applyTurn(store, session.id, "new", { newFrondName: "topic-b" });
  const topicB = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-b",
  );
  if (!topicA || !topicB) throw new Error("not created");

  const before = await store.loadRouterState(session.id); // topic-b active, topic-a resting
  const leaflet = await store.recordLeaflet({
    sessionId: session.id,
    index: 2,
    frondId: topicA.id,
    strayFrom: null,
    promptHash: "sha256:combine",
    tokenCount: 8,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-combine-1",
    createdAt: new Date().toISOString(),
    sessionId: session.id,
    leafletId: leaflet.id,
    action: "combine",
    target: topicA.id,
    with: topicB.id,
    stage: 0,
    signals: ["test"],
    confidence: 0.8,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "combine"),
  });
  await store.recordDecision(decision, [1, 0]);

  const afterCombine = await store.loadRouterState(session.id);
  expect(afterCombine.activeFrondId).toBe(topicA.id);
  expect(afterCombine.fronds[topicB.id]?.status).toBe("resting"); // "with" frond untouched by the forward path, but it was already resting

  await store.undoLast(session.id);
  const afterUndo = await store.loadRouterState(session.id);
  expect(afterUndo.activeFrondId).toBe(topicB.id);
  expect(afterUndo.fronds[topicA.id]?.status).toBe("resting");
});

test("recordDecision refuses a Decision whose inverse.kind doesn't match its action", async () => {
  const { store, session } = await freshSession();
  const before = await store.loadRouterState(session.id);
  const leaflet = await store.recordLeaflet({
    sessionId: session.id,
    index: 0,
    frondId: null,
    strayFrom: null,
    promptHash: "sha256:bad",
    tokenCount: 1,
    filesTouched: [],
  });
  const badDecision = buildDecision({
    id: "decision-bad-1",
    createdAt: new Date().toISOString(),
    sessionId: session.id,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: 0,
    signals: ["test"],
    confidence: 0.5,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    // wrong on purpose: "new" needs a "router" inverse, not "merge"
    inverse: {
      kind: "merge",
      frondId: "nope",
      priorStatus: "active",
      priorActiveFrondId: "nope",
      decisionId: "decision-bad-1",
    },
  });
  void before;

  await expect(store.recordDecision(badDecision, null)).rejects.toThrow(
    /inverse\.kind/,
  );
  const row = store.db
    .query("SELECT id FROM decisions WHERE id = ?")
    .get(badDecision.id);
  expect(row).toBeNull(); // never persisted — validated before the insert
});

test("the journal mirror receives the undone decision after undoLast", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  await store.undoLast(session.id);

  const fs = await import("node:fs/promises");
  const content = await fs.readFile(
    join(dir?.path ?? "", "journal.jsonl"),
    "utf-8",
  );
  const lines = content
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toHaveLength(2); // the original "new" + the undo
  expect(lines[1].undone).toBe(true);
});

test("a continue's centroid drift is never reverted, because continue is never an undo target at all", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  if (!topicA) throw new Error("not created");

  await applyTurn(store, session.id, "continue", { target: topicA.id });
  const afterContinue = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );

  // a second real decision, unrelated to topic-a, so undoLast has
  // something real to reach for instead of the continue above it
  await applyTurn(store, session.id, "new", { newFrondName: "topic-b" });
  await store.undoLast(session.id); // undoes "new topic-b", not the continue

  const afterUndo = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  expect(afterUndo?.centroid).toEqual(afterContinue?.centroid);

  const continueRow = store.db
    .query("SELECT undone FROM decisions WHERE action = 'continue'")
    .get() as { undone: number };
  expect(continueRow.undone).toBe(0); // never touched
});

test("undoLast throws 'nothing to undo' once everything in the session has been undone", async () => {
  const { store, session } = await freshSession();
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  await store.undoLast(session.id);

  await expect(store.undoLast(session.id)).rejects.toThrow(/nothing to undo/i);
});

test("safety net: a corrupted store (stem row deleted) fails loud instead of writing a bad state", async () => {
  const { store, session } = await freshSession();
  const stem = (await store.getTree(session.id)).fronds[0];
  store.db.query("DELETE FROM fronds WHERE id = ?").run(stem?.id ?? "");

  await expect(store.setActiveFrond(session.id, null)).rejects.toThrow(
    /corrupted store/i,
  );
});

// --- property test: random valid sequence, undo all, back to the start ---

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runPropertyTestWithSeed(seed: number) {
  const { store, session } = await freshSession();
  const rng = mulberry32(seed);
  const topicIds: string[] = [];
  const decisions: { id: string; action: string }[] = [];

  for (let i = 0; i < 20; i++) {
    const state = await store.loadRouterState(session.id);
    const canContinue = state.activeFrondId !== null;
    const otherIds = topicIds.filter(
      (id) => id !== state.activeFrondId && id in state.fronds,
    );
    const canReturn = otherIds.length > 0;

    const options: Array<"continue" | "new" | "return" | "stray"> = [
      "new",
      "stray",
    ];
    if (canContinue) options.push("continue");
    if (canReturn) options.push("return");
    const action = options[Math.floor(rng() * options.length)] ?? "new";

    let decision: { id: string; target?: string | null };
    if (action === "continue") {
      decision = await applyTurn(store, session.id, "continue", {
        target: state.activeFrondId,
      });
    } else if (action === "return") {
      const target = otherIds[Math.floor(rng() * otherIds.length)] ?? null;
      decision = await applyTurn(store, session.id, "return", { target });
    } else if (action === "new") {
      const before = await applyTurn(store, session.id, "new", {});
      if (before.inverse.kind === "router" && before.inverse.createdFrondId) {
        topicIds.push(before.inverse.createdFrondId);
      }
      decision = before;
    } else {
      decision = await applyTurn(store, session.id, "stray", {});
    }
    decisions.push({ id: decision.id, action });
  }

  // "continue" is journaled but never an undo target (see docs/decisions.md)
  // — only loop as many times as there are real, undoable decisions.
  const undoableCount = decisions.filter((d) => d.action !== "continue").length;
  for (let i = 0; i < undoableCount; i++) {
    await store.undoLast(session.id);
  }
  await expect(store.undoLast(session.id)).rejects.toThrow(/nothing to undo/i);

  const finalState = await store.loadRouterState(session.id);
  expect(finalState.activeFrondId).toBeNull();
  expect(Object.keys(finalState.fronds)).toHaveLength(0);
  const { fronds } = await store.getTree(session.id);
  expect(fronds).toHaveLength(1); // only the stem survives
  expect(fronds[0]?.name).toBe("stem");
}

for (const seed of [1, 2, 3, 42, 1337]) {
  test(`property: random sequence of decisions, undone in reverse, returns to the initial tree (seed ${seed})`, async () => {
    await runPropertyTestWithSeed(seed);
  });
}
