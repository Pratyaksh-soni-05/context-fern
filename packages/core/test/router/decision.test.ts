import { expect, test } from "bun:test";
import {
  buildDecision,
  buildDecisionInverse,
  type RouterDecisionInverse,
} from "../../src/router/decision";
import type { RouterState } from "../../src/router/types";

function state(overrides: Partial<RouterState> = {}): RouterState {
  return {
    activeFrondId: null,
    stemCentroid: null,
    stemFiles: [],
    fronds: {},
    ...overrides,
  };
}

test("buildDecisionInverse: continue — captures the current active frond and its status, creates nothing", () => {
  const before = state({
    activeFrondId: "f1",
    fronds: {
      f1: { id: "f1", centroid: null, count: 3, files: [], status: "active" },
    },
  });

  const inverse = buildDecisionInverse(before, "continue");

  expect(inverse).toEqual({
    kind: "router",
    priorActiveFrondId: "f1",
    priorFrondStatuses: { f1: "active" },
    createdFrondId: null,
  });
});

test("buildDecisionInverse: new — records createdFrondId, and the prior active frond (if any) to restore", () => {
  const before = state({
    activeFrondId: "f1",
    fronds: {
      f1: { id: "f1", centroid: null, count: 1, files: [], status: "active" },
    },
  });

  const inverse = buildDecisionInverse(before, "new", "f2");

  expect(inverse).toEqual({
    kind: "router",
    priorActiveFrondId: "f1",
    priorFrondStatuses: { f1: "active" },
    createdFrondId: "f2",
  });
});

test("buildDecisionInverse: new from an empty session — priorActiveFrondId null, no prior fronds, still records createdFrondId", () => {
  const inverse = buildDecisionInverse(state(), "new", "f1");

  expect(inverse).toEqual({
    kind: "router",
    priorActiveFrondId: null,
    priorFrondStatuses: {},
    createdFrondId: "f1",
  });
});

test("buildDecisionInverse: return and combine both snapshot every frond's prior status, create nothing", () => {
  const before = state({
    activeFrondId: "f1",
    fronds: {
      f1: { id: "f1", centroid: null, count: 1, files: [], status: "active" },
      f2: { id: "f2", centroid: null, count: 4, files: [], status: "resting" },
    },
  });

  const expected: RouterDecisionInverse = {
    kind: "router",
    priorActiveFrondId: "f1",
    priorFrondStatuses: { f1: "active", f2: "resting" },
    createdFrondId: null,
  };
  expect(buildDecisionInverse(before, "return")).toEqual(expected);
  expect(buildDecisionInverse(before, "combine")).toEqual(expected);
});

test("buildDecisionInverse: stray snapshots the same frond-status state as continue — applying it is a structural no-op", () => {
  const before = state({
    activeFrondId: "f1",
    fronds: {
      f1: { id: "f1", centroid: null, count: 1, files: [], status: "active" },
      f2: { id: "f2", centroid: null, count: 4, files: [], status: "resting" },
    },
  });

  expect(buildDecisionInverse(before, "stray")).toEqual({
    kind: "router",
    priorActiveFrondId: "f1",
    priorFrondStatuses: { f1: "active", f2: "resting" },
    createdFrondId: null,
  });
});

test("buildDecision: assembles a router-stage Decision (stage 0 or 2) with undone:false", () => {
  const decision = buildDecision({
    id: "decision-1",
    createdAt: "2026-10-26T00:00:00Z",
    sessionId: "session-1",
    leafletId: "leaflet-1",
    action: "new",
    target: null,
    stage: 0,
    signals: ["no-frond-match"],
    confidence: 0.9,
    tokensBefore: 1000,
    tokensAfter: 1100,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: {
      kind: "router",
      priorActiveFrondId: null,
      priorFrondStatuses: {},
      createdFrondId: "f1",
    },
  });

  expect(decision).toEqual({
    id: "decision-1",
    sessionId: "session-1",
    leafletId: "leaflet-1",
    action: "new",
    target: null,
    stage: 0,
    signals: ["no-frond-match"],
    confidence: 0.9,
    tokensBefore: 1000,
    tokensAfter: 1100,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    undone: false,
    inverse: {
      kind: "router",
      priorActiveFrondId: null,
      priorFrondStatuses: {},
      createdFrondId: "f1",
    },
    createdAt: "2026-10-26T00:00:00Z",
  });
});

test("buildDecision: a manual command (stage: 'manual') with a real leafletId, e.g. /fern stray", () => {
  const decision = buildDecision({
    id: "decision-2",
    createdAt: "2026-10-26T00:01:00Z",
    sessionId: "session-1",
    leafletId: "leaflet-7",
    action: "stray",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: {
      kind: "router",
      priorActiveFrondId: "f1",
      priorFrondStatuses: { f1: "active" },
      createdFrondId: null,
    },
  });

  expect(decision.stage).toBe("manual");
  expect(decision.leafletId).toBe("leaflet-7");
  expect(decision.undone).toBe(false);
});

test("buildDecision: a merge has no leafletId and a merge-kind inverse", () => {
  const decision = buildDecision({
    id: "decision-3",
    createdAt: "2026-10-26T00:02:00Z",
    sessionId: "session-1",
    leafletId: null,
    action: "merge",
    target: "frond-stem",
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: {
      kind: "merge",
      frondId: "frond-auth",
      priorStatus: "active",
      priorActiveFrondId: "frond-auth",
      decisionId: "decision-3",
    },
  });

  expect(decision.leafletId).toBeNull();
  expect(decision.inverse).toEqual({
    kind: "merge",
    frondId: "frond-auth",
    priorStatus: "active",
    priorActiveFrondId: "frond-auth",
    decisionId: "decision-3",
  });
});
