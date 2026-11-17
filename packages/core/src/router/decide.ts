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

// Every "confidence" below that isn't a real, directly-measured cosine
// similarity is this complement formula — "nothing else matched, so
// call it confident" — which hits exactly 1.00 whenever the underlying
// scores are both exactly 0 (no centroid data yet, or genuinely zero
// overlap). That happened twice in dogfooding (a hardcoded-looking
// 1.00 on a bare stem, then again on a freshly-created frond) and is a
// real, reproducible degenerate case, not a coincidence — Stage 0's
// heuristics were never calibrated against real precision data in the
// first place (see docs/decisions.md on `suggestionPrecision`), so
// presenting a bare algebraic complement as if it were should never
// read as total certainty. Capped below 1.00 rather than fixed at some
// other value — ordering between heuristic suggestions still matters
// for suggestionPrecision's bar.
const HEURISTIC_CONFIDENCE_CAP = 0.95;
function cappedComplement(score: number): number {
  return Math.min(HEURISTIC_CONFIDENCE_CAP, clamp01(1 - score));
}

// A frond is still "forming" for its first few leaflets — its centroid
// is an average of almost nothing yet, and its touched-files list is
// often still empty, so "low similarity" or "file divergence" against
// it is not real evidence of anything. Dogfooding showed the prompt
// right after `/fern new greetings` itself triggering a confident
// (1.00) "new frond?" suggestion against the frond that had just been
// created, for exactly this reason. Scoped to new/stray only — a
// forming frond can still legitimately be left via `return` to a
// genuinely more mature one. See docs/decisions.md.
const FORMING_LEAFLET_THRESHOLD = 3;

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

/** Journal tag on every decision made without a usable embedding. */
export const DEGRADED_SIGNAL = "degraded:no-embedding";

export function decide(
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
): RouterDecision {
  const decision = decideFromSignals(signals, state, config);
  return signals.embeddingUnavailable
    ? { ...decision, signals: [...decision.signals, DEGRADED_SIGNAL] }
    : decision;
}

function decideFromSignals(
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
  // Only meaningful when there IS an active (non-stem) frond — sitting
  // on the stem with no active frond is not "forming" in this sense,
  // and must not suppress new/stray there (e.g. a real file-divergent
  // prompt while on the stem, with other topic fronds existing
  // elsewhere, should still be free to propose "new").
  const activeFrondState = state.activeFrondId
    ? state.fronds[state.activeFrondId]
    : undefined;
  const activeFrondIsForming =
    activeFrondState !== undefined &&
    activeFrondState.count < FORMING_LEAFLET_THRESHOLD;

  // A short question about the conversation itself — never evidence of
  // anything; skip every heuristic and explicit cue phrases alike (a
  // cue phrase inside a question about the session, if that ever
  // happens, is still about the session, not a real topic switch).
  if (signals.isConversationMeta) {
    return {
      action: "continue",
      target: state.activeFrondId,
      confidence: clamp01(activeScore),
      signals: ["conversation-meta-question"],
      stage: 0,
    };
  }

  // Explicit cue phrases override heuristics — a user who says "side
  // question" means it, even on the very first prompt of a session.
  if (signals.hasCue.stray) {
    return {
      action: "stray",
      target: null,
      confidence: cappedComplement(
        Math.max(signals.stemCosine, maxFrondCosine),
      ),
      signals: ["cue:stray"],
      stage: 0,
    };
  }
  // Heuristic stray needs *something* established to be off-topic from —
  // otherwise the very first prompt of a session (no frond yet) could be
  // misread as a stray instead of founding the first frond. Also never
  // fires against a still-forming active frond (see
  // FORMING_LEAFLET_THRESHOLD above) — "low similarity" against a
  // frond with almost no centroid data isn't real evidence.
  // Without an embedding every cosine is a structural 0, so "low
  // similarity everywhere" is always true and proves nothing — this
  // heuristic would otherwise fire on every short question.
  if (
    !signals.embeddingUnavailable &&
    !activeFrondIsForming &&
    hasEstablishedContext &&
    lowSimilarityEverywhere &&
    noFileContext &&
    signals.isShortQuestion
  ) {
    return {
      action: "stray",
      target: null,
      confidence: cappedComplement(
        Math.max(signals.stemCosine, maxFrondCosine),
      ),
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
      confidence: cappedComplement(Math.max(activeScore, otherScore)),
      signals: ["cue:new"],
      stage: 0,
    };
  }

  // No model: nothing below this line is evidence. The remaining rules
  // lean on similarity, or on file overlap, which only ever contributes
  // a fraction of the combined score and cannot carry a suggestion by
  // itself — so without an explicit cue phrase the turn simply
  // continues. The decision's numeric confidence is never displayed in
  // this mode (see docs/decisions.md, 2026-11-14).
  if (signals.embeddingUnavailable) {
    return {
      action: "continue",
      target: state.activeFrondId,
      confidence: clamp01(activeScore),
      signals: ["no-cue"],
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
  // the start of a new topic. Never fires against a still-forming
  // active frond either — an empty touched-files list trivially
  // "diverges" from anything, which isn't real evidence. See
  // docs/decisions.md.
  const fileDivergence =
    signals.mentionedFiles.length > 0 && (active?.fileOverlap ?? 0) === 0;
  if (
    !activeFrondIsForming &&
    Object.keys(state.fronds).length > 0 &&
    !signals.isShortQuestion &&
    fileDivergence &&
    activeScore <= thresholds.newMax &&
    otherScore <= thresholds.newMax
  ) {
    return {
      action: "new",
      target: null,
      confidence: cappedComplement(Math.max(activeScore, otherScore)),
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
