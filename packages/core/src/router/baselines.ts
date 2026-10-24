// Baseline decision functions for the eval report's comparison table (task:
// "include baselines in every table so the numbers mean something" — bench
// reports always-continue, cue-phrases-only, embeddings-only and full
// Stage 0 side by side, naming which signal carries most of the result).
// Each has the same (signals, state, config) => RouterDecision shape as
// decide(), so routeTurn can swap in any of them.

import { bestOther, decide } from "./decide";
import type {
  RouterConfig,
  RouterDecision,
  RouterState,
  Signals,
} from "./types";

export function decideAlwaysContinue(
  _signals: Signals,
  state: RouterState,
  _config: RouterConfig,
): RouterDecision {
  return {
    action: "continue",
    target: state.activeFrondId,
    confidence: 1,
    signals: ["baseline:always-continue"],
    stage: 0,
  };
}

/** Cue phrases only — no embedding or file-overlap signal at all. */
export function decideCuePhrasesOnly(
  signals: Signals,
  state: RouterState,
  _config: RouterConfig,
): RouterDecision {
  if (signals.hasCue.stray) {
    return {
      action: "stray",
      target: null,
      confidence: 1,
      signals: ["cue:stray"],
      stage: 0,
    };
  }
  const other = bestOther(signals.frondSignals, state.activeFrondId);
  if (signals.hasCue.return && other) {
    return {
      action: "return",
      target: other.frondId,
      confidence: 1,
      signals: ["cue:return"],
      stage: 0,
    };
  }
  if (signals.hasCue.new) {
    return {
      action: "new",
      target: null,
      confidence: 1,
      signals: ["cue:new"],
      stage: 0,
    };
  }
  return {
    action: "continue",
    target: state.activeFrondId,
    confidence: 1,
    signals: ["baseline:cue-only-default-continue"],
    stage: 0,
  };
}

/**
 * Embedding + file-overlap thresholds only — reuses the real decide()
 * logic with cue flags zeroed out, rather than duplicating the scoring.
 */
export function decideEmbeddingsOnly(
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
): RouterDecision {
  const withoutCues: Signals = {
    ...signals,
    hasCue: { new: false, return: false, stray: false },
  };
  return decide(withoutCues, state, config);
}
