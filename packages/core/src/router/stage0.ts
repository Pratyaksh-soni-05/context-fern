import type { Embedder } from "../types";
import { decide } from "./decide";
import { computeSignals } from "./signals";
import type { RouterConfig, RouterDecision, RouterState } from "./types";

/** stage0 = computeSignals (expensive) then decide (cheap, pure). Spec §5. */
export async function stage0(
  prompt: string,
  state: RouterState,
  embedder: Embedder,
  config: RouterConfig,
): Promise<RouterDecision> {
  const signals = await computeSignals(prompt, state, embedder, config);
  return decide(signals, state, config);
}
