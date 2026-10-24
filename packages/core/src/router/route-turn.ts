import type { Embedder } from "../types";
import { decide } from "./decide";
import { computeSignals } from "./signals";
import { applyDecision } from "./state";
import type {
  RouterConfig,
  RouterDecision,
  RouterState,
  Signals,
} from "./types";

export type DecideFn = (
  signals: Signals,
  state: RouterState,
  config: RouterConfig,
) => RouterDecision;

export interface RouteTurnResult {
  decision: RouterDecision;
  nextState: RouterState;
}

/**
 * The one integration point that enforces correct ordering: decide first
 * (using only the state built from PREVIOUS exchanges), then update state
 * with THIS exchange's files. `filesTouchedThisExchange` must never reach
 * computeSignals/decide — only applyDecision, and only after the decision
 * is made. See route-turn.test.ts's no-leakage test, which proves the
 * order matters by deliberately getting it wrong and showing the signals
 * change.
 */
export async function routeTurn(
  prompt: string,
  state: RouterState,
  filesTouchedThisExchange: readonly string[],
  embedder: Embedder,
  config: RouterConfig,
  newFrondId?: string,
  decideFn: DecideFn = decide,
): Promise<RouteTurnResult> {
  const signals = await computeSignals(prompt, state, embedder, config);
  const decision = decideFn(signals, state, config);
  const nextState = applyDecision(
    state,
    decision,
    signals.promptEmbedding,
    filesTouchedThisExchange,
    newFrondId,
  );
  return { decision, nextState };
}
