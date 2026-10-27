// Keeps the embedder warm: one TransformersEmbedder per daemon process,
// constructed once and reused for every /prompt — loading the ONNX model
// per request (as a short-lived CLI invocation would) is far too slow
// for the daemon's 300ms p95 budget. The eager warm-up call pays the
// model-load cost once, at startup, not on the first real request.

import type { Embedder } from "@context-fern/core";
import { TransformersEmbedder } from "@context-fern/embed";

export async function createWarmEmbedder(): Promise<Embedder> {
  const embedder = new TransformersEmbedder();
  await embedder.embed([""]);
  return embedder;
}
