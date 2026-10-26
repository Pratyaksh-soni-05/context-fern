// Turns a router decision (or a manual command) into a fully-inverseable
// `Decision` record — closes the "Decision journaling/undo stays out of
// scope" gap from docs/decisions.md, 2026-10-25. Pure: no DB, no clock, no
// id generation — the caller injects `id`/`createdAt`, same discipline as
// stage2.ts's injected Clock. See docs/spec.md §4/§5/§11.

import type {
  Decision,
  DecisionAction,
  DecisionInverse,
  FrondStatus,
  RouterAction,
} from "../types";
import type { RouterState } from "./types";

/** The "router" branch of DecisionInverse — what buildDecisionInverse produces. */
export type RouterDecisionInverse = Extract<
  DecisionInverse,
  { kind: "router" }
>;

/**
 * Projects `before` directly — never diffs against an "after" state.
 * `before` already has everything needed: every frond's current status,
 * the current active id, and the caller already knows `newFrondId` for
 * the one action that creates a row. Only `activeFrondId` and per-frond
 * `status` are captured, deliberately never centroid/count/files — so a
 * `continue` is a true no-op (it never touches either), and undoing
 * `new`/`return`/`combine`/`stray` restores the frond tree's topology,
 * not the routing signals a later turn would have recomputed. One
 * function covers all five `RouterAction`s uniformly; see
 * `packages/core/test/router/decision.test.ts` for the full truth table.
 */
export function buildDecisionInverse(
  before: RouterState,
  action: RouterAction,
  newFrondId?: string,
): RouterDecisionInverse {
  const priorFrondStatuses: Record<string, FrondStatus> = {};
  for (const [id, frond] of Object.entries(before.fronds)) {
    priorFrondStatuses[id] = frond.status;
  }
  return {
    kind: "router",
    priorActiveFrondId: before.activeFrondId,
    priorFrondStatuses,
    createdFrondId: action === "new" ? (newFrondId ?? null) : null,
  };
}

export interface BuildDecisionInput {
  id: string;
  createdAt: string;
  sessionId: string;
  /** Null only for `merge` — it isn't tied to one exchange. */
  leafletId: string | null;
  action: DecisionAction;
  target: string | null;
  with?: string;
  stage: 0 | 2 | "manual";
  rootsUsed?: string[];
  signals: string[];
  confidence: number;
  tokensBefore: number;
  tokensAfter: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inverse: DecisionInverse;
}

/**
 * Assembles a full `Decision` from a caller's fields. A caller holding a
 * `RouterDecision` (Stage 0 or Stage 2 output) just spreads its fields in
 * with `stage: 0 | 2`; a manual command (`/fern stray`, the `? ` prefix,
 * `/fern switch`, merge) calls the same function with `stage: "manual"`.
 * One function for both, not two — see docs/decisions.md, 2026-10-26.
 */
export function buildDecision(input: BuildDecisionInput): Decision {
  return {
    id: input.id,
    sessionId: input.sessionId,
    leafletId: input.leafletId,
    action: input.action,
    target: input.target,
    ...(input.with !== undefined ? { with: input.with } : {}),
    stage: input.stage,
    ...(input.rootsUsed !== undefined ? { rootsUsed: input.rootsUsed } : {}),
    signals: input.signals,
    confidence: input.confidence,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    undone: false,
    inverse: input.inverse,
    createdAt: input.createdAt,
  };
}
