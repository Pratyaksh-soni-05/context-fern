#!/usr/bin/env bun

// Dev-only: calls a local Ollama model on EXACTLY a pre-selected set of
// sample turn ids, never more. Built to replace the earlier
// `fern route --mode stage2 --sample-ids` approach, which had two real
// bugs found on a real run that stalled for ~4 hours doing almost
// nothing visible (see docs/decisions.md):
//
// 1. routeTurnStage2's escalation check was `alwaysEscalate || inBand` —
//    even in sample-targeted mode, any turn whose OWN natural Stage 0
//    confidence fell in the configured band also escalated, not just
//    the sampled ids. With the default band [0.25, 0.5] and
//    continueMin=0.4, a large fraction of ordinary "continue" turns
//    qualify, so the real call count was far larger than the sample
//    size.
// 2. `replay()`/`replayStage2()` buffer the ENTIRE dataset's output in
//    memory and only emit it after every turn in every stream is done —
//    nothing streams incrementally, so no checkpoint write could happen
//    until a 37k-turn pass finished (if it ever did), and holding that
//    much in memory is a likely contributor to the 97% RAM observed.
//
// This script avoids both: it always runs Stage 0 only to build router
// state causally (cheap, free, state is NEVER touched by a Stage 2
// probe), checkpoints each sampled row to disk the moment it completes,
// and never buffers more than one stream's lines in memory at a time.

import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import {
  adjudicate,
  applyDecision,
  type Clock,
  computeSignals,
  DEFAULT_CONFIG,
  decide,
  emptyState,
  type JournalSink,
  type RouterState,
  type Stage2CallLog,
} from "@context-fern/core";
import { OllamaLlmClient, TimeoutRetryLlmClient } from "@context-fern/daemon";
import { TransformersEmbedder } from "@context-fern/embed";
import { CachingEmbedder } from "./embedding-cache";

interface StreamLine {
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

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function groupAndSortByStream(
  lines: readonly StreamLine[],
): Map<string, StreamLine[]> {
  const byStream = new Map<string, StreamLine[]>();
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

function makeFileJournalSink(path: string): JournalSink {
  return {
    async record(entry: Stage2CallLog) {
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
    },
  };
}

export interface CallCounts {
  succeeded: number;
  failed: number;
}

/**
 * Wraps any JournalSink to also count succeeded/failed calls — adjudicate()
 * journals a failure (bad response, thrown error, timeout) exactly the
 * same way it journals a success, so without this a sustained outage
 * (e.g. Ollama unreachable) looks identical to "N/N done" in the plain
 * progress line. A real run with Ollama down failed all 500 calls in
 * under a minute and reported "done: 500/500" with nothing to flag it.
 */
export function countingJournalSink(
  inner: JournalSink,
  counts: CallCounts,
): JournalSink {
  return {
    async record(entry: Stage2CallLog) {
      if (entry.succeeded) counts.succeeded++;
      else counts.failed++;
      await inner.record(entry);
    },
  };
}

function realClock(): Clock {
  return {
    now: () => performance.now(),
    nowIso: () => new Date().toISOString(),
  };
}

async function loadIds(path: string): Promise<string[]> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

export async function loadDoneIds(
  checkpointPath: string,
): Promise<Set<string>> {
  if (!existsSync(checkpointPath)) return new Set();
  const text = await readFile(checkpointPath, "utf-8");
  const done = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed);
    done.add(`${row.stream_id}#${row.turn_index}`);
  }
  return done;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const streamsPath = positional[0];
  if (
    !streamsPath ||
    !flags.model ||
    !flags["sample-ids"] ||
    !flags.checkpoint ||
    !flags.journal
  ) {
    console.error(
      "usage: bun run bench/ts/stage2-sample.ts <streams.jsonl> --model <name> " +
        "--sample-ids <file.json> --checkpoint <file.jsonl> --journal <file.jsonl> " +
        "[--ollama-url <url>] [--limit N] [--timeout-ms 60000] [--retries 1] " +
        "[--embedding-cache <path>]",
    );
    process.exit(1);
  }

  const model = flags.model;
  const sampleIds = new Set(await loadIds(flags["sample-ids"]));
  const doneIds = await loadDoneIds(flags.checkpoint);
  const remaining = [...sampleIds].filter((id) => !doneIds.has(id));
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const target = limit ? remaining.slice(0, limit) : remaining;
  const targetSet = new Set(target);

  console.log(
    `${sampleIds.size} sampled, ${doneIds.size} already checkpointed, ` +
      `${remaining.length} remaining, running ${target.length} this invocation`,
  );

  if (target.length === 0) {
    console.log("nothing to do");
    return;
  }

  const embeddingCachePath =
    flags["embedding-cache"] ?? "bench/results/embeddings-cache.bin";
  const embedder = new CachingEmbedder(
    new TransformersEmbedder(),
    embeddingCachePath,
  );
  const llmClient = new TimeoutRetryLlmClient(
    new OllamaLlmClient(
      flags["ollama-url"] ? { baseUrl: flags["ollama-url"] } : {},
    ),
    {
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : 60_000,
      retries: flags.retries ? Number(flags.retries) : 1,
    },
  );
  const counts: CallCounts = { succeeded: 0, failed: 0 };
  const journal = countingJournalSink(
    makeFileJournalSink(flags.journal),
    counts,
  );
  const clock = realClock();
  const EARLY_ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

