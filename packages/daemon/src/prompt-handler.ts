// POST /prompt's logic — spec §5/§6: continue is the only action ever
// applied without the user asking for it. A plain prompt only ever
// computes a suggestion and persists a forced "continue"; manual
// commands (/fern new|switch|stray, the "? " prefix) apply immediately.
// See the plan's "suggestions vs. applied decisions" note for the full
// reasoning and docs/decisions.md for the dated entry.

import { relative } from "node:path";
import {
  allCuePhrases,
  buildDecision,
  buildDecisionInverse,
  CLI_NAME,
  CONFIG_DIR,
  computeSignals,
  DEGRADED_SIGNAL,
  decide,
  type Embedder,
  type FileTouch,
  hasMeasuredScore,
  isValidFrondName,
  parseStrayPrefix,
  pluralize,
  proposeFrondName,
  type RouterAction,
  sanitizeReplyGist,
} from "@context-fern/core";
import {
  type MergeableBriefSection,
  pushRecentEntry,
  readBrief,
  writeBriefSections,
} from "@context-fern/store";
import { degradedReceipt, type EmbedderHealth } from "./embedder";
import {
  type PendingExchange,
  type ProjectState,
  refreshFrondNames,
  updateAgentSessionId,
} from "./project-registry";
import {
  approxTokenCount,
  DaemonError,
  firstLine,
  hashPrompt,
} from "./prompt-util";
import {
  alreadyExistsReceipt,
  alreadyOnFrondReceipt,
  alreadyOnReceipt,
  mergedReceipt,
  modeNotUndoneNote,
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
  /** Null when Stage 0 had no embedding model: there is no honest number to show. */
  confidence: number | null;
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
 * Deterministic, no-model-call brief fill (dogfooding showed every brief
 * was always an empty template, making even a working restore useless —
 * see docs/decisions.md). Goal is the frond's opening prompt's first
 * line, capped at 140 chars, set once and never overwritten once real
 * content exists — for a frond created by a direct `/fern new <name>`
 * with nothing pending, Goal stays empty here and is filled by the next
 * prompt that lands on it instead. Files is the frond's accumulated
 * touched paths, refreshed every time since it only grows. Both go
 * through `writeBriefSections`' existing per-section merge, so any user
 * edit to either section is always kept over this. Recent (the last 5
 * prompts, newest first) is machine-owned — it's updated via its own
 * `pushRecentEntry`, never through the merge path, every time there's
 * real prompt text, independent of whether Goal was already set.
 *
 * Applies to the stem exactly as it does to any topic frond — most
 * users never run `/fern new` at all, so the stem *is* their only
 * brief, and dogfooding found it permanently empty because an earlier
 * version of this function skipped it outright. The stem's touched
 * files live in `RouterState.stemFiles`, not `fronds[id]` (which only
 * holds topic fronds), so that's read separately.
 */
async function fillBriefDeterministically(
  state: ProjectState,
  frondId: string,
  briefPath: string,
  promptText: string,
  turn: number,
  replyGist?: string | null,
): Promise<void> {
  const updates: Partial<Record<MergeableBriefSection, string>> = {};
  const files =
    frondId === state.stemFrondId
      ? state.routerState.stemFiles
      : (state.routerState.fronds[frondId]?.files ?? []);
  if (files.length > 0) updates.Files = files.join("\n");

  const goalCandidate = firstLine(promptText, 140);
  if (goalCandidate) {
    const current = await readBrief(briefPath);
    if (!current.Goal) updates.Goal = goalCandidate;
  }

  if (Object.keys(updates).length > 0) {
    await writeBriefSections(briefPath, updates);
  }

  await pushRecentEntry(briefPath, turn, goalCandidate, replyGist);
}

/** Manual decisions made while the daemon has no model carry the same journal tag as Stage 0 decisions. */
function manualSignals(state: ProjectState): string[] {
  return state.routingDegraded ? ["manual", DEGRADED_SIGNAL] : ["manual"];
}

/**
 * Commits the in-flight exchange as a forced "continue": a real leaflet
 * (with whatever filesTouched arrived via /tools) and a "continue"
 * Decision onto the currently-active frond. No-ops if nothing is
 * pending — called both by the real /exchange-end and defensively at
 * the top of every /prompt, in case a previous exchange's /exchange-end
 * never arrived (a crashed hook must never silently lose a leaflet).
 */
export async function finalizeExchange(
  state: ProjectState,
  replyGist?: string,
): Promise<void> {
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
    // Tagged so the journal shows every turn routed without a model.
    signals:
      exchange.promptEmbedding === null
        ? ["forced-continue", DEGRADED_SIGNAL]
        : ["forced-continue"],
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

  const targetFrond = (await state.store.listFronds(state.sessionId)).find(
    (f) => f.id === targetFrondId,
  );
  if (targetFrond) {
    await fillBriefDeterministically(
      state,
      targetFrondId,
      targetFrond.briefPath,
      exchange.promptText,
      leaflet.index,
      // Only when the project keeps it (config `[briefs] record_reply_gist`,
      // default on); sanitized again here so whatever reached the daemon
      // is redacted and capped before it touches a file. Brief file only,
      // never fern.db.
      state.config.briefs.recordReplyGist && replyGist
        ? sanitizeReplyGist(replyGist)
        : null,
    );
  }
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

  // Creating a frond whose name already exists must not create a
  // second one — dogfooding found "/fern new greetings" typed twice
  // produced two fronds named "greetings". Switch to the existing one
  // instead, same mechanics as /fern switch, just with a receipt that
  // says what actually happened.
  const existingFronds = await state.store.listFronds(state.sessionId);
  const existing = existingFronds.find(
    (f) => f.name === frondName && f.parentId !== null && f.status !== "merged",
  );
  if (existing) {
    // Already on it: nothing changes, so nothing is recorded — no
    // leaflet, no decision (a `return` that returns nowhere would also
    // be an undoable no-op). A pending exchange stays pending and is
    // finalized as usual by the next plain prompt.
    if (existing.id === state.routerState.activeFrondId) {
      return { receipt: alreadyOnReceipt(frondName) };
    }
    const switched = await applyManualSwitch(state, frondName);
    return { ...switched, receipt: alreadyExistsReceipt(frondName) };
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
    signals: manualSignals(state),
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

  await fillBriefDeterministically(
    state,
    frond.id,
    frond.briefPath,
    exchange?.promptText ?? "",
    leaflet.index,
  );

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

  // Already on it: nothing changes, so nothing is recorded — no
  // leaflet, no decision. A pending exchange stays pending and is
  // finalized by the next plain prompt as usual.
  if (targetId === state.routerState.activeFrondId) {
    return { receipt: alreadyOnFrondReceipt(targetName) };
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
    signals: manualSignals(state),
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

  return { receipt: returnedReceipt(targetName) };
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
      signals: manualSignals(state),
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
    signals: manualSignals(state),
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
    promptText,
    tokenCount: approxTokenCount(promptText),
    promptEmbedding: signals.embeddingUnavailable
      ? null
      : Array.from(signals.promptEmbedding),
    filesTouched: [],
    startedAt: nowIso(),
  } satisfies PendingExchange;

  // With no model the only evidence is an explicit cue phrase the user
  // typed, so that — not a score — is what opens the suggestion gate,
  // and no number is shown. (decide() already returns plain `continue`
  // for everything else in this mode.)
  const degraded = signals.embeddingUnavailable === true;
  const cueDriven = rawDecision.signals.some((s) => s.startsWith("cue:"));
  // A number only where Stage 0 measured one; a cue phrase, a heuristic
  // or a model-less decision shows its signal instead.
  const shownConfidence = hasMeasuredScore(
    rawDecision.stage,
    rawDecision.signals,
  )
    ? rawDecision.confidence
    : null;
  const clears = (min: number) =>
    degraded ? cueDriven : rawDecision.confidence >= min;

  let suggestion: Suggestion | undefined;
  if (
    rawDecision.action === "new" &&
    clears(state.config.suggestionPrecision.new)
  ) {
    // Name proposal never runs on a short meta-question, even when an
    // explicit cue phrase fires "new" on one — a question's own wording
    // about the fern is never the content of the new topic (see
    // decide.ts's no-frond-match guard and docs/decisions.md).
    const proposedName = signals.isShortQuestion
      ? null
      : proposeFrondName(promptText, 3, allCuePhrases(state.config.cues));
    suggestion = {
      action: "new",
      confidence: shownConfidence,
      signals: rawDecision.signals,
      target: null,
      ...(proposedName ? { proposedName } : {}),
    };
  } else if (
    rawDecision.action === "stray" &&
    clears(state.config.suggestionPrecision.stray)
  ) {
    suggestion = {
      action: "stray",
      confidence: shownConfidence,
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
      confidence: shownConfidence,
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
 * The minimal, model-facing focus note: the active frond's name, its
 * brief's Goal first line (if any), and — always, even when the brief
 * is otherwise empty — the brief's own path, project-relative. Dogfooding
 * asked to update a brief by name ("update the fern brief") needs this
 * path in context on every turn, not just when something's been written
 * to Goal yet; this is also what makes that plain-English phrasing work
 * with no slash command at all (see docs/decisions.md). Returns
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

  const relBriefPath = relative(state.projectPath, frond.briefPath).replace(
    /\\/g,
    "/",
  );
  const goalPart = goalLine ? ` · ${goalLine}` : "";
  return `Active frond: ${frond.name}${goalPart} · brief: ${relBriefPath}`;
}

/**
 * SessionStart's own `systemMessage` for a restore is model-only risk
 * territory: whether Claude Code's interactive TUI actually surfaces a
 * SessionStart hook's `systemMessage` to the user couldn't be confirmed
 * from this sandbox (no real interactive session to test against —
 * `claude -p` can't trigger a `/clear` mid-session at all). So this is
 * a deliberate belt-and-suspenders duplicate, not a replacement: the
 * very first `/prompt` call under a new agent session id (the
 * `UserPromptSubmit` right after a resume/clear/compaction/fork) also
 * gets this receipt prepended to its own, already-guaranteed-visible
 * reply. See docs/decisions.md.
 */
function restoredReceiptText(frondName: string, fileCount: number): string {
  const filesPart = fileCount > 0 ? ` · ${pluralize(fileCount, "file")}` : "";
  return `${CLI_NAME} ▸ restored ${frondName} · brief${filesPart}`;
}

export async function handlePrompt(
  state: ProjectState,
  embedder: Embedder,
  promptText: string,
  agentSessionId?: string,
  health: EmbedderHealth = { state: "ok" },
): Promise<PromptResult> {
  // Captured before updateAgentSessionId overwrites it — null only on
  // this project's very first /prompt call ever (nothing to "restore"
  // then); any other change is a real resume/clear/compaction/fork
  // boundary, even though the underlying fern session itself never
  // resets (see project-registry.ts's module doc).
  state.routingDegraded = health.state === "degraded";
  const previousAgentSessionId = state.lastAgentSessionId;
  updateAgentSessionId(state, agentSessionId);
  // ORed with pendingRestoreReceipt (set by SessionStart's own restore
  // call, cleared below) — that flag is the authoritative signal, tied
  // directly to a real SessionStart firing, independent of whether
  // Claude Code happens to mint a new agentSessionId across a
  // resume/clear/compaction/fork (not confirmed either way; see
  // docs/decisions.md). The agentSessionId comparison stays as a second,
  // redundant trigger in case SessionStart's own call never reached the
  // daemon at all (a down daemon, a dropped request).
  const isFirstPromptAfterRestore =
    (previousAgentSessionId !== null &&
      state.lastAgentSessionId !== previousAgentSessionId) ||
    state.pendingRestoreReceipt;
  state.pendingRestoreReceipt = false;

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
  if (focusNote !== undefined) result = { ...result, focusNote };

  // Not in observe mode: restore injects nothing there (spec §6), so a
  // "restored" receipt would claim context that was never sent.
  if (isFirstPromptAfterRestore && state.mode !== "observe") {
    // Works exactly the same on the stem as on any topic frond — most
    // users never run /fern new at all, so the stem is their only
    // brief, and it deserves the same visible restore as a real frond.
    const targetId = state.routerState.activeFrondId ?? state.stemFrondId;
    const frondName = state.frondNames.get(targetId) ?? "stem";
    const fileCount =
      targetId === state.stemFrondId
        ? state.routerState.stemFiles.length
        : (state.routerState.fronds[targetId]?.files.length ?? 0);
    const restored = restoredReceiptText(frondName, fileCount);
    result = {
      ...result,
      receipt: result.receipt ? `${restored}\n${result.receipt}` : restored,
    };
  }

  if (health.state === "degraded" && !state.degradedNoticeShown) {
    state.degradedNoticeShown = true;
    const notice = degradedReceipt(health.reason);
    result = {
      ...result,
      receipt: result.receipt
        ? `${notice}
${result.receipt}`
        : notice,
    };
  }

  return result;
}

export async function handleUndo(
  state: ProjectState,
): Promise<{ receipt: string }> {
  // Read before undoing: the undo is itself journaled, so afterwards the newest entry would be the undo.
  const latest = await state.store.latestJournalEntry();
  const note =
    latest && "action" in latest && latest.action === "mode"
      ? modeNotUndoneNote(latest.before)
      : null;
  let decision: Awaited<ReturnType<typeof state.store.undoLast>>;
  try {
    decision = await state.store.undoLast(state.sessionId);
  } catch (err) {
    if (note && err instanceof Error) {
      throw new Error(`${err.message} · ${note}`);
    }
    throw err;
  }
  state.routerState = await state.store.loadRouterState(state.sessionId);
  await refreshFrondNames(state);
  const receipt = undoneReceipt(decision.action);
  return { receipt: note ? `${receipt} · ${note}` : receipt };
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

/** fern's own bookkeeping (brief files, the journal, the SQLite db) must never land in a frond's Files section — the hook's own extractTouchedFiles already filters this, but /tools is a real HTTP endpoint, not something only the hook can call, so this is enforced again at the one place all touched-file writes funnel through. See docs/decisions.md. */
function isUnderFernDir(relPath: string): boolean {
  return relPath === CONFIG_DIR || relPath.startsWith(`${CONFIG_DIR}/`);
}

export function handleTools(
  state: ProjectState,
  filesTouched: FileTouch[],
): void {
  if (!state.pendingExchange) return; // nothing in flight — ignore silently
  const filtered = filesTouched.filter((f) => !isUnderFernDir(f.path));
  state.pendingExchange.filesTouched.push(...filtered);
}
