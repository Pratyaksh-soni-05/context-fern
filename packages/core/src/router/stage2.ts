// Stage 2: an LLM adjudicator for turns where Stage 0 is uncertain. Pure
// in the CLAUDE.md sense — the only ways this file touches the outside
// world are through the injected LlmClient, JournalSink and Clock, never
// directly. See docs/spec.md §5 and docs/decisions.md for the prompt
// design (two narrow yes/no questions, not a 5-way choice — small local
// models are unreliable at open-ended classification).

import type {
  JournalSink,
  LlmClient,
  RouterAction,
  Stage2CallLog,
} from "../types";
import { bestOther } from "./decide";
import type {
  RouterConfig,
  RouterDecision,
  RouterState,
  Signals,
} from "./types";

/**
 * Core has no clock of its own (CLAUDE.md: "no file system, no network,
 * no clock, no randomness. Inject them.") — adjudicate() needs one to
 * measure call latency and stamp the journal entry, so it's injected
 * exactly like Embedder/LlmClient rather than reached for globally.
 */
export interface Clock {
  now(): number;
  nowIso(): string;
}

export interface Stage2Context {
  promptText: string;
  /** Oldest first, at most the last 2 prompts. */
  recentPrompts: readonly string[];
  briefSummary: string | null;
  stemGoal: string | null;
}

interface Stage2LlmResponse {
  same_goal: boolean;
  unrelated: boolean;
  confidence: number;
  reason: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function parseResponse(text: string): Stage2LlmResponse {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).same_goal !== "boolean" ||
    typeof (parsed as Record<string, unknown>).unrelated !== "boolean" ||
    typeof (parsed as Record<string, unknown>).confidence !== "number"
  ) {
    throw new Error(
      "malformed stage2 response: missing same_goal/unrelated/confidence",
    );
  }
  const obj = parsed as Record<string, unknown>;
  return {
    same_goal: obj.same_goal as boolean,
    unrelated: obj.unrelated as boolean,
    confidence: obj.confidence as number,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

/**
 * Deterministic action mapping from the LLM's two yes/no answers — the
 * LLM never picks the action directly, only these two signals. Checked
 * in this order: `same_goal` wins a contradictory `same_goal: true,
 * unrelated: true` response (documented and tested precedence), so a
 * confused model defaults to the safer "continue" rather than "stray".
 */
export function mapAdjudication(
  response: Pick<Stage2LlmResponse, "same_goal" | "unrelated">,
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
): { action: RouterAction; target: string | null } {
  if (response.same_goal) {
    return { action: "continue", target: state.activeFrondId };
  }
  if (response.unrelated) {
    return { action: "stray", target: null };
  }
  const other = bestOther(signals.frondSignals, state.activeFrondId);
  if (other && other.combined > config.thresholds.returnMin) {
    return { action: "return", target: other.frondId };
  }
  return { action: "new", target: null };
}

function buildPrompt(context: Stage2Context): string {
  const brief = context.briefSummary ?? "(no brief available)";
  const stemGoal = context.stemGoal ?? "(no stem goal recorded)";
  const recent =
    context.recentPrompts.length > 0
      ? context.recentPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")
      : "(none)";

  return `You are judging whether a coding assistant's current task is changing.

Project goal (stem): ${stemGoal}
Active topic's brief: ${brief}
Last prompts on this topic, oldest first:
${recent}

New prompt to judge: ${context.promptText}

Answer exactly two yes/no questions about the new prompt:
(a) same_goal: is the new prompt working toward the SAME goal as the active topic above?
(b) unrelated: is the new prompt completely unrelated to this project (e.g. small talk, a different domain entirely)?

Worked examples (made up, not from this project):
1. Active topic: "fix the login auth bug". New prompt: "also check that the session token expires correctly." -> {"same_goal": true, "unrelated": false}
2. Active topic: "refactor the database schema". New prompt: "what's a good recipe for banana bread?" -> {"same_goal": false, "unrelated": true}
3. Active topic: "write unit tests for the payment module". New prompt: "let's set up the CI pipeline for deployments." -> {"same_goal": false, "unrelated": false}
4. Active topic: "implement the search feature". New prompt: "let's go back to the notifications feature we started earlier." -> {"same_goal": false, "unrelated": false}

Respond with ONLY a JSON object, no other text: {"same_goal": boolean, "unrelated": boolean, "confidence": number between 0 and 1, "reason": a short one-sentence reason}`;
}

/**
 * Calls the LLM once, maps its answer to an action, and journals the
 * attempt — succeeded or not. On a malformed response or a thrown error
 * (network, timeout, bad JSON), falls back to `stage0Decision` unchanged
 * (bias toward safety, same spirit as Stage 0's continue bias) but still
 * journals with `succeeded: false` — "no hidden calls" applies to
 * failures too.
 */
export async function adjudicate(
  stage0Decision: RouterDecision,
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
  context: Stage2Context,
  llmClient: LlmClient,
  model: string,
  journal: JournalSink,
  clock: Clock,
): Promise<RouterDecision> {
  const start = clock.now();
  try {
    const response = await llmClient.complete({
      prompt: buildPrompt(context),
      model,
    });
    const latencyMs = clock.now() - start;
    const parsed = parseResponse(response.text);
    const { action, target } = mapAdjudication(parsed, signals, state, config);
    const decision: RouterDecision = {
      action,
      target,
      confidence: clamp01(parsed.confidence),
      signals: [
        `stage2-same_goal:${parsed.same_goal}`,
        `stage2-unrelated:${parsed.unrelated}`,
      ],
      stage: 2,
    };
    const log: Stage2CallLog = {
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs,
      escalatedAction: decision.action,
      escalatedConfidence: decision.confidence,
      succeeded: true,
      createdAt: clock.nowIso(),
    };
    await journal.record(log);
    return decision;
  } catch {
    const latencyMs = clock.now() - start;
    const log: Stage2CallLog = {
      model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      escalatedAction: stage0Decision.action,
      escalatedConfidence: stage0Decision.confidence,
      succeeded: false,
      createdAt: clock.nowIso(),
    };
    await journal.record(log);
    return stage0Decision;
  }
}
