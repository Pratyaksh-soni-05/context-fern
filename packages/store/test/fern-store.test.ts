import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { buildDecision, buildDecisionInverse } from "@context-fern/core";
import { type FernStore, openFernStore } from "../src/fern-store";
import {
  type TempDir,
  withRealWorldSpacedDir,
  withTempFernDir,
} from "./test-helpers";

let dir: TempDir | undefined;
let store: FernStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
  if (dir) await dir.cleanup();
  dir = undefined;
});

test("createSession seeds a real stem frond and makes it the active one — never a literal null", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);

  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });

  const { fronds } = await store.getTree(session.id);
  expect(fronds).toHaveLength(1);
  expect(fronds[0]?.name).toBe("stem");
  expect(fronds[0]?.parentId).toBeNull();
  expect(fronds[0]?.status).toBe("active");

  const sessionRow = store.db
    .query("SELECT active_frond_id FROM sessions WHERE id = ?")
    .get(session.id) as { active_frond_id: string | null };
  expect(sessionRow.active_frond_id).toBe(fronds[0]?.id ?? null);
  expect(sessionRow.active_frond_id).not.toBeNull();
});

test("loadRouterState translates the stored stem-active pointer back to router-level null", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });

  const state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).toBeNull();
  expect(state.fronds).toEqual({});
});

test("createFrond + recordLeaflet + recordDecision ('new') makes the new frond active, rests the stem's-worth of nothing, and loadRouterState sees it", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });

  const before = await store.loadRouterState(session.id);
  const stem = (await store.getTree(session.id)).fronds[0];
  const frond = await store.createFrond({
    sessionId: session.id,
    parentId: stem?.id ?? null,
    name: "auth-refactor",
    colorIndex: 1,
    centroid: [1, 0],
  });
  const leaflet = await store.recordLeaflet({
    sessionId: session.id,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:fake",
    tokenCount: 42,
    filesTouched: [],
  });

  const inverse = buildDecisionInverse(before, "new", frond.id);
  const decision = buildDecision({
    id: "decision-1",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId: session.id,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: 0,
    signals: ["no-frond-match"],
    confidence: 0.9,
    tokensBefore: 1000,
    tokensAfter: 1100,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  await store.recordDecision(decision, [1, 0]);

  const state = await store.loadRouterState(session.id);
  expect(state.activeFrondId).toBe(frond.id);
  expect(state.fronds[frond.id]?.status).toBe("active");

  const { fronds } = await store.getTree(session.id);
  const stemAfter = fronds.find((f) => f.name === "stem");
  expect(stemAfter?.status).toBe("active"); // the stem is never rested
});

test("works under a directory path containing a space (the real project path has one)", async () => {
  dir = await withRealWorldSpacedDir();
  store = await openFernStore(dir.path);

  const session = await store.createSession({
    agent: "claude-code",
    projectPath: dir.path,
    mode: "observe",
  });
  const { fronds } = await store.getTree(session.id);
  expect(fronds).toHaveLength(1);
});

test("the journal mirror receives a line for every recorded decision", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  const before = await store.loadRouterState(session.id);
  const stem = (await store.getTree(session.id)).fronds[0];
  const frond = await store.createFrond({
    sessionId: session.id,
    parentId: stem?.id ?? null,
    name: "docker-build",
    colorIndex: 1,
    centroid: [1, 0],
  });
  const leaflet = await store.recordLeaflet({
    sessionId: session.id,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:fake",
    tokenCount: 10,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "decision-1",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId: session.id,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: 0,
    signals: ["no-frond-match"],
    confidence: 0.9,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "new", frond.id),
  });
  await store.recordDecision(decision, [1, 0]);

  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(dir.path, "journal.jsonl"), "utf-8");
  const lines = content.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] as string).id).toBe("decision-1");
});

test("loadRouterState aggregates files_touched from leaflets per frond, and for the stem", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  const stem = (await store.getTree(session.id)).fronds[0];
  if (!stem) throw new Error("no stem");

  const frond = await store.createFrond({
    sessionId: session.id,
    parentId: stem.id,
    name: "auth-refactor",
    colorIndex: 1,
    centroid: [1, 0],
  });
  await store.recordLeaflet({
    sessionId: session.id,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:a",
    tokenCount: 1,
    filesTouched: [{ path: "src/auth.ts", source: "tool_input" }],
  });
  await store.recordLeaflet({
    sessionId: session.id,
    index: 1,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:b",
    tokenCount: 1,
    filesTouched: [
      { path: "src/auth.ts", source: "tool_input" }, // duplicate, deduped
      { path: "src/session.ts", source: "command" },
    ],
  });
  await store.recordLeaflet({
    sessionId: session.id,
    index: 2,
    frondId: stem.id,
    strayFrom: null,
    promptHash: "sha256:c",
    tokenCount: 1,
    filesTouched: [{ path: "README.md", source: "tool_input" }],
  });

  const state = await store.loadRouterState(session.id);
  expect(new Set(state.fronds[frond.id]?.files)).toEqual(
    new Set(["src/auth.ts", "src/session.ts"]),
  );
  expect(state.stemFiles).toEqual(["README.md"]);
});

test("getMostRecentLeaflet returns the latest leaflet by index, or null for an empty session", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });

  expect(await store.getMostRecentLeaflet(session.id)).toBeNull();

  const stem = (await store.getTree(session.id)).fronds[0];
  await store.recordLeaflet({
    sessionId: session.id,
    index: 0,
    frondId: stem?.id ?? null,
    strayFrom: null,
    promptHash: "sha256:first",
    tokenCount: 1,
    filesTouched: [],
  });
  const second = await store.recordLeaflet({
    sessionId: session.id,
    index: 1,
    frondId: stem?.id ?? null,
    strayFrom: null,
    promptHash: "sha256:second",
    tokenCount: 1,
    filesTouched: [],
  });

  const latest = await store.getMostRecentLeaflet(session.id);
  expect(latest?.id).toBe(second.id);
});

test("setMode updates the session's mode", async () => {
  dir = await withTempFernDir();
  store = await openFernStore(dir.path);
  const session = await store.createSession({
    agent: "claude-code",
    projectPath: "/repo",
    mode: "observe",
  });
  expect(session.mode).toBe("observe");

  await store.setMode(session.id, "suggest");

  const row = store.db
    .query("SELECT mode FROM sessions WHERE id = ?")
    .get(session.id) as { mode: string };
  expect(row.mode).toBe("suggest");
});
