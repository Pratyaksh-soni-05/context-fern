// POST /prompt's logic — spec §5/§6: continue is the only action ever
// applied without the user asking for it. A plain prompt only ever
// computes a suggestion and persists a forced "continue"; manual
// commands (/fern new|switch|stray, the "? " prefix) apply immediately.
// See the plan's "suggestions vs. applied decisions" note for the full
// reasoning and docs/decisions.md for the dated entry.

import {
  buildDecision,
  buildDecisionInverse,
  CLI_NAME,
  computeSignals,
  decide,
  type Embedder,
  type FileTouch,
  isValidFrondName,
  parseStrayPrefix,
  proposeFrondName,
  type RouterAction,
} from "@context-fern/core";
import { readBrief } from "@context-fern/store";
import {
  type PendingExchange,
  type ProjectState,
  refreshFrondNames,
} from "./project-registry";
import { approxTokenCount, DaemonError, hashPrompt } from "./prompt-util";
import {
  mergedReceipt,
  newSuggestionReceipt,
  onFrondReceipt,
  returnedReceipt,
  returnSuggestionReceipt,
  strayMarkedReceipt,
  strayReceipt,
  straySuggestionReceipt,
  undoneReceipt,
} from "./receipts";

export interface Suggestion {
  action: RouterAction;
  confidence: number;
  signals: string[];
  target: string | null;
  proposedName?: string;
}

