#!/usr/bin/env bun
// Dev-only threshold sweep. Run with `bun run bench/ts/sweep.ts <streams.jsonl>`.
//
// Methodology (see docs/decisions.md):
// - Signals are computed ONCE per turn using ORACLE state: fronds are keyed
//   by ground-truth branch_id and updated from ground-truth action_truth,
//   not from whatever decide() would have guessed. This is what makes
//   "signals emitted once" threshold-independent — real (online/causal)
//   state evolution depends on which decisions were made, which depends on
//   the thresholds being swept, so it can't be precomputed once.
// - The grid search over decide() then runs ONLY against those cached
//   signals — cheap, no re-embedding, thousands of threshold combinations
//   in milliseconds.
// - decide() itself is NOT ported to another language (it changes too
//   often for two implementations to stay in sync) — this file imports it
//   directly from @context-fern/core. Only the STABLE metrics math is
//   mirrored (bench/ts/metrics.ts / bench/src/bench/run.py).
// - Final reported numbers (bench eval) always come from a real, honest
//   `route --replay` run — online/causal, the router's own mistakes
//   included — never from this oracle-signals shortcut. This script only
//   picks thresholds; it never reports them as measured performance.
//
// Stray rows have branch_id: null (synthetic, not owned by any session),
// so leave-one-session-out includes them in both the dev and test side of
// every fold — there's no leakage risk since their content is identical
// regardless of fold.

import {
  applyDecision,
  computeSignals,
  DEFAULT_CONFIG,
  decide,
  type Embedder,
  emptyState,
  type RouterConfig,
  type RouterState,
  type RouterThresholds,
  type RouterWeights,
  type Signals,
} from "@context-fern/core";
import { computeMetrics, confusionCounts, type MetricsRow } from "./metrics";

export interface StreamLine {
  stream_id: string;
  turn_index: number;
  branch_id: string | null;
  action_truth: string;
  variant: string;
  turn: {
    prompt_text: string;
    files_touched?: { path: string; source: string }[];
  };
}

export interface OracleRow {
  stream_id: string;
  turn_index: number;
  action_truth: string;
  branch_id: string | null;
  variant: string;
  signals: Signals;
  activeFrondId: string | null;
  hasAnyFrond: boolean;
}

export async function computeOracleSignals(
  lines: readonly StreamLine[],
  embedder: Embedder,
  config: RouterConfig,
): Promise<OracleRow[]> {
  const byStream = new Map<string, StreamLine[]>();
  for (const line of lines) {
    const arr = byStream.get(line.stream_id) ?? [];
    arr.push(line);
    byStream.set(line.stream_id, arr);
  }

  const rows: OracleRow[] = [];

  for (const streamLines of byStream.values()) {
    streamLines.sort((a, b) => a.turn_index - b.turn_index);
    let state: RouterState = emptyState();

    for (const line of streamLines) {
      const signals = await computeSignals(
        line.turn.prompt_text,
        state,
        embedder,
        config,
      );
      rows.push({
        stream_id: line.stream_id,
        turn_index: line.turn_index,
        action_truth: line.action_truth,
        branch_id: line.branch_id,
        variant: line.variant,
        signals,
        activeFrondId: state.activeFrondId,
        hasAnyFrond: Object.keys(state.fronds).length > 0,
      });

      const files = (line.turn.files_touched ?? []).map((f) => f.path);
      if (line.action_truth === "new" && line.branch_id) {
        state = applyDecision(
          state,
          { action: "new", target: null, confidence: 1, signals: [], stage: 0 },
          signals.promptEmbedding,
          files,
          line.branch_id,
        );
      } else if (
        (line.action_truth === "continue" || line.action_truth === "return") &&
        line.branch_id
      ) {
        state = applyDecision(
          state,
          {
            action: line.action_truth,
            target: line.branch_id,
            confidence: 1,
            signals: [],
            stage: 0,
          },
          signals.promptEmbedding,
          files,
        );
      }
      // stray/combine: oracle state is left untouched.
    }
  }

  return rows;
}

