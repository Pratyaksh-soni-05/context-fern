// State update after a decision. Pure: returns a new RouterState, never
// mutates the one it was given. See docs/decisions.md for why stray is a
// no-op and why the stem isn't updated here.

import { runningMean } from "./math";
import type { FrondState, RouterDecision, RouterState } from "./types";

export function emptyState(): RouterState {
  return { activeFrondId: null, stemCentroid: null, stemFiles: [], fronds: {} };
}

function updateFrond(
  frond: FrondState,
  embedding: ArrayLike<number>,
  files: readonly string[],
): FrondState {
  return {
    ...frond,
    // A zero-length embedding means "no model" (see Signals'
    // embeddingUnavailable): the leaflet still counts, the centroid
    // must not be overwritten with nothing.
    centroid:
      embedding.length === 0
        ? frond.centroid
        : runningMean(frond.centroid, frond.count, embedding),
    count: frond.count + 1,
    files: Array.from(new Set([...frond.files, ...files])),
    status: "active",
  };
}

/** Every other currently-active frond rests; `exceptId` stays active. */
function restOthers(
  fronds: Record<string, FrondState>,
  exceptId: string,
): Record<string, FrondState> {
  const out: Record<string, FrondState> = {};
  for (const [id, f] of Object.entries(fronds)) {
    out[id] =
      id === exceptId || f.status !== "active"
        ? f
        : { ...f, status: "resting" };
  }
  return out;
}

/**
 * Applies a decision to the prior state. `filesTouchedThisExchange` must be
 * from the CURRENT exchange and must only ever be passed here, never into
 * the decision function itself — see router/route-turn.ts and its
 * no-leakage test.
 */
export function applyDecision(
  state: RouterState,
  decision: RouterDecision,
  promptEmbedding: ArrayLike<number>,
  filesTouchedThisExchange: readonly string[],
  newFrondId?: string,
): RouterState {
  switch (decision.action) {
    case "continue": {
      const activeId = state.activeFrondId;
      const activeFrond = activeId ? state.fronds[activeId] : undefined;
      if (!activeId || !activeFrond) return state;
      const updated = updateFrond(
        activeFrond,
        promptEmbedding,
        filesTouchedThisExchange,
      );
      return { ...state, fronds: { ...state.fronds, [activeId]: updated } };
    }
    case "new": {
      if (!newFrondId) {
        throw new Error(
          "applyDecision: newFrondId is required for action 'new'",
        );
      }
      const fresh: FrondState = {
        id: newFrondId,
        centroid:
          promptEmbedding.length === 0 ? null : Array.from(promptEmbedding),
        count: 1,
        files: Array.from(new Set(filesTouchedThisExchange)),
        status: "active",
      };
      const fronds = restOthers(
        { ...state.fronds, [newFrondId]: fresh },
        newFrondId,
      );
      return { ...state, activeFrondId: newFrondId, fronds };
    }
    case "return":
    case "combine": {
      // combine's `with` frond is deliberately left untouched — only the
      // primary target's state updates. See docs/decisions.md.
      const targetId = decision.target;
      const targetFrond = targetId ? state.fronds[targetId] : undefined;
      if (!targetId || !targetFrond) return state;
      const updated = updateFrond(
        targetFrond,
        promptEmbedding,
        filesTouchedThisExchange,
      );
      const fronds = restOthers(
        { ...state.fronds, [targetId]: updated },
        targetId,
      );
      return { ...state, activeFrondId: targetId, fronds };
    }
    case "stray":
      return state; // kept off every frond — no state change at all
    default:
      return state;
  }
}
