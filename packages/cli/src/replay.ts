import {
  type DecideFn,
  decide,
  type Embedder,
  emptyState,
  type RouterConfig,
  routeTurn,
} from "@context-fern/core";

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
  latency_ms: number;
}

/**
 * Replays each stream in turn-index order through routeTurn, tracking a
 * fresh RouterState per stream. Maps the router's own invented frond ids
 * to ground-truth branch ids by first co-occurrence (the first turn where
 * a frond becomes active, whether via "new" or "return"), so "return"
 * accuracy can be scored downstream without the scorer re-deriving the
 * mapping itself.
 */
export async function replay(
  lines: readonly ReplayTurnInput[],
  embedder: Embedder,
  config: RouterConfig,
  decideFn: DecideFn = decide,
): Promise<ReplayTurnOutput[]> {
  const byStream = new Map<string, ReplayTurnInput[]>();
  for (const line of lines) {
    const arr = byStream.get(line.stream_id) ?? [];
    arr.push(line);
    byStream.set(line.stream_id, arr);
  }

  const output: ReplayTurnOutput[] = [];

  for (const [streamId, streamLines] of byStream) {
    streamLines.sort((a, b) => a.turn_index - b.turn_index);
    let state = emptyState();
    const frondToBranch = new Map<string, string | null>();
    let frondCounter = 0;

    for (const line of streamLines) {
      const filesTouched = (line.turn.files_touched ?? []).map((f) => f.path);
      const candidateNewFrondId = `frond-${streamId}-${++frondCounter}`;

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

      let predictedBranchId: string | null = null;
      let target = decision.target;
      if (decision.action === "new") {
        frondToBranch.set(candidateNewFrondId, line.branch_id);
        predictedBranchId = line.branch_id;
        target = candidateNewFrondId;
      } else if (decision.target) {
        predictedBranchId = frondToBranch.get(decision.target) ?? null;
      }

      output.push({
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
      });

      state = nextState;
    }
  }

  output.sort((a, b) =>
    a.stream_id === b.stream_id
      ? a.turn_index - b.turn_index
      : a.stream_id < b.stream_id
        ? -1
        : 1,
  );
  return output;
}
