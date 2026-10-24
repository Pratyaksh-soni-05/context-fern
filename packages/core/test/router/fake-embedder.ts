// A tiny local fake embedder for core's OWN tests. Deliberately not an
// import from packages/embed — core's test suite stays as dependency-free
// as its source does. packages/embed has its own, separately-tested
// FakeEmbedder; this one is structurally identical by convention, not by
// shared code.

// dims defaults to 256, not a smaller/faster number, specifically to keep
// hash collisions between unrelated short phrases rare in router tests.
export function makeFakeEmbedder(dims = 256) {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => embedOne(text, dims));
    },
  };
}

/** Test convenience: embed a single text and get back one vector, not an array. */
export async function embedSingle(
  embedder: { embed(texts: string[]): Promise<Float32Array[]> },
  text: string,
): Promise<Float32Array> {
  const [vector] = await embedder.embed([text]);
  if (!vector) throw new Error("expected one embedding back");
  return vector;
}

function hashWord(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embedOne(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    const idx = hashWord(w) % dims;
    vec[idx] = (vec[idx] as number) + 1;
  }
  let norm = 0;
  for (let i = 0; i < dims; i++)
    norm += (vec[i] as number) * (vec[i] as number);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) vec[i] = (vec[i] as number) / norm;
  }
  return vec;
}
