import { expect, test } from "bun:test";
import { FakeEmbedder } from "../src/fake-embedder";

test("deterministic: the same text always embeds to the same vector", async () => {
  const embedder = new FakeEmbedder();
  const [a] = await embedder.embed(["look into the login bug"]);
  const [b] = await embedder.embed(["look into the login bug"]);
  expect(Array.from(a as Float32Array)).toEqual(Array.from(b as Float32Array));
});

test("shared vocabulary gives positive similarity, disjoint vocabulary gives ~0", async () => {
  const embedder = new FakeEmbedder();
  const [auth1, auth2, weather] = await embedder.embed([
    "login authentication bug",
    "login authentication flow",
    "weather forecast temperature",
  ]);

  const cosine = (a: Float32Array, b: Float32Array) => {
    let dot = 0;
    for (let i = 0; i < a.length; i++)
      dot += (a[i] as number) * (b[i] as number);
    return dot; // already L2-normalized, so dot product is cosine similarity
  };

  const authSimilarity = cosine(auth1 as Float32Array, auth2 as Float32Array);
  const crossSimilarity = cosine(
    auth1 as Float32Array,
    weather as Float32Array,
  );

  expect(authSimilarity).toBeGreaterThan(0.3);
  expect(crossSimilarity).toBeLessThan(0.1);
  expect(authSimilarity).toBeGreaterThan(crossSimilarity);
});

test("vectors are L2-normalized", async () => {
  const embedder = new FakeEmbedder();
  const [vec] = await embedder.embed(["any text at all here"]);
  let norm = 0;
  const typedVec = vec as Float32Array;
  for (let i = 0; i < typedVec.length; i++)
    norm += (typedVec[i] as number) ** 2;
  expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
});

test("embeds multiple texts in one call, preserving order", async () => {
  const embedder = new FakeEmbedder();
  const vectors = await embedder.embed(["alpha", "beta", "gamma"]);
  expect(vectors).toHaveLength(3);
});
