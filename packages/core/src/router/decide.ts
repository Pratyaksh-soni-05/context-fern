// Pure: thresholds in, decision out. No embedding calls here — all the
// expensive work already happened in computeSignals. This split is what
// lets bench's threshold sweep be cheap: it calls decide() thousands of
// times against signals computed once (see bench/ts/sweep.ts).
//
// "combine" is never produced here — spec §5's Stage 0 signal list has no
// mechanism for detecting "this needs two fronds"; it's Stage 2 / manual
// territory, out of scope for this PR. See docs/decisions.md.

import type {
  FrondSignal,
  RouterConfig,
  RouterDecision,
  RouterState,
  Signals,
} from "./types";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Exported for the baseline decision functions in baselines.ts. */
export function bestOther(
  frondSignals: readonly FrondSignal[],
  excludeId: string | null,
): FrondSignal | undefined {
  let best: FrondSignal | undefined;
  for (const f of frondSignals) {
    if (f.frondId === excludeId) continue;
    if (!best || f.combined > best.combined) best = f;
  }
  return best;
}

export function decide(
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
): RouterDecision {
  const { thresholds } = config;
  const active = state.activeFrondId
    ? signals.frondSignals.find((f) => f.frondId === state.activeFrondId)
    : undefined;
  const activeScore = active?.combined ?? 0;
  const other = bestOther(signals.frondSignals, state.activeFrondId);
  const otherScore = other?.combined ?? 0;
  const maxFrondCosine = signals.frondSignals.reduce(
    (m, f) => Math.max(m, f.cosine),
    0,
  );

  const hasEstablishedContext =
    state.activeFrondId !== null ||
    Object.keys(state.fronds).length > 0 ||
    state.stemCentroid !== null;
  const lowSimilarityEverywhere =
    signals.stemCosine < thresholds.strayMaxSimilarity &&
    maxFrondCosine < thresholds.strayMaxSimilarity;
  const noFileContext = signals.mentionedFiles.length === 0;

  // Explicit cue phrases override heuristics — a user who says "side
  // question" means it, even on the very first prompt of a session.
  if (signals.hasCue.stray) {
    return {
      action: "stray",
      target: null,
      confidence: clamp01(1 - Math.max(signals.stemCosine, maxFrondCosine)),
      signals: ["cue:stray"],
      stage: 0,
    };
  }
  // Heuristic stray needs *something* established to be off-topic from —
  // otherwise the very first prompt of a session (no frond yet) could be
  // misread as a stray instead of founding the first frond.
  if (
    hasEstablishedContext &&
    lowSimilarityEverywhere &&
    noFileContext &&
    signals.isShortQuestion
  ) {
    return {
      action: "stray",
      target: null,
      confidence: clamp01(1 - Math.max(signals.stemCosine, maxFrondCosine)),
      signals: ["low-similarity", "no-file-context", "short-question-form"],
      stage: 0,
    };
  }

  if (signals.hasCue.return && other) {
    return {
      action: "return",
      target: other.frondId,
      confidence: clamp01(otherScore),
      signals: ["cue:return"],
      stage: 0,
    };
  }
  if (signals.hasCue.new) {
    return {
      action: "new",
      target: null,
      confidence: clamp01(1 - Math.max(activeScore, otherScore)),
      signals: ["cue:new"],
      stage: 0,
    };
  }

  // Bias toward continue: it only needs to clear continueMin, while new
  // and stray need to clear their own (stricter) bars below. Anything in
  // the ambiguous middle falls through to the continue-bias fallback.
  if (activeScore >= thresholds.continueMin) {
    return {
      action: "continue",
      target: state.activeFrondId,
      confidence: clamp01(activeScore),
      signals: ["active-frond-match"],
      stage: 0,
    };
  }

  if (other && otherScore >= thresholds.returnMin && otherScore > activeScore) {
    return {
      action: "return",
      target: other.frondId,
      confidence: clamp01(otherScore),
      signals: ["other-frond-match"],
      stage: 0,
    };
  }

  // "No frond matches" is only evidence of a NEW topic when there's at
  // least one existing topic frond it could have matched, AND something
  // positive backs it up — an explicit cue phrase (handled above,
  // unconditionally) or real file divergence: the prompt names files the
  // active frond doesn't touch, with low similarity everywhere. The bare
  // absence of a match is not a positive signal by itself (on a stem with
  // zero fronds, activeScore/otherScore are structurally 0 — nothing to
  // compare against) and must never fire "new" on its own, at any frond
  // count — dogfooding showed a generic question like "what were we
  // working on?" confidently (and wrongly) proposing a new frond for
  // exactly this reason. Short meta-questions (isShortQuestion) are
  // excluded outright: a question about the fern itself is never itself
  // the start of a new topic. See docs/decisions.md.
  const fileDivergence =
    signals.mentionedFiles.length > 0 && (active?.fileOverlap ?? 0) === 0;
  if (
    Object.keys(state.fronds).length > 0 &&
    !signals.isShortQuestion &&
    fileDivergence &&
    activeScore <= thresholds.newMax &&
    otherScore <= thresholds.newMax
  ) {
    return {
      action: "new",
      target: null,
      confidence: clamp01(1 - Math.max(activeScore, otherScore)),
      signals: ["no-frond-match", "file-divergence"],
      stage: 0,
    };
  }

  return {
    action: "continue",
    target: state.activeFrondId,
    confidence: clamp01(activeScore),
    signals: ["fallback-continue-bias"],
    stage: 0,
  };
}