export function minimalState(row: OracleRow): RouterState {
  return {
    activeFrondId: row.activeFrondId,
    stemCentroid: null,
    stemFiles: [],
    fronds: row.hasAnyFrond
      ? {
          "oracle-dummy": {
            id: "oracle-dummy",
            centroid: null,
            count: 0,
            files: [],
            status: "resting",
          },
        }
      : {},
  };
}

export function predictRow(row: OracleRow, config: RouterConfig): MetricsRow {
  const decision = decide(row.signals, minimalState(row), config);
  return {
    action_truth: row.action_truth,
    predicted_action: decision.action,
    branch_id: row.branch_id,
    predicted_branch_id: decision.target,
    latency_ms: null,
  };
}

const CANDIDATE_VALUES = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];

/** continueMin > newMax is required — see decide.ts's bias-toward-continue comment. */
export function buildThresholdGrid(): RouterThresholds[] {
  const grid: RouterThresholds[] = [];
  for (const continueMin of CANDIDATE_VALUES) {
    for (const newMax of CANDIDATE_VALUES) {
      if (newMax >= continueMin) continue;
      for (const returnMin of CANDIDATE_VALUES) {
        for (const strayMaxSimilarity of CANDIDATE_VALUES) {
          grid.push({
            continueMin,
            newMax,
            returnMin,
            strayMaxSimilarity,
            strayMaxPromptWords: 12,
          });
        }
      }
    }
  }
  return grid;
}

/**
 * Draft scalarization for picking a winner out of the grid — NOT a
 * shipped scoring rule (see CLAUDE.md: the maintainer decides benchmark
 * scoring; this formula was dictated directly by the maintainer on
 * 2026-10-25, see docs/decisions.md).
 *
 * macroF1 is the unweighted mean of F1 across all four actions (continue
 * included, not just the three gated ones — a thresholds choice that's
 * great at new/return/stray but wrecks continue shouldn't win). `cost`
 * applies an explicit 2x penalty to false new/stray calls (a wrong split
 * removes context the model needed) versus a 1x penalty for missing one
 * (over-carrying is recoverable; a bad split is not), normalized by row
 * count so it's on the same ~0..1 scale as macroF1.
 */
export function objective(
  rows: readonly MetricsRow[],
  metrics: ReturnType<typeof computeMetrics>,
): number {
  const mainRows = rows.filter((r) => r.action_truth !== "combine");
  const macroF1 =
    (metrics.f1Continue + metrics.f1New + metrics.f1Return + metrics.f1Stray) /
    4;
  const newCounts = confusionCounts(mainRows, "new");
  const strayCounts = confusionCounts(mainRows, "stray");
  const cost =
    (2 * (newCounts.fp + strayCounts.fp) + (newCounts.fn + strayCounts.fn)) /
    Math.max(1, metrics.n);
  return macroF1 - cost;
}

export function gridSearch(
  rows: readonly OracleRow[],
  grid: readonly RouterThresholds[],
  weights: RouterWeights,
  cues: RouterConfig["cues"],
): {
  thresholds: RouterThresholds;
  score: number;
  metrics: ReturnType<typeof computeMetrics>;
} {
  let best: RouterThresholds = grid[0] as RouterThresholds;
  let bestScore = -Infinity;
  let bestMetrics = computeMetrics([]);

  for (const thresholds of grid) {
    // escalation/suggestionPrecision are irrelevant here — decide() (Stage
    // 0 only) never reads them; carried through only because RouterConfig
    // requires the fields.
    const config: RouterConfig = {
      thresholds,
      weights,
      cues,
      escalation: DEFAULT_CONFIG.escalation,
      suggestionPrecision: DEFAULT_CONFIG.suggestionPrecision,
    };
    const predicted = rows.map((row) => predictRow(row, config));
    const metrics = computeMetrics(predicted);
    const score = objective(predicted, metrics);
    if (score > bestScore) {
      bestScore = score;
      best = thresholds;
      bestMetrics = metrics;
    }
  }

  return { thresholds: best, score: bestScore, metrics: bestMetrics };
}

