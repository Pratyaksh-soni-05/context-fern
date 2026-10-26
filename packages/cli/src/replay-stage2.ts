import {
  type Clock,
  type Embedder,
  emptyState,
  type JournalSink,
  type LlmClient,
  type RouterConfig,
  routeTurnStage2,
} from "@context-fern/core";
import type { ReplayTurnInput, ReplayTurnOutput } from "./replay";
import { FrondBranchMapper, groupAndSortByStream } from "./replay-common";

export interface ReplayStage2Options {
  llmClient: LlmClient;
  model: string;
  journal: JournalSink;
  clock: Clock;
  /** Forces escalation on every turn — the always-escalate comparison mode. */
  alwaysEscalate?: boolean;
}

const RECENT_PROMPTS_WINDOW = 2;

/**
 * Stage 0 + Stage 2 replay: same grouping/sorting/frond-to-branch mapping
 * as replay() (shared via replay-common.ts), but routes each turn through
 * routeTurnStage2 instead of routeTurn, keeping a rolling window of the
 * last 2 prompts per stream for Stage 2's context. Briefs/stem goals
 * aren't real yet (see docs/decisions.md on Stage 0's briefPath), so
 * both are always null here — Stage 2's prompt says so explicitly rather
 * than faking content.
 *
 * An async generator, not a buffered array — see replay()'s docstring
 * for why: a buffered version made a real multi-hour Stage 2 run give
 * zero incremental output. Rows are only sorted within each stream now,
 * not globally across streams.
 *
 * Intended for the real, full-dataset gated/always-escalate runs only —
 * for sampling a small subset of turns, use bench/ts/stage2-sample.ts
 * instead (see docs/decisions.md on why: this path's confidence-band
 * check can't be suppressed per-turn, so a targeted subset would still
 * silently escalate every other in-band turn in the whole dataset too).
 */
export async function* replayStage2(
  lines: readonly ReplayTurnInput[],
  embedder: Embedder,
  config: RouterConfig,
  stage2Options: ReplayStage2Options,
): AsyncGenerator<ReplayTurnOutput> {
  const byStream = groupAndSortByStream(lines);

  for (const [streamId, streamLines] of byStream) {
    let state = emptyState();
    const mapper = new FrondBranchMapper(streamId);
    const recentPrompts: string[] = [];

    for (const line of streamLines) {
      const filesTouched = (line.turn.files_touched ?? []).map((f) => f.path);
      const candidateNewFrondId = mapper.nextCandidateFrondId();

      const {
        decision,
        nextState,
        stage0Decision,
        stage0LatencyMs,
        stage2LatencyMs,
      } = await routeTurnStage2(
        line.turn.prompt_text,
        state,
        filesTouched,
        embedder,
        config,
        stage2Options,
        {
          recentPrompts: [...recentPrompts],
          briefSummary: null,
          stemGoal: null,
        },
        candidateNewFrondId,
      );

      const { target, predictedBranchId } = mapper.resolve(
        decision.action,
        decision.target,
        candidateNewFrondId,
        line.branch_id,
      );

      yield {
        stream_id: line.stream_id,
        turn_index: line.turn_index,
        action_truth: line.action_truth,
        branch_id: line.branch_id,
        variant: line.variant,
        predicted_action: decision.action,
        target,
        predicted_branch_id: predictedBranchId,
        confidence: decision.confidence,
        signals: decision.signals,
        latency_ms: stage0LatencyMs + (stage2LatencyMs ?? 0),
        stage0_latency_ms: stage0LatencyMs,
        stage2_latency_ms: stage2LatencyMs,
        stage0_predicted_action: stage0Decision.action,
        stage0_confidence: stage0Decision.confidence,
      };

      recentPrompts.push(line.turn.prompt_text);
      if (recentPrompts.length > RECENT_PROMPTS_WINDOW) recentPrompts.shift();

      state = nextState;
    }
  }
}
