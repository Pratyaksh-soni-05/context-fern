import { expect, test } from "bun:test";
import type { LlmClient, LlmResponse } from "@context-fern/core";
import { TimeoutRetryLlmClient } from "../src/timeout-retry-llm-client";

function fakeDelayedClient(
  delayMs: number,
  response: LlmResponse = { text: "{}", inputTokens: 1, outputTokens: 1 },
): LlmClient {
  return {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return response;
    },
  };
}

function fakeThrowingNTimesClient(
  throwCount: number,
  response: LlmResponse = { text: "{}", inputTokens: 1, outputTokens: 1 },
): LlmClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete() {
      calls++;
      if (calls <= throwCount) throw new Error("boom");
      return response;
    },
  };
}

test("passes through a fast response unchanged", async () => {
  const client = new TimeoutRetryLlmClient(fakeDelayedClient(5), {
    timeoutMs: 1000,
  });
  const response = await client.complete({ prompt: "p", model: "m" });
  expect(response.text).toBe("{}");
});

test("rejects with a timeout error when the inner client takes too long, no retries configured", async () => {
  const client = new TimeoutRetryLlmClient(fakeDelayedClient(200), {
    timeoutMs: 20,
    retries: 0,
  });
  await expect(client.complete({ prompt: "p", model: "m" })).rejects.toThrow(
    /timed out/,
  );
});

test("retries once on a thrown error and succeeds on the second attempt", async () => {
  const inner = fakeThrowingNTimesClient(1);
  const client = new TimeoutRetryLlmClient(inner, {
    timeoutMs: 1000,
    retries: 1,
  });

  const response = await client.complete({ prompt: "p", model: "m" });
  expect(response.text).toBe("{}");
  expect(inner.calls).toBe(2);
});

test("gives up and throws after exhausting all retries", async () => {
  const inner = fakeThrowingNTimesClient(5);
  const client = new TimeoutRetryLlmClient(inner, {
    timeoutMs: 1000,
    retries: 1,
  });

  await expect(client.complete({ prompt: "p", model: "m" })).rejects.toThrow(
    "boom",
  );
  expect(inner.calls).toBe(2); // 1 initial attempt + 1 retry, both failed
});
