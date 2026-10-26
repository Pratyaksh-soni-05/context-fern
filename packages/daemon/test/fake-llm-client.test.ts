import { expect, test } from "bun:test";
import { FakeLlmClient } from "../src/fake-llm-client";

test("FakeLlmClient returns queued responses in order and logs each call", async () => {
  const client = new FakeLlmClient([
    { text: "first", inputTokens: 1, outputTokens: 2 },
    { text: "second", inputTokens: 3, outputTokens: 4 },
  ]);

  const a = await client.complete({ prompt: "p1", model: "m1" });
  const b = await client.complete({ prompt: "p2", model: "m2" });

  expect(a.text).toBe("first");
  expect(b.text).toBe("second");
  expect(client.calls).toEqual([
    { prompt: "p1", model: "m1" },
    { prompt: "p2", model: "m2" },
  ]);
});

test("FakeLlmClient throws when the queue runs out", async () => {
  const client = new FakeLlmClient([
    { text: "only", inputTokens: 1, outputTokens: 1 },
  ]);
  await client.complete({ prompt: "p", model: "m" });
  await expect(client.complete({ prompt: "p", model: "m" })).rejects.toThrow();
});

test("FakeLlmClient supports a responder function for prompt-dependent behavior", async () => {
  const client = new FakeLlmClient(({ prompt }) => ({
    text: prompt.includes("switch") ? "new" : "continue",
    inputTokens: 0,
    outputTokens: 0,
  }));

  expect(
    (await client.complete({ prompt: "switch topics", model: "m" })).text,
  ).toBe("new");
  expect(
    (await client.complete({ prompt: "keep going", model: "m" })).text,
  ).toBe("continue");
  expect(client.calls).toHaveLength(2);
});
