import {
  CLI_NAME,
  type DecideFn,
  decide,
  decideAlwaysContinue,
  decideCuePhrasesOnly,
  decideEmbeddingsOnly,
} from "@context-fern/core";
import { TransformersEmbedder } from "@context-fern/embed";
import { loadConfig } from "../load-config";
import { type ReplayTurnInput, replay } from "../replay";

const MODES: Record<string, DecideFn> = {
  full: decide,
  "always-continue": decideAlwaysContinue,
  "cue-only": decideCuePhrasesOnly,
  "embeddings-only": decideEmbeddingsOnly,
};

export async function runRoute(flags: Record<string, string>): Promise<void> {
  const replayPath = flags.replay;
  if (!replayPath) {
    throw new Error(`${CLI_NAME} route --replay <stream.jsonl> is required`);
  }

  const mode = flags.mode ?? "full";
  const decideFn = MODES[mode];
  if (!decideFn) {
    throw new Error(
      `${CLI_NAME} route --mode must be one of: ${Object.keys(MODES).join(", ")}`,
    );
  }

  const config = await loadConfig(flags.config);
  const text = await Bun.file(replayPath).text();
  const lines: ReplayTurnInput[] = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  const embedder = new TransformersEmbedder();
  const output = await replay(lines, embedder, config, decideFn);
  for (const row of output) {
    console.log(JSON.stringify(row));
  }
}
