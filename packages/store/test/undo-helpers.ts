// Shared turn-application helper for undo.test.ts and the property test:
// drives the repository API the way a live caller would (createFrond ->
// recordLeaflet -> buildDecisionInverse -> buildDecision -> recordDecision),
// without needing the full embedding/signals pipeline — decisions are
// constructed directly so scenario tests can pick exact actions/targets.

import {
  buildDecision,
  buildDecisionInverse,
  type Decision,
  type RouterAction,
} from "@context-fern/core";
import type { FernStore } from "../src/fern-store";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export async function applyTurn(
  store: FernStore,
  sessionId: string,
  action: RouterAction,
  options: { target?: string | null; newFrondName?: string } = {},
): Promise<Decision> {
  const before = await store.loadRouterState(sessionId);
  let leafletFrondId: string | null = null;
  let strayFrom: string | null = null;
  let newFrondId: string | undefined;

  if (action === "new") {
    const stem = (await store.getTree(sessionId)).fronds.find(
      (f) => f.parentId === null,
    );
    const frond = await store.createFrond({
      sessionId,
      parentId: stem?.id ?? null,
      name: options.newFrondName ?? nextId("frond"),
      colorIndex: 1,
      centroid: [1, 0],
    });
    leafletFrondId = frond.id;
    newFrondId = frond.id;
  } else if (action === "stray") {
    strayFrom = before.activeFrondId;
  } else {
    leafletFrondId = options.target ?? before.activeFrondId;
  }

  const leaflet = await store.recordLeaflet({
    sessionId,
    index: 0,
    frondId: leafletFrondId,
    strayFrom,
    promptHash: `sha256:${nextId("hash")}`,
    tokenCount: 10,
    filesTouched: [],
  });

  const inverse = buildDecisionInverse(before, action, newFrondId);
  const decision = buildDecision({
    id: nextId("decision"),
    createdAt: new Date().toISOString(),
    sessionId,
    leafletId: leaflet.id,
    action,
    target: action === "new" ? null : leafletFrondId,
    stage: 0,
    signals: ["test"],
    confidence: 0.9,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  return store.recordDecision(decision, [1, 0]);
}
