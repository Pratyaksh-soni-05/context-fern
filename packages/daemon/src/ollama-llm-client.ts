import type { LlmClient, LlmResponse } from "@context-fern/core";

export interface OllamaLlmClientOptions {
  baseUrl?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Local-only, zero-cost LLM client: raw `fetch()` against Ollama's
 * `/api/chat`, no SDK dependency (CLAUDE.md prefers zero-dependency
 * solutions for a single JSON endpoint). No API key — Ollama is a local
 * server, nothing paid. `format: "json"` asks Ollama to constrain output
 * to valid JSON syntax; stage2.ts's parser still validates the schema,
 * since syntactically-valid JSON can still be missing the fields it needs.
 *
 * `think: false` disables chain-of-thought for hybrid-reasoning models
 * (qwen3 family) — measured ~10-18s/call with thinking on (hundreds of
 * reasoning tokens for a two-boolean answer) vs. ~0.2s/call with it off.
 * Models without a thinking mode (gemma3, etc.) just ignore the field.
 */
export class OllamaLlmClient implements LlmClient {
  private readonly baseUrl: string;

  constructor(options: OllamaLlmClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://localhost:11434";
  }

  async complete(params: {
    prompt: string;
    model: string;
  }): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: "user", content: params.prompt }],
        format: "json",
        stream: false,
        think: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as OllamaChatResponse;
    return {
      text: body.message?.content ?? "",
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
    };
  }
}
