// Router-local types: the working state and config Stage 0 operates on.
// Distinct from packages/core/src/types.ts's storage-level Frond/Leaflet/
// Decision — those are what gets persisted; these are what the pure router
// functions pass around turn to turn. See docs/spec.md §5.

import type { RouterAction } from "../types";

export interface FrondState {
  id: string;
  /** Running mean of prompt embeddings seen on this frond so far. */
  centroid: number[] | null;
  /** How many embeddings have been folded into centroid (for the running mean). */
  count: number;
  files: string[];
  status: "active" | "resting";
}

export interface RouterState {
  activeFrondId: string | null;
  /** Static in this PR — the stem is only updated by the merge command (out of scope here). */
  stemCentroid: number[] | null;
  stemFiles: string[];
  fronds: Record<string, FrondState>;
}

export interface CueConfig {
  new: string[];
  return: string[];
  stray: string[];
}

export interface RouterThresholds {
  continueMin: number;
  newMax: number;
  returnMin: number;
  strayMaxSimilarity: number;
  strayMaxPromptWords: number;
}

export interface RouterWeights {
  embedding: number;
  fileOverlap: number;
}

export interface RouterConfig {
  thresholds: RouterThresholds;
  weights: RouterWeights;
  cues: CueConfig;
}

export interface FrondSignal {
  frondId: string;
  cosine: number;
  fileOverlap: number;
  combined: number;
}

export interface Signals {
  promptEmbedding: Float32Array;
  mentionedFiles: string[];
  stemCosine: number;
  frondSignals: FrondSignal[];
  hasCue: { new: boolean; return: boolean; stray: boolean };
  isShortQuestion: boolean;
}

/**
 * What Stage 0 outputs for one leaflet — spec §5's `{ action, target?,
 * with?, confidence, signals, stage }`. Lighter than the full journaled
 * `Decision` (no id/leafletId/tokens/etc.) — the caller wraps this into a
 * Decision when it journals.
 */
export interface RouterDecision {
  action: RouterAction;
  target: string | null;
  with?: string;
  confidence: number;
  signals: string[];
  stage: 0 | 2;
}
