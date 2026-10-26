import type { LlmClient, LlmResponse } from "@context-fern/core";

export interface FakeLlmCall {
  prompt: string;
  model: string;
}

export type FakeLlmResponder = (params: {
  prompt: string;
  model: string;
}) => LlmResponse;

/**
 * Deterministic LlmClient test double — no network. Takes either a fixed
 * queue of responses (consumed in order) or a responder function for
 * prompt-dependent behavior. Mirrors packages/embed's FakeEmbedder: a
 * plain class, fully controlled, with a `calls` log so tests can assert
 * an LLM was (or wasn't) actually invoked.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: FakeLlmCall[] = [];
  private readonly queue: LlmResponse[];
  private readonly responder?: FakeLlmResponder;

  constructor(responses: LlmResponse[] | FakeLlmResponder) {
    if (typeof responses === "function") {
      this.queue = [];
      this.responder = responses;
    } else {
      this.queue = [...responses];
    }
  }

  async complete(params: {
    prompt: string;
    model: string;
  }): Promise<LlmResponse> {
    this.calls.push({ prompt: params.prompt, model: params.model });
    if (this.responder) return this.responder(params);
    const next = this.queue.shift();
    if (!next) {
      throw new Error("FakeLlmClient: no more canned responses queued");
    }
    return next;
  }
}
