#!/usr/bin/env bun
// Dev-only: samples spliced "new" boundaries and "continue" turns for a
// manual ceiling check. This script makes NO model calls of any kind —
// Claude judges the sample directly afterward (see docs/decisions.md);
// this only builds the blind sample and its separate answer key.
//
// Methodology:
// - "Previous 3 exchanges" means the previous 3 turns in STREAM order,
//   not same-session order. A spliced stream interleaves segments from
//   several real sessions, and that interleaved order is exactly what
//   the router itself ever sees turn-by-turn — judging against the same
//   view keeps the ceiling check honest about what's actually available
//   at decision time, rather than an idealized same-topic history.
// - A candidate needs at least 3 prior turns within its own stream; the
//   first 3 turns of every stream are never eligible.
// - Sampling is a seeded Fisher-Yates shuffle (mulberry32), so the same
//   --seed always picks the same 120 rows. The written sample carries no
//   truth label — only the separate answer-key file does — so the
//   judging pass is blind.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface StreamTurn {
  prompt_text: string;
  assistant_text?: string;
}

interface StreamLine {
  stream_id: string;
  turn_index: number;
  action_truth: string;
  turn: StreamTurn;
}

interface CandidateRow {
  id: string;
  action_truth: "new" | "continue";
  previous_exchanges: { prompt: string; assistant: string }[];
  candidate_prompt: string;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

export function buildCandidates(lines: readonly StreamLine[]): {
  newCandidates: CandidateRow[];
  continueCandidates: CandidateRow[];
} {
  const byStream = new Map<string, StreamLine[]>();
  for (const line of lines) {
    const arr = byStream.get(line.stream_id) ?? [];
    arr.push(line);
    byStream.set(line.stream_id, arr);
  }

  const newCandidates: CandidateRow[] = [];
  const continueCandidates: CandidateRow[] = [];

  for (const [streamId, unsorted] of byStream) {
    const streamLines = unsorted
      .slice()
      .sort((a, b) => a.turn_index - b.turn_index);
    for (let i = 3; i < streamLines.length; i++) {
      const line = streamLines[i] as StreamLine;
      if (line.action_truth !== "new" && line.action_truth !== "continue") {
        continue;
      }
      const prior = streamLines.slice(i - 3, i);
      const row: CandidateRow = {
        id: `${streamId}#${line.turn_index}`,
        action_truth: line.action_truth,
        previous_exchanges: prior.map((p) => ({
          prompt: p.turn.prompt_text,
          assistant: p.turn.assistant_text ?? "",
        })),
        candidate_prompt: line.turn.prompt_text,
      };
      if (line.action_truth === "new") newCandidates.push(row);
      else continueCandidates.push(row);
    }
  }

  return { newCandidates, continueCandidates };
}

const SAMPLE_SIZE_PER_CLASS = 60;

export function sampleCandidates(
  newCandidates: readonly CandidateRow[],
  continueCandidates: readonly CandidateRow[],
  seed: number,
): CandidateRow[] {
  const rng = mulberry32(seed);
  const sampledNew = shuffle(newCandidates, rng).slice(
    0,
    SAMPLE_SIZE_PER_CLASS,
  );
  const sampledContinue = shuffle(continueCandidates, rng).slice(
    0,
    SAMPLE_SIZE_PER_CLASS,
  );
  return shuffle([...sampledNew, ...sampledContinue], rng);
}

async function main() {
  const inputPath = process.argv[2];
  const seedArg = process.argv.find((a) => a.startsWith("--seed="));
  const seed = seedArg ? Number(seedArg.slice("--seed=".length)) : 7;

  if (!inputPath) {
    console.error(
      "usage: bun run bench/ts/ceiling-sample.ts <streams.jsonl> [--seed=N]",
    );
    process.exit(1);
  }

  const scrubbedDir = resolve("bench/data/scrubbed");
  if (!resolve(inputPath).startsWith(scrubbedDir)) {
    console.error(`refusing: ${inputPath} is not under bench/data/scrubbed/`);
    process.exit(1);
  }

  const text = await Bun.file(inputPath).text();
  const lines: StreamLine[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const { newCandidates, continueCandidates } = buildCandidates(lines);

  if (
    newCandidates.length < SAMPLE_SIZE_PER_CLASS ||
    continueCandidates.length < SAMPLE_SIZE_PER_CLASS
  ) {
    console.error(
      `not enough candidates: new=${newCandidates.length}, continue=${continueCandidates.length} (need ${SAMPLE_SIZE_PER_CLASS} each)`,
    );
    process.exit(1);
  }

  const sample = sampleCandidates(newCandidates, continueCandidates, seed);

  const answerKey: Record<string, string> = {};
  const sampleLines: string[] = [];
  for (const row of sample) {
    answerKey[row.id] = row.action_truth;
    sampleLines.push(
      JSON.stringify({
        id: row.id,
        previous_exchanges: row.previous_exchanges,
        candidate_prompt: row.candidate_prompt,
      }),
    );
  }

  const samplePath = "bench/results/ceiling-sample.jsonl";
  const answerKeyPath = "bench/results/ceiling-answer-key.json";
  await mkdir(dirname(samplePath), { recursive: true });
  await Bun.write(samplePath, `${sampleLines.join("\n")}\n`);
  await Bun.write(answerKeyPath, JSON.stringify(answerKey, null, 2));

  console.log(
    `wrote ${sample.length} rows (60 new, 60 continue) to ${samplePath}`,
  );
  console.log(`answer key (not for the judging pass): ${answerKeyPath}`);
}

if (import.meta.main) {
  main();
}
