// Caches prompt embeddings to a binary file keyed by a hash of the
// prompt text, so re-running a full Stage-0 causal pass for a second or
// third Ollama model doesn't re-pay the (slow, ONNX) embedding cost for
// prompts already embedded by an earlier model's pass.
//
// Binary format: a flat sequence of records, each
//   [8 bytes: FNV-1a-64 hash of the prompt, little-endian]
//   [4 bytes: dims (uint32, little-endian)]
//   [dims * 4 bytes: embedding, Float32Array]
// Loaded once into memory on construction (a few tens of MB for this
// dataset's prompt count); appended to as new prompts are embedded.

import { appendFile } from "node:fs/promises";
import type { Embedder } from "@context-fern/core";

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

export class CachingEmbedder implements Embedder {
  private readonly cache = new Map<bigint, Float32Array>();
  private loaded = false;

  constructor(
    private readonly inner: Embedder,
    private readonly cachePath: string,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = Bun.file(this.cachePath);
    if (!(await file.exists())) return;
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    let offset = 0;
    while (offset < buf.byteLength) {
      const hash = view.getBigUint64(offset, true);
      offset += 8;
      const dims = view.getUint32(offset, true);
      offset += 4;
      const vec = new Float32Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = view.getFloat32(offset + i * 4, true);
      }
      offset += dims * 4;
      this.cache.set(hash, vec);
    }
  }

  private async append(hash: bigint, vec: Float32Array): Promise<void> {
    // Real OS append (not read-modify-write) — same reasoning as
    // packages/store/src/jsonl-journal-sink.ts: a full-file rewrite per
    // new entry would be O(n^2) over a cache that can reach tens of
    // thousands of records.
    const header = new ArrayBuffer(12);
    const headerView = new DataView(header);
    headerView.setBigUint64(0, hash, true);
    headerView.setUint32(8, vec.length, true);
    const bytes = new Uint8Array(12 + vec.length * 4);
    bytes.set(new Uint8Array(header), 0);
    bytes.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 12);
    await appendFile(this.cachePath, bytes);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ensureLoaded();
    const results: (Float32Array | null)[] = texts.map((t) => {
      const hash = fnv1a64(t);
      return this.cache.get(hash) ?? null;
    });

    const missIndices = results
      .map((r, i) => (r === null ? i : -1))
      .filter((i) => i >= 0);
    if (missIndices.length > 0) {
      const missTexts = missIndices.map((i) => texts[i] as string);
      const missVectors = await this.inner.embed(missTexts);
      for (let k = 0; k < missIndices.length; k++) {
        const idx = missIndices[k] as number;
        const vec = missVectors[k] as Float32Array;
        results[idx] = vec;
        const hash = fnv1a64(texts[idx] as string);
        this.cache.set(hash, vec);
        await this.append(hash, vec);
      }
    }

    return results as Float32Array[];
  }
}
