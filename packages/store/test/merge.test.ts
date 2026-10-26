import { afterEach, expect, test } from "bun:test";
import { readBrief, writeBriefSections } from "../src/briefs";
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

async function freshSessionWithFrond(decidedText: string) {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  await applyTurn(store, session.id, "new", { newFrondName: "auth-refactor" });
  const frond = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "auth-refactor",
  );
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, { Decided: decidedText });
  const stem = (await store.getTree(session.id)).fronds.find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("stem not found");
  return { store, session, frond, stem };
}

test("mergeFrond appends the frond's Decided section to the stem, wrapped in a decision-keyed marker", async () => {
  const { store, frond, stem } = await freshSessionWithFrond(
    "switched to JWT-based auth.",
  );

  const decision = await store.mergeFrond(frond.id);

  const stemBrief = await readBrief(stem.briefPath);
  expect(stemBrief.Decided).toContain("switched to JWT-based auth.");
  expect(stemBrief.Decided).toContain(`fern:merge:${decision.id}`);

  const mergedFrond = (await store.getTree(decision.sessionId)).fronds.find(
    (f) => f.id === frond.id,
  );
  expect(mergedFrond?.status).toBe("merged");
});

test("merging the currently-active frond redirects the session's active pointer to the stem, not null", async () => {
  const { store, session, frond, stem } = await freshSessionWithFrond("done.");

  await store.mergeFrond(frond.id);

  const state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).toBeNull(); // router-level: "nothing in focus"

  const row = store.db
    .query("SELECT active_frond_id FROM sessions WHERE id = ?")
    .get(session.id) as { active_frond_id: string };
  expect(row.active_frond_id).toBe(stem.id); // store-level: concrete, never a literal null
});

test("undo of a merge restores the frond's status, the active pointer, and strips exactly its own block", async () => {
  const { store, session, frond, stem } =
    await freshSessionWithFrond("first merge text.");
  const decision = await store.mergeFrond(frond.id);

  await store.undoLast(session.id);

  const restoredFrond = (await store.getTree(session.id)).fronds.find(
    (f) => f.id === frond.id,
  );
  expect(restoredFrond?.status).toBe("active");

  const row = store.db
    .query("SELECT active_frond_id FROM sessions WHERE id = ?")
    .get(session.id) as { active_frond_id: string };
  expect(row.active_frond_id).toBe(frond.id);

  const stemBrief = await readBrief(stem.briefPath);
  expect(stemBrief.Decided).not.toContain(decision.id);
  expect(stemBrief.Decided).not.toContain("first merge text.");
});

test("a second merge's undo never touches the first merge's block", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  await applyTurn(store, session.id, "new", { newFrondName: "topic-a" });
  const topicA = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-a",
  );
  if (!topicA) throw new Error("not created");
  await writeBriefSections(topicA.briefPath, {
    Decided: "topic A's decision.",
  });
  const decisionA = await store.mergeFrond(topicA.id);

  await applyTurn(store, session.id, "new", { newFrondName: "topic-b" });
  const topicB = (await store.getTree(session.id)).fronds.find(
    (f) => f.name === "topic-b",
  );
  if (!topicB) throw new Error("not created");
  await writeBriefSections(topicB.briefPath, {
    Decided: "topic B's decision.",
  });
  await store.mergeFrond(topicB.id);

  // undo only the most recent decision (topic B's merge)
  await store.undoLast(session.id);

  const stem = (await store.getTree(session.id)).fronds.find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("no stem");
  const stemBrief = await readBrief(stem.briefPath);
  expect(stemBrief.Decided).toContain("topic A's decision.");
  expect(stemBrief.Decided).toContain(decisionA.id);
  expect(stemBrief.Decided).not.toContain("topic B's decision.");
});

test("undoing a merge fails loud (no partial strip) if the stem brief was hand-edited since", async () => {
  const { store, session, frond, stem } = await freshSessionWithFrond(
    "will be hand-edited away.",
  );
  await store.mergeFrond(frond.id);

  // user hand-edits the stem brief, removing the marker entirely
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    stem.briefPath,
    "## Goal\n\n\n## Decided\n\nsomething else entirely\n\n## Open\n\n\n## Files\n\n\n## Notes\n\n\n",
    "utf-8",
  );

  await expect(store.undoLast(session.id)).rejects.toThrow(
    /stem brief changed/i,
  );

  const stemBrief = await readBrief(stem.briefPath);
  expect(stemBrief.Decided).toBe("something else entirely"); // untouched by the failed undo
  void session;
});

test("mergeFrond refuses to merge the stem into itself", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  const stem = (await store.getTree(session.id)).fronds[0];

  await expect(store.mergeFrond(stem?.id ?? "")).rejects.toThrow(
    /merge the stem/i,
  );
});
