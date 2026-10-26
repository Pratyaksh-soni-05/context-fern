import {
  CLI_NAME,
  type DecideFn,
  decide,
  decideAlwaysContinue,
  decideCuePhrasesOnly,
  decideEmbeddingsOnly,
} from "@context-fern/core";
import { OllamaLlmClient } from "@context-fern/daemon";
import { TransformersEmbedder } from "@context-fern/embed";
import { JsonlJournalSink } from "@context-fern/store";
import { loadConfig } from "../load-config";
import { type ReplayTurnInput, type ReplayTurnOutput, replay } from "../replay";
import { replayStage2 } from "../replay-stage2";

const MODES: Record<string, DecideFn> = {
  full: decide,
  "always-continue": decideAlwaysContinue,
  "cue-only": decideCuePhrasesOnly,
  "embeddings-only": decideEmbeddingsOnly,
};

const STAGE2_MODES = new Set(["stage2", "always-escalate"]);

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:8b";
const PROGRESS_EVERY_TURNS = 50;

async function readReplayInput(replayPath: string): Promise<ReplayTurnInput[]> {
  const text = await Bun.file(replayPath).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Prints each yielded row to stdout immediately (the real JSONL output
 * stream — a prior buffered version gave zero incremental output on a
 * multi-hour run, see docs/decisions.md) and a progress line to stderr
 * every PROGRESS_EVERY_TURNS turns, so stdout stays a pure, parseable
 * JSONL stream for any downstream consumer. `limit`, if given, stops
 * after that many turns — used for quick smoke tests.
 */
async function consumeAndPrint(
  rows: AsyncGenerator<ReplayTurnOutput>,
  totalTurns: number,
  limit?: number,
): Promise<void> {
  const start = performance.now();
  let done = 0;
  let escalated = 0;

  for await (const row of rows) {
    console.log(JSON.stringify(row));
    done++;
    if (row.stage2_latency_ms !== undefined && row.stage2_latency_ms !== null) {
      escalated++;
    }

    if (done % PROGRESS_EVERY_TURNS === 0) {
      const elapsedMin = (performance.now() - start) / 1000 / 60;
      const target = limit ?? totalTurns;
      const rate = elapsedMin / done;
      const etaMin = rate * Math.max(0, target - done);
      console.error(
        JSON.stringify({
          progress: true,
          done,
          total: target,
          escalated,
          elapsed_min: Number(elapsedMin.toFixed(2)),
          eta_min: Number(etaMin.toFixed(2)),
        }),
      );
    }

    if (limit && done >= limit) break;
  }
}

export async function runRoute(flags: Record<string, string>): Promise<void> {
  const replayPath = flags.replay;
  if (!replayPath) {
    throw new Error(`${CLI_NAME} route --replay <stream.jsonl> is required`);
  }

  const mode = flags.mode ?? "full";
  const config = await loadConfig(flags.config);
  const lines = await readReplayInput(replayPath);
  const embedder = new TransformersEmbedder();
  const limit = flags.limit ? Number(flags.limit) : undefined;

  if (STAGE2_MODES.has(mode)) {
    if (!flags.journal) {
      throw new Error(
        `${CLI_NAME} route --mode ${mode} requires --journal <path> (no silent default — every Stage 2 call must be journaled somewhere explicit)`,
      );
    }
    const rows = replayStage2(lines, embedder, config, {
      llmClient: new OllamaLlmClient({
        baseUrl: flags["ollama-url"] ?? DEFAULT_OLLAMA_URL,
      }),
      model: flags.model ?? DEFAULT_MODEL,
      journal: new JsonlJournalSink(flags.journal),
      clock: {
        now: () => performance.now(),
        nowIso: () => new Date().toISOString(),
      },
      alwaysEscalate: mode === "always-escalate",
    });
    await consumeAndPrint(rows, lines.length, limit);
    return;
  }

  const decideFn = MODES[mode];
  if (!decideFn) {
    throw new Error(
      `${CLI_NAME} route --mode must be one of: ${[...Object.keys(MODES), ...STAGE2_MODES].join(", ")}`,
    );
  }
  const rows = replay(lines, embedder, config, decideFn);
  await consumeAndPrint(rows, lines.length, limit);
}
