import type { Embedder } from "@context-fern/core";

/**
 * Deterministic, dependency-free embedder for tests: a bag-of-hashed-words
 * vector, L2-normalized so cosine similarity is just the dot product.
 * Two texts sharing vocabulary get positive similarity; disjoint
 * vocabularies get ~0 — callers fully control similarity by choosing
 * words, with no model download and no non-determinism. dims defaults to
 * 256 (not a smaller, faster number) specifically to keep hash collisions
 * between unrelated short phrases rare — the whole point of this class is
 * letting tests engineer precise similarity scenarios.
 */
export class FakeEmbedder implements Embedder {
  constructor(private readonly dims = 256) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dims);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const word of words) {
      const idx = hashWord(word) % this.dims;
      vec[idx] = (vec[idx] as number) + 1;
    }
    let norm = 0;
    for (let i = 0; i < this.dims; i++) {
      norm += (vec[i] as number) * (vec[i] as number);
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dims; i++) {
        vec[i] = (vec[i] as number) / norm;
      }
    }
    return vec;
  }
}

function hashWord(word: string): number {
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
