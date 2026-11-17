import type { Embedder } from "@context-fern/core";

/**
 * Stands in when the embedding model is missing, fails its checksum or
 * will not load. Returns a zero-length vector per text — the router's
 * signal that no embedding exists (core's `embeddingUnavailable`), so it
 * routes on cue phrases and file overlap only instead of crashing or
 * reaching for the network.
 */
export class NoModelEmbedder implements Embedder {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }
}
