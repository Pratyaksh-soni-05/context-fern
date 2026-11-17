// Exact receipt strings — spec §7 / docs/design/blueprint/ClaudeCode.dc.html,
// DESIGN.md Voice ("Plain, short, specific. Receipts start `fern ▸`.").
// One function per shape; each is unit-tested against the literal spec
// strings, not just "contains the right words." Built from CLI_NAME
// (brand.ts), never the literal word "fern" — CLAUDE.md: name and
// design are locked, import the constants, never hard-code them.

import {
  CLI_NAME,
  DEGRADED_SIGNAL,
  describeSignals,
  pluralize,
} from "@context-fern/core";

const PREFIX = `${CLI_NAME} ▸`;
const CMD = `/${CLI_NAME}`;

/**
 * The middle of a suggestion receipt: a number only when there is a
 * measured Stage 0 score, then the signals in plain words. Never an
 * invented number. A "—" appears in exactly one case: the decision was
 * made with no embedding model and rests on no named signal, so it is the
 * place a similarity number would have gone and none could be measured
 * (DESIGN.md Voice; docs/decisions.md, 2026-11-17). A cue phrase or a
 * manual command names itself instead and never shows a dash.
 */
function basis(confidence: number | null, signals: string[]): string {
  const named = describeSignals(signals);
  if (confidence === null && !named && signals.includes(DEGRADED_SIGNAL)) {
    return "—";
  }
  return [confidence === null ? null : confidence.toFixed(2), named || null]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function withBasis(
  head: string,
  confidence: number | null,
  signals: string[],
  tail: string,
): string {
  const middle = basis(confidence, signals);
  return middle ? `${head} · ${middle} · ${tail}` : `${head} · ${tail}`;
}

/** `proposedName` is null when no real content word survived proposeFrondName's extraction — the receipt then asks for a name explicitly rather than showing a fabricated placeholder. */
export function newSuggestionReceipt(
  proposedName: string | null,
  confidence: number | null,
  signals: string[],
): string {
  const namePart = proposedName ? ` ${proposedName}` : "";
  const cmd = proposedName ? `${CMD} new` : `${CMD} new <name>`;
  return withBasis(`${PREFIX} new frond?${namePart}`, confidence, signals, cmd);
}

/** Mirrors newSuggestionReceipt's shape for a return/combine suggestion — spec gives no literal example for this one, so it follows the same voice. */
export function returnSuggestionReceipt(
  frondName: string,
  confidence: number | null,
  signals: string[],
): string {
  return withBasis(
    `${PREFIX} return to ${frondName}?`,
    confidence,
    signals,
    `${CMD} switch`,
  );
}

export function onFrondReceipt(
  activeFrondName: string,
  restingFrondName: string | null,
): string {
  if (!restingFrondName) return `${PREFIX} on ${activeFrondName}`;
  return `${PREFIX} on ${activeFrondName} · ${restingFrondName} rests with its brief`;
}

/** The "? " prefix / an in-flight prompt marked stray immediately — not retroactive, nothing to undo back to a frond assignment that never happened. */
export function strayReceipt(): string {
  return `${PREFIX} stray · answered, kept off every frond`;
}

/** Mirrors newSuggestionReceipt's shape for an unconfirmed stray suggestion. */
export function straySuggestionReceipt(
  confidence: number | null,
  signals: string[],
): string {
  return withBasis(`${PREFIX} stray?`, confidence, signals, `${CMD} stray`);
}

/** A past leaflet retroactively marked stray via bare `/fern stray` — undoable. */
export function strayMarkedReceipt(): string {
  return `${PREFIX} stray (marked) · answered, kept off every frond · ${CMD} undo`;
}

/** A manual `/fern switch` is the user's own command, not a score: no number. */
export function returnedReceipt(frondName: string): string {
  return `${PREFIX} returned to ${frondName} · ${CMD} undo`;
}

/** `/fern switch <name>` for the frond you are already on — nothing to do, so nothing is recorded. */
export function alreadyOnFrondReceipt(frondName: string): string {
  return `${PREFIX} already on ${frondName}`;
}

/** `/fern new <name>` where `<name>` already exists — switched to it instead of creating a duplicate. */
export function alreadyExistsReceipt(frondName: string): string {
  return `${PREFIX} ${frondName} already exists · switched`;
}

/** `/fern new <name>` where `<name>` is the frond you are already on — nothing to do, so nothing is recorded. */
export function alreadyOnReceipt(frondName: string): string {
  return `${PREFIX} ${frondName} already exists · already on it`;
}

export function undoneReceipt(action: string): string {
  return `${PREFIX} undone · ${action} reversed`;
}

export function mergedReceipt(frondName: string): string {
  return `${PREFIX} merged ${frondName} · its Decided section joined the stem`;
}

export function statuslineReceipt(
  activeFrondName: string,
  frondCount: number,
  strayCount: number,
  sentTokens: number,
  fullTokens: number,
): string {
  const base = `${PREFIX} ${activeFrondName} · ${pluralize(frondCount, "frond")} · ${pluralize(strayCount, "stray")}`;
  // Isolate-mode token accounting isn't real yet — omit the clause
  // entirely rather than ship a fabricated "0/0 ctx" (DESIGN.md Voice:
  // never ship invented numbers).
  if (sentTokens <= 0 && fullTokens <= 0) return base;
  return `${base} · ${formatK(sentTokens)}/${formatK(fullTokens)} ctx`;
}

/**
 * `fern status`/`/fern status`'s own receipt — deliberately richer than
 * statuslineReceipt (which stays exactly spec §7's compact terminal
 * format): adds the leaflet count and mode so dogfooding can actually
 * tell whether exchanges are being recorded, without guessing from the
 * compact statusline alone. See docs/decisions.md.
 */
export function statusReceipt(
  activeFrondName: string,
  frondCount: number,
  strayCount: number,
  leafletCount: number,
  mode: string,
  frondOpenings = 0,
): string {
  // Opening a frond records a leaflet of its own (undoing it moves that
  // leaflet back to the stem), so the leaflet count is turns plus
  // openings. Say so rather than leave the extra one unexplained.
  const openings =
    frondOpenings > 0 ? ` · ${pluralize(frondOpenings, "frond opening")}` : "";
  return `${PREFIX} ${activeFrondName} · ${pluralize(frondCount, "frond")} · ${pluralize(strayCount, "stray")} · ${pluralize(leafletCount, "leaflet")}${openings} · ${mode}`;
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
