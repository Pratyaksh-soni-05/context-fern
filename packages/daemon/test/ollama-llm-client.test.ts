import { afterEach, expect, test } from "bun:test";
import { OllamaLlmClient } from "../src/ollama-llm-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("OllamaLlmClient posts to /api/chat with the model, prompt and format:json, no API key", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(
      JSON.stringify({
        message: { content: '{"same_goal": true}' },
        prompt_eval_count: 11,
        eval_count: 22,
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const client = new OllamaLlmClient({ baseUrl: "http://localhost:11434" });
  const response = await client.complete({
    prompt: "hello",
    model: "qwen3:8b",
  });

  expect(capturedUrl).toBe("http://localhost:11434/api/chat");
  const body = JSON.parse(capturedInit?.body as string);
  expect(body.model).toBe("qwen3:8b");
  expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  expect(body.format).toBe("json");
  // disables chain-of-thought on hybrid-reasoning models (qwen3) — measured
  // ~10-18s/call with thinking on vs ~0.2s/call off, see docs/decisions.md
  expect(body.think).toBe(false);
  expect(capturedInit?.headers).toEqual({ "content-type": "application/json" });
  // no Authorization/x-api-key header of any kind — nothing paid, no key
  expect(
    Object.keys(capturedInit?.headers as Record<string, string>),
  ).not.toContain("authorization");

  expect(response.text).toBe('{"same_goal": true}');
  expect(response.inputTokens).toBe(11);
  expect(response.outputTokens).toBe(22);
});

test("OllamaLlmClient defaults baseUrl to http://localhost:11434", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ message: { content: "{}" } }), {
      status: 200,
    });
  }) as typeof fetch;

  const client = new OllamaLlmClient();
  await client.complete({ prompt: "p", model: "m" });
  expect(capturedUrl).toBe("http://localhost:11434/api/chat");
});

test("OllamaLlmClient throws on a non-OK response", async () => {
  globalThis.fetch = (async () =>
    new Response("boom", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  const client = new OllamaLlmClient();
  await expect(client.complete({ prompt: "p", model: "m" })).rejects.toThrow(
    /ollama request failed/,
  );
});

test("OllamaLlmClient defaults missing token counts to 0", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: { content: "ok" } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const client = new OllamaLlmClient();
  const response = await client.complete({ prompt: "p", model: "m" });
  expect(response.inputTokens).toBe(0);
  expect(response.outputTokens).toBe(0);
});