export interface PromptResult {
  receipt: string;
  suggestion?: Suggestion;
  /** Active frond's name + its brief's first Goal line — the minimal, model-facing note (hookSpecificOutput.additionalContext). Omitted in observe mode. */
  focusNote?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function nextLeafletIndex(state: ProjectState): Promise<number> {
  const last = await state.store.getMostRecentLeaflet(state.sessionId);
  return (last?.index ?? -1) + 1;
}

async function nextColorIndex(state: ProjectState): Promise<number> {
  const fronds = await state.store.listFronds(state.sessionId);
  return fronds.filter((f) => f.parentId !== null).length;
}

/**
 * Commits the in-flight exchange as a forced "continue": a real leaflet
 * (with whatever filesTouched arrived via /tools) and a "continue"
 * Decision onto the currently-active frond. No-ops if nothing is
 * pending — called both by the real /exchange-end and defensively at
 * the top of every /prompt, in case a previous exchange's /exchange-end
 * never arrived (a crashed hook must never silently lose a leaflet).
 */
export async function finalizeExchange(state: ProjectState): Promise<void> {
  const exchange = state.pendingExchange;
  if (!exchange) return;

  const targetFrondId = state.routerState.activeFrondId ?? state.stemFrondId;
  const leaflet = await state.store.recordLeaflet({
    sessionId: state.sessionId,
    index: await nextLeafletIndex(state),
    frondId: targetFrondId,
    strayFrom: null,
    promptHash: exchange.promptHash,
    tokenCount: exchange.tokenCount,
    filesTouched: exchange.filesTouched,
  });

  const inverse = buildDecisionInverse(state.routerState, "continue");
  const decision = buildDecision({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    sessionId: state.sessionId,
    leafletId: leaflet.id,
    action: "continue",
    target: targetFrondId,
    stage: 0,
    signals: ["forced-continue"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  await state.store.recordDecision(decision, exchange.promptEmbedding);

  state.routerState = await state.store.loadRouterState(state.sessionId);
  state.pendingExchange = null;
}

interface ManualCommand {
  type: "new" | "switch" | "stray";
  name: string | undefined;
}

// Built from CLI_NAME, never the literal word "fern" — if CLI_NAME ever
// changes (brand.ts's own header note says the CLI name may, before
// launch), command *recognition* must move with it, not just display
// strings. `\/` is escaped once; CLI_NAME itself has no regex-special
// characters today, but this still shouldn't silently break if it grew one.
const ESCAPED_CLI_NAME = CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NEW_COMMAND_RE = new RegExp(
  `^\\/${ESCAPED_CLI_NAME} new(?:\\s+(\\S.*))?$`,
);
const SWITCH_COMMAND_RE = new RegExp(
  `^\\/${ESCAPED_CLI_NAME} switch(?:\\s+(\\S.*))?$`,
);
const STRAY_COMMAND_RE = new RegExp(`^\\/${ESCAPED_CLI_NAME} stray\\s*$`);

function parseManualCommand(text: string): ManualCommand | null {
  const trimmed = text.trim();
  let m = NEW_COMMAND_RE.exec(trimmed);
  if (m) return { type: "new", name: m[1]?.trim() };
  m = SWITCH_COMMAND_RE.exec(trimmed);
  if (m) return { type: "switch", name: m[1]?.trim() };
  m = STRAY_COMMAND_RE.exec(trimmed);
  if (m) return { type: "stray", name: undefined };
  return null;
}

async function applyManualNew(
  state: ProjectState,
  name: string | undefined,
): Promise<PromptResult> {
  const pending = state.pendingSuggestion;
  let frondName = name;
  if (!frondName) {
    if (pending?.action !== "new") {
      throw new DaemonError(
        `No pending 'new' suggestion to accept — pass a name: /${CLI_NAME} new <name>`,
      );
    }
    if (!pending.proposedName) {
      throw new DaemonError(
        `No good name could be proposed from that prompt — pass one: /${CLI_NAME} new <name>`,
      );
    }
    frondName = pending.proposedName;
  }
  // A manually-typed name (as opposed to proposeFrondName's own output,
  // which always matches this already) becomes part of a real file path
  // (.fern/fronds/<name>.md) — validate before it ever reaches that
  // write, rather than trying to escape a bad one. See docs/decisions.md.
  if (!isValidFrondName(frondName)) {
    throw new DaemonError(
      `"${frondName}" isn't a valid frond name — use lowercase letters, digits, and hyphens only.`,
    );
  }

  const exchange = state.pendingExchange;
  const priorActiveFrondId = state.routerState.activeFrondId;

  const frond = await state.store.createFrond({
    sessionId: state.sessionId,
    parentId: state.stemFrondId,
    name: frondName,
    colorIndex: await nextColorIndex(state),
    centroid: exchange?.promptEmbedding ?? null,
  });
  state.frondNames.set(frond.id, frond.name);

  const leaflet = await state.store.recordLeaflet({
    sessionId: state.sessionId,
    index: await nextLeafletIndex(state),
    frondId: frond.id,
    strayFrom: null,
    promptHash:
      exchange?.promptHash ?? hashPrompt(`/${CLI_NAME} new ${frondName}`),
    tokenCount: exchange?.tokenCount ?? 0,
    filesTouched: exchange?.filesTouched ?? [],
  });

  const inverse = buildDecisionInverse(state.routerState, "new", frond.id);
  const decision = buildDecision({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    sessionId: state.sessionId,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  await state.store.recordDecision(decision, exchange?.promptEmbedding ?? null);

  state.routerState = await state.store.loadRouterState(state.sessionId);
  state.pendingExchange = null;
  state.pendingSuggestion = null;

  const restingName = priorActiveFrondId
    ? (state.frondNames.get(priorActiveFrondId) ?? null)
    : null;
  return { receipt: onFrondReceipt(frondName, restingName) };
}

async function applyManualSwitch(
  state: ProjectState,
  name: string | undefined,
): Promise<PromptResult> {
  let targetId: string;
  let targetName: string;

  if (name) {
    const fronds = await state.store.listFronds(state.sessionId);
    const match = fronds.find(
      (f) => f.name === name && f.parentId !== null && f.status !== "merged",
    );
    if (!match) throw new DaemonError(`No frond named "${name}" to switch to.`);
    targetId = match.id;
    targetName = match.name;
  } else {
    const pending = state.pendingSuggestion;
    if (
      !pending ||
      (pending.action !== "return" && pending.action !== "combine") ||
      !pending.target
    ) {
      throw new DaemonError(
        `No pending return suggestion to accept — pass a name: /${CLI_NAME} switch <name>`,
      );
    }
    targetId = pending.target;
    targetName = state.frondNames.get(targetId) ?? targetId;
  }

  const exchange = state.pendingExchange;
  const leaflet = await state.store.recordLeaflet({
    sessionId: state.sessionId,
    index: await nextLeafletIndex(state),
    frondId: targetId,
    strayFrom: null,
    promptHash:
      exchange?.promptHash ?? hashPrompt(`/${CLI_NAME} switch ${targetName}`),
    tokenCount: exchange?.tokenCount ?? 0,
    filesTouched: exchange?.filesTouched ?? [],
  });

  const inverse = buildDecisionInverse(state.routerState, "return");
  const decision = buildDecision({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    sessionId: state.sessionId,
    leafletId: leaflet.id,
    action: "return",
    target: targetId,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  await state.store.recordDecision(decision, exchange?.promptEmbedding ?? null);

  state.routerState = await state.store.loadRouterState(state.sessionId);
  state.pendingExchange = null;
  state.pendingSuggestion = null;

  return { receipt: returnedReceipt(targetName, 1) };
}

async function applyManualStray(state: ProjectState): Promise<PromptResult> {
  // If the triggering exchange hasn't been finalized yet (the common
  // case: the suggestion and this acceptance happen within the same
  // turn boundary), reclassify IT directly — same pattern as
  // applyManualNew/applyManualSwitch — rather than reaching for an
  // older, already-finalized leaflet and leaving this one to be wrongly
  // recorded as a "continue" later.
  const exchange = state.pendingExchange;
  if (exchange) {
    const strayFrom = state.routerState.activeFrondId ?? state.stemFrondId;
    const leaflet = await state.store.recordLeaflet({
      sessionId: state.sessionId,
      index: await nextLeafletIndex(state),
      frondId: null,
      strayFrom,
      promptHash: exchange.promptHash,
      tokenCount: exchange.tokenCount,
      filesTouched: exchange.filesTouched,
    });
    const inverse = buildDecisionInverse(state.routerState, "stray");
    const decision = buildDecision({
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      sessionId: state.sessionId,
      leafletId: leaflet.id,
      action: "stray",
      target: null,
      stage: "manual",
      signals: ["manual"],
      confidence: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inverse,
    });
    await state.store.recordDecision(decision, null);
    state.routerState = await state.store.loadRouterState(state.sessionId);
    state.pendingExchange = null;
    state.pendingSuggestion = null;
    return { receipt: strayMarkedReceipt() };
  }

  const leaflet = await state.store.getMostRecentLeaflet(state.sessionId);
  if (!leaflet) throw new DaemonError("No exchange yet to mark as stray.");

  await state.store.markStray(leaflet.id, leaflet.frondId);
  state.routerState = await state.store.loadRouterState(state.sessionId);
  state.pendingSuggestion = null;

  return { receipt: strayMarkedReceipt() };
}

async function applyImmediateStray(
  state: ProjectState,
  strippedText: string,
): Promise<PromptResult> {
  const strayFrom = state.routerState.activeFrondId ?? state.stemFrondId;
  const leaflet = await state.store.recordLeaflet({
    sessionId: state.sessionId,
    index: await nextLeafletIndex(state),
    frondId: null,
    strayFrom,
    promptHash: hashPrompt(strippedText),
    tokenCount: approxTokenCount(strippedText),
    filesTouched: [],
  });

  const inverse = buildDecisionInverse(state.routerState, "stray");
  const decision = buildDecision({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    sessionId: state.sessionId,
    leafletId: leaflet.id,
    action: "stray",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse,
  });
  await state.store.recordDecision(decision, null);

  state.routerState = await state.store.loadRouterState(state.sessionId);
  state.pendingSuggestion = null;

  return { receipt: strayReceipt() };
}

function suggestionReceipt(s: Suggestion, state: ProjectState): string {
  if (s.action === "new") {
    return newSuggestionReceipt(
      s.proposedName ?? null,
      s.confidence,
      s.signals,
    );
  }
  if (s.action === "stray") {
    return straySuggestionReceipt(s.confidence, s.signals);
  }
  // return / combine
  const name = s.target ? (state.frondNames.get(s.target) ?? s.target) : "?";
  return returnSuggestionReceipt(name, s.confidence, s.signals);
}

async function handlePlainPrompt(
  state: ProjectState,
  embedder: Embedder,
  promptText: string,
): Promise<PromptResult> {
  state.pendingSuggestion = null; // expires on every new plain prompt

  const signals = await computeSignals(
    promptText,
    state.routerState,
    embedder,
    state.config,
  );
  const rawDecision = decide(signals, state.routerState, state.config);

  state.pendingExchange = {
    promptHash: hashPrompt(promptText),
    tokenCount: approxTokenCount(promptText),
    promptEmbedding: Array.from(signals.promptEmbedding),
    filesTouched: [],
    startedAt: nowIso(),
  } satisfies PendingExchange;

  let suggestion: Suggestion | undefined;
  if (
    rawDecision.action === "new" &&
    rawDecision.confidence >= state.config.suggestionPrecision.new
  ) {
    const proposedName = proposeFrondName(promptText);
    suggestion = {
      action: "new",
      confidence: rawDecision.confidence,
      signals: rawDecision.signals,
      target: null,
      ...(proposedName ? { proposedName } : {}),
    };
  } else if (
    rawDecision.action === "stray" &&
    rawDecision.confidence >= state.config.suggestionPrecision.stray
  ) {
    suggestion = {
      action: "stray",
      confidence: rawDecision.confidence,
      signals: rawDecision.signals,
      target: null,
    };
  } else if (
    rawDecision.action === "return" ||
    rawDecision.action === "combine"
  ) {
    // always shown — no measured precision bar for these yet (spec §5)
    suggestion = {
      action: rawDecision.action,
      confidence: rawDecision.confidence,
      signals: rawDecision.signals,
      target: rawDecision.target,
    };
  }
  state.pendingSuggestion = suggestion ?? null;

  return {
    receipt: suggestion ? suggestionReceipt(suggestion, state) : "",
    ...(suggestion ? { suggestion } : {}),
  };
}

/**
 * The minimal, model-facing focus note: the active frond's name plus
 * the first non-blank line of its brief's Goal section. Returns
 * undefined in observe mode (spec §6: no change to model input) or if
 * the active frond's brief can't be read.
 */
async function buildFocusNote(
  state: ProjectState,
): Promise<string | undefined> {
  if (state.mode === "observe") return undefined;

  const frondId = state.routerState.activeFrondId ?? state.stemFrondId;
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.id === frondId);
  if (!frond) return undefined;

  const sections = await readBrief(frond.briefPath).catch(() => null);
  const goalLine = sections?.Goal.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  return goalLine ? `${frond.name}: ${goalLine}` : frond.name;
}

export async function handlePrompt(
  state: ProjectState,
  embedder: Embedder,
  promptText: string,
): Promise<PromptResult> {
  // Manual commands get first access to whatever exchange is still
  // pending — accepting a suggestion (bare /fern new|switch) or a bare
  // /fern stray must be able to reclassify the prompt that produced it
  // (its real promptHash/embedding/filesTouched-so-far), not have it
  // force-finalized into a "continue" out from under them first. Each
  // of apply{ManualNew,ManualSwitch,ManualStray} reads
  // state.pendingExchange itself and clears it once consumed — see
  // docs/decisions.md, 2026-10-27 (this ordering bug was found and
  // fixed in review, with a regression test).
  const manual = parseManualCommand(promptText);
  let result: PromptResult;
  if (manual) {
    if (manual.type === "new")
      result = await applyManualNew(state, manual.name);
    else if (manual.type === "switch")
      result = await applyManualSwitch(state, manual.name);
    else result = await applyManualStray(state);
  } else {
    // Not a manual command: any exchange still pending from an earlier
    // turn that never reached /exchange-end (crashed hook, timeout) must
    // not be silently lost — finalize it now, before treating this text
    // as a fresh prompt.
    await finalizeExchange(state);

    const strayPrefixed = parseStrayPrefix(promptText);
    result = strayPrefixed.isStray
      ? await applyImmediateStray(state, strayPrefixed.prompt)
      : await handlePlainPrompt(state, embedder, promptText);
  }

  const focusNote = await buildFocusNote(state);
  return focusNote !== undefined ? { ...result, focusNote } : result;
}

export async function handleUndo(
  state: ProjectState,
): Promise<{ receipt: string }> {
  const decision = await state.store.undoLast(state.sessionId);
  state.routerState = await state.store.loadRouterState(state.sessionId);
  await refreshFrondNames(state);
  return { receipt: undoneReceipt(decision.action) };
}

export async function handleMerge(
  state: ProjectState,
  frondName: string,
): Promise<{ receipt: string }> {
  const fronds = await state.store.listFronds(state.sessionId);
  const match = fronds.find((f) => f.name === frondName && f.parentId !== null);
  if (!match) throw new DaemonError(`No frond named "${frondName}" to merge.`);

  await state.store.mergeFrond(match.id);
  state.routerState = await state.store.loadRouterState(state.sessionId);
  return { receipt: mergedReceipt(frondName) };
}

export function handleTools(
  state: ProjectState,
  filesTouched: FileTouch[],
): void {
  if (!state.pendingExchange) return; // nothing in flight — ignore silently
  state.pendingExchange.filesTouched.push(...filesTouched);
}
