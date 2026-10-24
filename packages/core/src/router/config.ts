import type {
  CueConfig,
  RouterConfig,
  RouterThresholds,
  RouterWeights,
} from "./types";

/** Partial<RouterConfig> only makes the top-level fields optional, not the
 * nested ones — this is what mergeConfig actually needs to accept. */
export interface PartialRouterConfig {
  thresholds?: Partial<RouterThresholds>;
  weights?: Partial<RouterWeights>;
  cues?: Partial<CueConfig>;
}

/**
 * Placeholder values — NOT tuned on data. Per CLAUDE.md, the maintainer
 * decides real thresholds; this PR only drafts the mechanism. The actual
 * numbers come from `bench sweep`'s output (bench/results/thresholds.toml),
 * a measured artifact, never hand-picked here. Deliberately conservative:
 * a wide gap between newMax and continueMin so the fallback continue-bias
 * dominates until real data says otherwise. See docs/decisions.md.
 */
export const DEFAULT_CONFIG: RouterConfig = {
  thresholds: {
    continueMin: 0.3,
    newMax: 0.15,
    returnMin: 0.3,
    strayMaxSimilarity: 0.12,
    strayMaxPromptWords: 12,
  },
  weights: {
    embedding: 0.7,
    fileOverlap: 0.3,
  },
  cues: {
    new: ["switching to", "let's switch to", "new topic", "moving on to"],
    return: ["back to", "returning to", "let's return to", "going back to"],
    stray: [
      "side question",
      "unrelated, but",
      "quick question",
      "off topic",
      "random question",
    ],
  },
};

/** Core stays pure (no fs) — callers read the TOML file and pass the parsed
 * object in; this just fills in anything the file didn't override. */
export function mergeConfig(partial: PartialRouterConfig = {}): RouterConfig {
  return {
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...partial.thresholds },
    weights: { ...DEFAULT_CONFIG.weights, ...partial.weights },
    cues: {
      new: partial.cues?.new ?? DEFAULT_CONFIG.cues.new,
      return: partial.cues?.return ?? DEFAULT_CONFIG.cues.return,
      stray: partial.cues?.stray ?? DEFAULT_CONFIG.cues.stray,
    },
  };
}
