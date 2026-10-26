import { afterEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Embedder } from "@context-fern/core";
import { CachingEmbedder } from "./embedding-cache";

let cachePath = "";

afterEach(async () => {
  if (cachePath) {
    try {
      await unlink(cachePath);
    } catch {}
  }
});

function countingEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts: string[]) {
      calls.push([...texts]);
      return texts.map((t, i) => new Float32Array([t.length, i]));
    },
  };
}

test("caches a miss and returns it from the inner embedder", async () => {
  cachePath = `${import.meta.dir}/.test-cache-1.bin`;
  const inner = countingEmbedder();
  const cached = new CachingEmbedder(inner, cachePath);

  const [vec] = await cached.embed(["hello"]);
  expect(vec).toEqual(new Float32Array([5, 0]));
  expect(inner.calls).toHaveLength(1);
});

test("a repeated text within the same instance hits the cache, not the inner embedder", async () => {
  cachePath = `${import.meta.dir}/.test-cache-2.bin`;
  const inner = countingEmbedder();
  const cached = new CachingEmbedder(inner, cachePath);

  await cached.embed(["hello"]);
  await cached.embed(["hello"]);

  expect(inner.calls).toHaveLength(1); // only the first call actually embedded
});

test("only cache misses within a batch reach the inner embedder, results map back correctly", async () => {
  cachePath = `${import.meta.dir}/.test-cache-3.bin`;
  const inner = countingEmbedder();
  const cached = new CachingEmbedder(inner, cachePath);

  await cached.embed(["aaa"]); // warms the cache for "aaa"
  const [vecAaa, vecBB] = await cached.embed(["aaa", "bb"]);

  expect(inner.calls).toHaveLength(2); // first warm-up call + one more for just "bb"
  expect(inner.calls[1]).toEqual(["bb"]);
  expect(vecAaa).toEqual(new Float32Array([3, 0]));
  expect(vecBB).toEqual(new Float32Array([2, 0]));
});

test("the cache persists on disk and is reused by a new instance pointed at the same file", async () => {
  cachePath = `${import.meta.dir}/.test-cache-4.bin`;
  const inner1 = countingEmbedder();
  const first = new CachingEmbedder(inner1, cachePath);
  await first.embed(["persisted"]);

  const inner2 = countingEmbedder();
  const second = new CachingEmbedder(inner2, cachePath);
  const [vec] = await second.embed(["persisted"]);

  expect(inner2.calls).toHaveLength(0); // never had to call the inner embedder at all
  expect(vec).toEqual(new Float32Array([9, 0]));
});
