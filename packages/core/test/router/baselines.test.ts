import { expect, test } from "bun:test";
import {
  decideAlwaysContinue,
  decideCuePhrasesOnly,
  decideEmbeddingsOnly,
} from "../../src/router/baselines";
import { DEFAULT_CONFIG } from "../../src/router/config";
import type { FrondState, RouterState, Signals } from "../../src/router/types";

function frond(
  id: string,
  status: "active" | "resting" = "active",
): FrondState {
  return { id, centroid: [1, 0], count: 3, files: [], status };
}

function baseSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    promptEmbedding: new Float32Array([1, 0]),
    mentionedFiles: [],
    stemCosine: 0,
    frondSignals: [],
    hasCue: { new: false, return: false, stray: false },
    isShortQuestion: false,
    ...overrides,
  };
}

test("decideAlwaysContinue always continues, even with a strong cue or a clear topic switch", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1") },
  };
  const signals = baseSignals({
    hasCue: { new: true, return: false, stray: true },
  });

  const decision = decideAlwaysContinue(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("continue");
  expect(decision.target).toBe("frond-1");
});

test("decideCuePhrasesOnly ignores embedding similarity entirely", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1") },
  };
  // Embedding signals say "clearly continue" (score 0.9), but there's no cue —
  // cue-only should still default to continue here, so this case doesn't
  // distinguish much; the real point is the NEXT test.
  const noCueSignals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
    ],
  });
  expect(decideCuePhrasesOnly(noCueSignals, state, DEFAULT_CONFIG).action).toBe(
    "continue",
  );

  // Now: embedding signals say "clearly continue" (score 0.9) but there's an
  // explicit "new" cue. Cue-only must fire new anyway — it can't see the
  // embedding score at all.
  const cueSignals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
    ],
    hasCue: { new: true, return: false, stray: false },
  });
  expect(decideCuePhrasesOnly(cueSignals, state, DEFAULT_CONFIG).action).toBe(
    "new",
  );
});

test("decideEmbeddingsOnly ignores cue phrases entirely, using only the real thresholds", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1") },
  };
  // A strong "new" cue is present, but the embedding score clearly says
  // continue (0.63 >= continueMin 0.3). Embeddings-only must ignore the cue.
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
    ],
    hasCue: { new: true, return: false, stray: false },
  });

  const decision = decideEmbeddingsOnly(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("continue");
  expect(decision.signals).not.toContain("cue:new");
});