  const text = await readFile(streamsPath, "utf-8");
  const lines: StreamLine[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const byStream = groupAndSortByStream(lines);

  const RECENT_WINDOW = 2;
  const latencies: number[] = [];
  let completed = 0;
  const runStart = performance.now();

  outer: for (const [streamId, streamLines] of byStream) {
    let state: RouterState = emptyState();
    const frondToBranch = new Map<string, string | null>();
    let frondCounter = 0;
    const recentPrompts: string[] = [];

    for (const line of streamLines) {
      const filesTouched = (line.turn.files_touched ?? []).map((f) => f.path);
      const candidateNewFrondId = `frond-${streamId}-${++frondCounter}`;

      const signals = await computeSignals(
        line.turn.prompt_text,
        state,
        embedder,
        DEFAULT_CONFIG,
      );
      const stage0Decision = decide(signals, state, DEFAULT_CONFIG);
      const nextState = applyDecision(
        state,
        stage0Decision,
        signals.promptEmbedding,
        filesTouched,
        candidateNewFrondId,
      );

      const turnId = `${line.stream_id}#${line.turn_index}`;
      if (targetSet.has(turnId)) {
        const succeededBefore = counts.succeeded;
        const stage2Start = clock.now();
        const stage2Decision = await adjudicate(
          stage0Decision,
          signals,
          state,
          DEFAULT_CONFIG,
          {
            promptText: line.turn.prompt_text,
            recentPrompts: [...recentPrompts],
            briefSummary: null,
            stemGoal: null,
          },
          llmClient,
          model,
          journal,
          clock,
        );
        const stage2LatencyMs = clock.now() - stage2Start;
        const wasSuccessful = counts.succeeded > succeededBefore;

        if (
          counts.succeeded === 0 &&
          counts.failed >= EARLY_ABORT_AFTER_CONSECUTIVE_FAILURES
        ) {
          console.error(
            `ABORTING: the first ${counts.failed} calls all failed (succeeded:false in the ` +
              "journal) — this almost always means the LLM endpoint isn't reachable " +
              "(check `ollama list` / --ollama-url), not that 0 of them were genuinely " +
              "escalated. No further calls will be made; none of this invocation's " +
              "attempts were written to the checkpoint, so they'll be retried next run.",
          );
          process.exit(1);
        }

        if (!wasSuccessful) {
          // A failed call (bad response, thrown error, timeout) is NOT
          // written to the checkpoint — it must stay eligible for retry
          // on the next invocation, not be mistaken for a real judgment.
          state = nextState;
          recentPrompts.push(line.turn.prompt_text);
          if (recentPrompts.length > RECENT_WINDOW) recentPrompts.shift();
          continue;
        }

        latencies.push(stage2LatencyMs);
        let predictedBranchId: string | null = null;
        let target2 = stage2Decision.target;
        if (stage2Decision.action === "new") {
          frondToBranch.set(candidateNewFrondId, line.branch_id);
          predictedBranchId = line.branch_id;
          target2 = candidateNewFrondId;
        } else if (stage2Decision.target) {
          predictedBranchId = frondToBranch.get(stage2Decision.target) ?? null;
        }

        const row = {
          stream_id: line.stream_id,
          turn_index: line.turn_index,
          action_truth: line.action_truth,
          branch_id: line.branch_id,
          variant: line.variant,
          predicted_action: stage2Decision.action,
          target: target2,
          predicted_branch_id: predictedBranchId,
          confidence: stage2Decision.confidence,
          signals: stage2Decision.signals,
          latency_ms: stage2LatencyMs,
          stage0_latency_ms: null,
          stage2_latency_ms: stage2LatencyMs,
          stage0_predicted_action: stage0Decision.action,
          stage0_confidence: stage0Decision.confidence,
        };
        await appendFile(flags.checkpoint, `${JSON.stringify(row)}\n`, "utf-8");

        completed++;
        if (completed % 10 === 0 || completed === target.length) {
          const avgMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
          const remainingCount = target.length - completed;
          const etaMin = (avgMs * remainingCount) / 1000 / 60;
          const elapsedMin = (performance.now() - runStart) / 1000 / 60;
          console.log(
            JSON.stringify({
              progress: true,
              done: completed,
              total: target.length,
              succeeded: counts.succeeded,
              failed: counts.failed,
              avg_latency_ms: Math.round(avgMs),
              elapsed_min: Number(elapsedMin.toFixed(2)),
              eta_min: Number(etaMin.toFixed(2)),
            }),
          );
        }

        if (completed >= target.length) {
          state = nextState; // keep applying before breaking, for consistency
          break outer;
        }
      }

      // State ALWAYS advances from Stage 0's own decision, never from a
      // Stage 2 probe's answer — the probe is a pure side observation
      // that doesn't alter the causal trajectory. This is what makes
      // `stage2-sample.ts` give honest per-row judgments regardless of
      // how many (or few) of a stream's turns happen to be sampled.
      state = nextState;
      recentPrompts.push(line.turn.prompt_text);
      if (recentPrompts.length > RECENT_WINDOW) recentPrompts.shift();
    }
  }

  console.log(
    `done: ${completed}/${target.length} this invocation ` +
      `(succeeded: ${counts.succeeded}, failed: ${counts.failed})`,
  );
  if (counts.failed > 0) {
    console.log(
      `${counts.failed} call(s) failed and were NOT checkpointed — ` +
        "they'll be retried automatically next invocation.",
    );
  }
}

if (import.meta.main) {
  await main();
}
