import type { Embedder, JournalSink, LlmClient } from "../types";
import { decide } from "./decide";
import type { RouteTurnResult } from "./route-turn";
import { computeSignals } from "./signals";
import { adjudicate, type Clock, type Stage2Context } from "./stage2";
import { applyDecision } from "./state";
import type { RouterConfig, RouterDecision, RouterState } from "./types";

export interface Stage2Options {
  llmClient: LlmClient;
  model: string;
  journal: JournalSink;
  clock: Clock;
  /** Forces escalation on every turn regardless of Stage 0's confidence — the always-escalate comparison mode. */
  alwaysEscalate?: boolean;
}

export interface RouteTurnStage2Result extends RouteTurnResult {
  /**
   * What Stage 0 alone would have decided, even on a turn that went on
   * to escalate — needed so a real always-escalate pass can be sliced
   * afterward to simulate any other escalation band (or no escalation
   * at all) without re-calling the LLM. See bench/src/bench/cli.py's
   * `bench eval-stage2`.
   */
  stage0Decision: RouterDecision;
  /** Time for computeSignals + decide (Stage 0), always present. */
  stage0LatencyMs: number;
  /** Time for the adjudicate() call, or null if this turn never escalated. */
  stage2LatencyMs: number | null;
}

/**
 * Mirrors routeTurn's computeSignals -> decide -> applyDecision shape,
 * but after Stage 0 decides, escalates to Stage 2 only when its
 * confidence falls in `config.escalation.{low,high}` (or always, when
 * `alwaysEscalate` is set). `routeTurn`/`decide`/`DecideFn` are
 * untouched by this file — zero risk to Stage 0's existing behavior.
 *
 * Reuses `stage2.clock` (already injected for adjudicate()'s own
 * journaling) to report stage0/stage2 sub-latencies separately to the
 * caller — same injection, not a new clock dependency.
 */
export async function routeTurnStage2(
  prompt: string,
  state: RouterState,
  filesTouchedThisExchange: readonly string[],
  embedder: Embedder,
  config: RouterConfig,
  stage2: Stage2Options,
  context: Omit<Stage2Context, "promptText">,
  newFrondId?: string,
): Promise<RouteTurnStage2Result> {
  const stage0Start = stage2.clock.now();
  const signals = await computeSignals(prompt, state, embedder, config);
  const stage0Decision = decide(signals, state, config);
  const stage0LatencyMs = stage2.clock.now() - stage0Start;

  const { low, high } = config.escalation;
  const inBand =
    stage0Decision.confidence >= low && stage0Decision.confidence <= high;

  let decision = stage0Decision;
  let stage2LatencyMs: number | null = null;
  if (stage2.alwaysEscalate || inBand) {
    const stage2Start = stage2.clock.now();
    decision = await adjudicate(
      stage0Decision,
      signals,
      state,
      config,
      { ...context, promptText: prompt },
      stage2.llmClient,
      stage2.model,
      stage2.journal,
      stage2.clock,
    );
    stage2LatencyMs = stage2.clock.now() - stage2Start;
  }

  const nextState = applyDecision(
    state,
    decision,
    signals.promptEmbedding,
    filesTouchedThisExchange,
    newFrondId,
  );
  return {
    decision,
    nextState,
    stage0Decision,
    stage0LatencyMs,
    stage2LatencyMs,
  };
}
