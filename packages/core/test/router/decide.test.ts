import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import { decide } from "../../src/router/decide";
import type {
  FrondState,
  RouterConfig,
  RouterState,
  Signals,
} from "../../src/router/types";

function frond(
  id: string,
  status: "active" | "resting" = "resting",
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

test("continue fires when the active frond's score clears continueMin", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.9, fileOverlap: 0, combined: 0.63 },
    ],
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("continue");
  expect(decision.target).toBe("frond-1");
});

test("low scores alone, with no positive signal, fall through to continue rather than new", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.05, fileOverlap: 0, combined: 0.035 },
    ],
    isShortQuestion: false,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("continue");
  expect(decision.signals).toContain("fallback-continue-bias");
});

test("new fires from no-frond-match when backed by real file divergence from the active frond", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.05, fileOverlap: 0, combined: 0.035 },
    ],
    mentionedFiles: ["src/unrelated.ts"],
    isShortQuestion: false,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("new");
  expect(decision.target).toBeNull();
  expect(decision.signals).toContain("file-divergence");
});

test("a short meta-question never fires new from no-frond-match, even with file divergence", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.05, fileOverlap: 0, combined: 0.035 },
    ],
    mentionedFiles: ["src/unrelated.ts"],
    isShortQuestion: true,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).not.toBe("new");
});

test("new never fires from no-frond-match alone when there are zero topic fronds, regardless of confidence math", () => {
  const state: RouterState = {
    activeFrondId: null,
    stemCentroid: null,
    stemFiles: [],
    fronds: {}, // the exact degenerate case that used to always score confidence 1.0
  };
  const signals = baseSignals({
    stemCosine: 0,
    frondSignals: [],
    mentionedFiles: [],
    isShortQuestion: false,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).not.toBe("new");
  expect(decision.signals).not.toContain("no-frond-match");
});

test("return fires when a non-active frond clearly outscores the active one", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-1": frond("frond-1", "active"),
      "frond-2": frond("frond-2", "resting"),
    },
  };
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 0.05, fileOverlap: 0, combined: 0.035 },
      { frondId: "frond-2", cosine: 0.8, fileOverlap: 0, combined: 0.56 },
    ],
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("return");
  expect(decision.target).toBe("frond-2");
});

test("stray fires on low similarity everywhere, no file context, short question form", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  const signals = baseSignals({
    stemCosine: 0.02,
    frondSignals: [
      { frondId: "frond-1", cosine: 0.03, fileOverlap: 0, combined: 0.021 },
    ],
    mentionedFiles: [],
    isShortQuestion: true,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("stray");
  expect(decision.target).toBeNull();
});

test("stray never fires on the very first prompt of a session (nothing to be off-topic from) — it continues on the stem instead", () => {
  const state: RouterState = {
    activeFrondId: null,
    stemCentroid: null,
    stemFiles: [],
    fronds: {},
  };
  const signals = baseSignals({
    stemCosine: 0,
    frondSignals: [],
    mentionedFiles: [],
    isShortQuestion: true,
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  // Not "new" either: with zero topic fronds, "no-frond-match" isn't
  // evidence of a new topic — the first topic is the stem itself. See
  // docs/decisions.md.
  expect(decision.action).toBe("continue");
});

test("explicit stray cue overrides even on the first prompt of a session", () => {
  const state: RouterState = {
    activeFrondId: null,
    stemCentroid: null,
    stemFiles: [],
    fronds: {},
  };
  const signals = baseSignals({
    hasCue: { new: false, return: false, stray: true },
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("stray");
  expect(decision.signals).toContain("cue:stray");
});

test("bias toward continue: an ambiguous middle score falls back to continue, not new", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: { "frond-1": frond("frond-1", "active") },
  };
  // 0.2 sits between newMax (0.15) and continueMin (0.3) — neither
  // threshold fires confidently, so the fallback should win.
  const signals = baseSignals({
    frondSignals: [
      { frondId: "frond-1", cosine: 2 / 7, fileOverlap: 0, combined: 0.2 },
    ],
  });

  const decision = decide(signals, state, DEFAULT_CONFIG);
  expect(decision.action).toBe("continue");
  expect(decision.signals).toContain("fallback-continue-bias");
});

test("newMax is strictly below continueMin — new requires more confidence than continue", () => {
  expect(DEFAULT_CONFIG.thresholds.newMax).toBeLessThan(
    DEFAULT_CONFIG.thresholds.continueMin,
  );
});

test("decide never produces combine — out of Stage 0's scope in this PR", () => {
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-1": frond("frond-1", "active"),
      "frond-2": frond("frond-2"),
    },
  };
  const configs: RouterConfig = DEFAULT_CONFIG;
  const scoreGrid = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8, 1];

  for (const a of scoreGrid) {
    for (const b of scoreGrid) {
      for (const cue of [true, false]) {
        const signals = baseSignals({
          stemCosine: a,
          frondSignals: [
            { frondId: "frond-1", cosine: a, fileOverlap: 0, combined: a },
            { frondId: "frond-2", cosine: b, fileOverlap: 0, combined: b },
          ],
          hasCue: { new: cue, return: cue, stray: false },
          isShortQuestion: cue,
        });
        const decision = decide(signals, state, configs);
        expect(decision.action).not.toBe("combine");
      }
    }
  }
});
