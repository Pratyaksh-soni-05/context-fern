import {
  type DecideFn,
  decide,
  type Embedder,
  emptyState,
  type RouterConfig,
  routeTurn,
} from "@context-fern/core";
import { FrondBranchMapper, groupAndSortByStream } from "./replay-common";

export interface ReplayTurnInput {
  stream_id: string;
  turn_index: number;
  branch_id: string | null;
  action_truth: string;
  variant: string;
  turn: {
    prompt_text: string;
    files_touched?: { path: string; source: string }[];
  };
  combine_with?: string[];
  synthetic?: boolean;
  stray_from?: string | null;
}

export interface ReplayTurnOutput {
  stream_id: string;
  turn_index: number;
  action_truth: string;
  branch_id: string | null;
  variant: string;
  predicted_action: string;
  target: string | null;
  predicted_branch_id: string | null;
  confidence: number;
  signals: string[];
  /** Total per-turn latency — Stage 0 only here; Stage 0 + Stage 2 (if escalated) in replayStage2(). */
  latency_ms: number;
  /** Only populated by replayStage2() — undefined for plain Stage 0 replay. */
  stage0_latency_ms?: number;
  /** Only populated by replayStage2(); null when that turn never escalated. */
  stage2_latency_ms?: number | null;
  /**
   * What Stage 0 alone would have decided, even on an escalated turn —
   * only populated by replayStage2(). Lets a real always-escalate pass
   * be sliced afterward to simulate any other escalation band.
   */
  stage0_predicted_action?: string;
  stage0_confidence?: number;
}

/**
 * Replays each stream in turn-index order through routeTurn, tracking a
 * fresh RouterState per stream. Maps the router's own invented frond ids
 * to ground-truth branch ids by first co-occurrence (the first turn where
 * a frond becomes active, whether via "new" or "return"), so "return"
 * accuracy can be scored downstream without the scorer re-deriving the
 * mapping itself.
 *
 * An async generator, not a buffered array: yields each row the moment
 * it's computed, so a caller (route.ts) can print/checkpoint
 * incrementally instead of waiting for the whole dataset to finish — a
 * prior version buffered everything in memory and only emitted output
 * at the very end, which on a real multi-hour Stage 2 run made no
 * incremental progress observable at all (see docs/decisions.md). Rows
 * are no longer globally sorted across streams as a result — only
 * within each stream, which callers (compute_metrics etc.) never relied
 * on cross-stream order for anyway.
 */
export async function* replay(
  lines: readonly ReplayTurnInput[],
  embedder: Embedder,
  config: RouterConfig,
  decideFn: DecideFn = decide,
): AsyncGenerator<ReplayTurnOutput> {
  const byStream = groupAndSortByStream(lines);

  for (const [streamId, streamLines] of byStream) {
    let state = emptyState();
    const mapper = new FrondBranchMapper(streamId);

    for (const line of streamLines) {
      const filesTouched = (line.turn.files_touched ?? []).map((f) => f.path);
      const candidateNewFrondId = mapper.nextCandidateFrondId();

      const start = performance.now();
      const { decision, nextState } = await routeTurn(
        line.turn.prompt_text,
        state,
        filesTouched,
        embedder,
        config,
        candidateNewFrondId,
        decideFn,
      );
      const latencyMs = performance.now() - start;

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
        latency_ms: latencyMs,
      };

      state = nextState;
    }
  }
}
