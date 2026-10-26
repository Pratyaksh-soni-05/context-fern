import { expect, test } from "bun:test";
import type { Decision, FileTouch, Frond, Leaflet, Root } from "../src/types";

test("a frond with parentId null behaves as the stem", () => {
  const stem: Frond = {
    id: "frond-stem",
    sessionId: "session-1",
    parentId: null,
    name: "stem",
    colorIndex: 0,
    status: "active",
    centroid: null,
    briefPath: ".fern/fronds/stem.md",
    createdAt: "2026-10-24T00:00:00Z",
  };
  const child: Frond = {
    ...stem,
    id: "frond-auth",
    parentId: stem.id,
    name: "auth-refactor",
    colorIndex: 1,
  };

  expect(stem.parentId).toBeNull();
  expect(child.parentId).toBe(stem.id);
});

test("a stray leaflet has frondId null and strayFrom set to the frond it interrupted", () => {
  const touches: FileTouch[] = [
    { path: "src/auth.ts", source: "tool_input" },
    { path: "packages/core/src/index.ts", source: "command" },
  ];
  const stray: Leaflet = {
    id: "leaflet-7",
    sessionId: "session-1",
    index: 7,
    frondId: null,
    strayFrom: "frond-auth",
    promptHash: "sha256:fake",
    tokenCount: 42,
    filesTouched: touches,
    createdAt: "2026-10-24T00:01:00Z",
  };

  expect(stray.frondId).toBeNull();
  expect(stray.strayFrom).toBe("frond-auth");
  expect(stray.filesTouched.map((t) => t.source)).toEqual([
    "tool_input",
    "command",
  ]);
});

test("a root belongs to a project, not a session", () => {
  const root: Root = {
    id: "root-1",
    projectPath: "/repo",
    source: "CLAUDE.md",
    label: "architecture rules",
    contentHash: "sha256:fake",
    createdAt: "2026-10-24T00:02:00Z",
  };

  expect(root.projectPath).toBe("/repo");
  expect(root).not.toHaveProperty("sessionId");
});

test("a merge decision and a combine decision both fit DecisionAction", () => {
  // merge has no leaflet of its own (it's not tied to one exchange) and is
  // "manual" stage, not router output — see docs/decisions.md, 2026-10-26.
  const merge: Decision = {
    id: "decision-1",
    sessionId: "session-1",
    leafletId: null,
    action: "merge",
    target: "frond-stem",
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 1000,
    tokensAfter: 1200,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    undone: false,
    inverse: {
      kind: "merge",
      frondId: "frond-auth",
      priorStatus: "active",
      priorActiveFrondId: "frond-auth",
      decisionId: "decision-1",
    },
    createdAt: "2026-10-24T00:03:00Z",
  };
  const combine: Decision = {
    id: "decision-2",
    sessionId: "session-1",
    leafletId: "leaflet-9",
    action: "combine",
    target: "frond-auth",
    with: "frond-docker",
    stage: 2,
    rootsUsed: ["root-1"],
    signals: ["cue phrase", "low file overlap"],
    confidence: 0.72,
    tokensBefore: 2000,
    tokensAfter: 2600,
    cacheReadTokens: 1800,
    cacheWriteTokens: 200,
    undone: false,
    inverse: {
      kind: "router",
      priorActiveFrondId: "frond-docker",
      priorFrondStatuses: { "frond-docker": "active", "frond-auth": "resting" },
      createdFrondId: null,
    },
    createdAt: "2026-10-24T00:04:00Z",
  };

  expect(merge.action).toBe("merge");
  expect(merge.leafletId).toBeNull();
  expect(merge.stage).toBe("manual");
  expect(combine.with).toBe("frond-docker");
  expect(combine.rootsUsed).toEqual(["root-1"]);
  expect(combine.undone).toBe(false);
});
