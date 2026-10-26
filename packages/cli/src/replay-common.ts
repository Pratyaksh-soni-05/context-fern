// Shared between replay() (Stage 0 only) and replayStage2() (Stage 0+2):
// grouping/sorting turns by stream, and mapping the router's own invented
// frond ids to ground-truth branch ids by first co-occurrence. Extracted
// once both paths needed the exact same ~80 lines of this logic.

export function groupAndSortByStream<
  T extends { stream_id: string; turn_index: number },
>(lines: readonly T[]): Map<string, T[]> {
  const byStream = new Map<string, T[]>();
  for (const line of lines) {
    const arr = byStream.get(line.stream_id) ?? [];
    arr.push(line);
    byStream.set(line.stream_id, arr);
  }
  for (const arr of byStream.values()) {
    arr.sort((a, b) => a.turn_index - b.turn_index);
  }
  return byStream;
}

/**
 * Tracks, per stream, which of the router's own invented frond ids
 * corresponds to which ground-truth branch id — discovered the moment a
 * frond is first created via "new". Lets "return" accuracy be scored
 * downstream without the scorer re-deriving the mapping itself.
 */
export class FrondBranchMapper {
  private readonly frondToBranch = new Map<string, string | null>();
  private counter = 0;

  constructor(private readonly streamId: string) {}

  /** Generated every turn (only consumed by applyDecision if the action turns out to be "new"). */
  nextCandidateFrondId(): string {
    return `frond-${this.streamId}-${++this.counter}`;
  }

  resolve(
    decisionAction: string,
    decisionTarget: string | null,
    candidateNewFrondId: string,
    lineBranchId: string | null,
  ): { target: string | null; predictedBranchId: string | null } {
    if (decisionAction === "new") {
      this.frondToBranch.set(candidateNewFrondId, lineBranchId);
      return { target: candidateNewFrondId, predictedBranchId: lineBranchId };
    }
    if (decisionTarget) {
      return {
        target: decisionTarget,
        predictedBranchId: this.frondToBranch.get(decisionTarget) ?? null,
      };
    }
    return { target: decisionTarget, predictedBranchId: null };
  }
}