/** Sessions, not streams: a session (branch_id) never appears in both dev
 * and test for the same fold. Stray rows (branch_id null) have no owning
 * session and go in both sides — see the module docstring. */
export function sessionsOf(rows: readonly OracleRow[]): string[] {
  const sessions = new Set<string>();
  for (const row of rows) {
    if (row.branch_id) sessions.add(row.branch_id);
  }
  return Array.from(sessions).sort();
}

export interface LosoFold {
  heldOutSession: string;
  dev: OracleRow[];
  test: OracleRow[];
}

export function leaveOneSessionOut(rows: readonly OracleRow[]): LosoFold[] {
  const sessions = sessionsOf(rows);
  return sessions.map((heldOut) => ({
    heldOutSession: heldOut,
    dev: rows.filter((r) => r.branch_id === null || r.branch_id !== heldOut),
    test: rows.filter((r) => r.branch_id === null || r.branch_id === heldOut),
  }));
}

export interface SweepReport {
  pool_sessions: string[];
  loso: {
    folds: {
      held_out_session: string;
      thresholds: RouterThresholds;
      test_score: number;
    }[];
    mean_test_score: number;
    worst_test_score: number;
  };
  final: { thresholds: RouterThresholds; score: number };
}

async function main(): Promise<void> {
  const streamsPath = process.argv[2];
  if (!streamsPath) {
    console.error("usage: bun run bench/ts/sweep.ts <streams.jsonl>");
    process.exit(1);
  }

  const { TransformersEmbedder } = await import("@context-fern/embed");
  const text = await Bun.file(streamsPath as string).text();
  const lines: StreamLine[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const embedder = new TransformersEmbedder();
  const rows = await computeOracleSignals(
    lines,
    embedder,
    DEFAULT_CONFIG_FOR_SIGNALS(),
  );
  const grid = buildThresholdGrid();

  const folds = leaveOneSessionOut(rows).map((fold) => {
    const devResult = gridSearch(
      fold.dev,
      grid,
      DEFAULT_CONFIG_FOR_SIGNALS().weights,
      DEFAULT_CONFIG_FOR_SIGNALS().cues,
    );
    const testConfig: RouterConfig = {
      thresholds: devResult.thresholds,
      weights: DEFAULT_CONFIG_FOR_SIGNALS().weights,
      cues: DEFAULT_CONFIG_FOR_SIGNALS().cues,
      escalation: DEFAULT_CONFIG_FOR_SIGNALS().escalation,
      suggestionPrecision: DEFAULT_CONFIG_FOR_SIGNALS().suggestionPrecision,
    };
    const testPredicted = fold.test.map((r) => predictRow(r, testConfig));
    const testMetrics = computeMetrics(testPredicted);
    return {
      held_out_session: fold.heldOutSession,
      thresholds: devResult.thresholds,
      test_score: objective(testPredicted, testMetrics),
    };
  });

  const scores = folds.map((f) => f.test_score);
  const finalResult = gridSearch(
    rows,
    grid,
    DEFAULT_CONFIG_FOR_SIGNALS().weights,
    DEFAULT_CONFIG_FOR_SIGNALS().cues,
  );

  const report: SweepReport = {
    pool_sessions: sessionsOf(rows),
    loso: {
      folds,
      mean_test_score: scores.reduce((a, b) => a + b, 0) / scores.length,
      worst_test_score: Math.min(...scores),
    },
    final: { thresholds: finalResult.thresholds, score: finalResult.score },
  };

  console.log(JSON.stringify(report, null, 2));
}

function DEFAULT_CONFIG_FOR_SIGNALS(): RouterConfig {
  // Weights/cues are fixed for the sweep — only thresholds are searched.
  return DEFAULT_CONFIG;
}

if (import.meta.main) {
  await main();
}
