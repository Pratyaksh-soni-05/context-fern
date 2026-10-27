// Exact receipt strings — spec §7 / docs/design/blueprint/ClaudeCode.dc.html,
// DESIGN.md Voice ("Plain, short, specific. Receipts start `fern ▸`.").
// One function per shape; each is unit-tested against the literal spec
// strings, not just "contains the right words." Built from CLI_NAME
// (brand.ts), never the literal word "fern" — CLAUDE.md: name and
// design are locked, import the constants, never hard-code them.

import { CLI_NAME } from "@context-fern/core";

const PREFIX = `${CLI_NAME} ▸`;
const CMD = `/${CLI_NAME}`;

export function newSuggestionReceipt(
  proposedName: string,
  confidence: number,
  signals: string[],
): string {
  return `${PREFIX} new frond? ${proposedName} · ${confidence.toFixed(2)} · ${signals.join(", ")} · ${CMD} new`;
}

/** Mirrors newSuggestionReceipt's shape for a return/combine suggestion — spec gives no literal example for this one, so it follows the same voice. */
export function returnSuggestionReceipt(
  frondName: string,
  confidence: number,
  signals: string[],
): string {
  return `${PREFIX} return to ${frondName}? · ${confidence.toFixed(2)} · ${signals.join(", ")} · ${CMD} switch`;
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
  confidence: number,
  signals: string[],
): string {
  return `${PREFIX} stray? · ${confidence.toFixed(2)} · ${signals.join(", ")} · ${CMD} stray`;
}

/** A past leaflet retroactively marked stray via bare `/fern stray` — undoable. */
export function strayMarkedReceipt(): string {
  return `${PREFIX} stray (marked) · answered, kept off every frond · ${CMD} undo`;
}

export function returnedReceipt(frondName: string, confidence: number): string {
  return `${PREFIX} returned to ${frondName} · ${confidence.toFixed(2)} · ${CMD} undo`;
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
  return `${PREFIX} ${activeFrondName} · ${frondCount} fronds · ${strayCount} strays · ${formatK(sentTokens)}/${formatK(fullTokens)} ctx`;
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
