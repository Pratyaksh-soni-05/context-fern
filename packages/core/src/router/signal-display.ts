// What a routing decision may honestly show a person: a number only when
// it is a measured similarity score, otherwise the signal that produced
// it. Shared by every display surface (receipts, the UI projection) so
// they cannot disagree about which numbers are real. See docs/decisions.md
// (2026-11-17) and DESIGN.md Voice: never ship an invented number.

import { DEGRADED_SIGNAL } from "./decide";

/** Stage 0 signals whose `confidence` is the frond's own combined similarity score, measured on this prompt. */
const MEASURED_SCORE_SIGNALS = new Set([
  "active-frond-match",
  "other-frond-match",
]);

/**
 * True only for a Stage 0 decision whose confidence is a directly
 * measured similarity score. Everything else stores a number too (the
 * schema requires one) but it is not evidence: a cue-phrase decision's
 * is the complement of unrelated scores capped at 0.95, a manual or
 * forced decision's is a placeholder 1, a heuristic `new`/`stray`'s is
 * a complement, and a decision made with no model has no score at all.
 */
export function hasMeasuredScore(
  stage: number | string | null,
  signals: readonly string[],
): boolean {
  if (String(stage) !== "0") return false; // manual and Stage 2 (an LLM's own stated confidence) are not Stage 0 scores
  if (
    signals.includes("forced-continue") ||
    signals.includes(DEGRADED_SIGNAL)
  ) {
    return false;
  }
  if (signals.some((s) => s.startsWith("cue:"))) return false;
  return signals.some((s) => MEASURED_SCORE_SIGNALS.has(s));
}

/** Human wording for a decision's signals, in order, without repeats; the degraded tag is reported separately and left out. */
export function describeSignals(signals: readonly string[]): string {
  const out: string[] = [];
  for (const signal of signals) {
    if (signal === DEGRADED_SIGNAL) continue;
    const text = signal.startsWith("cue:")
      ? "cue phrase"
      : signal.replace(/[-_]/g, " ");
    if (!out.includes(text)) out.push(text);
  }
  return out.join(", ");
}
