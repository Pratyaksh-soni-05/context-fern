// Keeps the embedder warm: one TransformersEmbedder per daemon process,
// constructed once and reused for every /prompt — loading the ONNX model
// per request (as a short-lived CLI invocation would) is far too slow
// for the daemon's 300ms p95 budget. The eager warm-up call pays the
// model-load cost once, at startup, not on the first real request.
//
// The model is never fetched here. If it is missing, fails its pinned
// checksum, or will not load, the daemon still starts — with a
// NoModelEmbedder, so Stage 0 suggests on explicit cue phrases only —
// and says so in `fern status`, `fern doctor`, the first receipt
// of the session and every journalled decision. See docs/decisions.md.

import { CLI_NAME, type Embedder } from "@context-fern/core";
import {
  checkModelFiles,
  NoModelEmbedder,
  TransformersEmbedder,
} from "@context-fern/embed";

export type EmbedderHealth =
  | { state: "ok" }
  | { state: "degraded"; reason: string };

export interface LoadedEmbedder {
  embedder: Embedder;
  health: EmbedderHealth;
}

function degraded(reason: string): LoadedEmbedder {
  return {
    embedder: new NoModelEmbedder(),
    health: { state: "degraded", reason },
  };
}

export interface EmbedderLoaders {
  check: typeof checkModelFiles;
  create: (cacheDir?: string) => Embedder;
}

const REAL_LOADERS: EmbedderLoaders = {
  check: checkModelFiles,
  create: (cacheDir) => new TransformersEmbedder(undefined, cacheDir),
};

/** `cacheDir` and `loaders` are overridable so tests can point at a temp directory or a model that fails to load. */
export async function loadEmbedder(
  cacheDir?: string,
  loaders: EmbedderLoaders = REAL_LOADERS,
): Promise<LoadedEmbedder> {
  const problem = await loaders.check(cacheDir);
  if (problem) {
    return degraded(
      problem.kind === "missing"
        ? `embedding model file missing: ${problem.path}`
        : `embedding model file failed its checksum: ${problem.path}`,
    );
  }
  try {
    const embedder = loaders.create(cacheDir);
    await embedder.embed([""]);
    return { embedder, health: { state: "ok" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degraded(
      `embedding model failed to load: ${message.split("\n")[0]}`,
    );
  }
}

/** One line, shown in `fern status` and once per project per daemon run on a prompt receipt. */
export function degradedReceipt(reason: string): string {
  return `${CLI_NAME} ▸ routing degraded · ${reason} · suggestions on cue phrases only · run ${CLI_NAME} doctor`;
}
