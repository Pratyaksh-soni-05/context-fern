// A tiny local fake LlmClient for core's OWN tests. Deliberately not an
// import from packages/daemon — core's test suite stays as dependency-free
// as its source does. packages/daemon has its own, separately-tested
// FakeLlmClient; this one is structurally identical by convention, not by
// shared code.

import type { LlmClient, LlmResponse } from "../../src/types";

export interface FakeLlmCall {
  prompt: string;
  model: string;
}

type Responder = (params: { prompt: string; model: string }) => LlmResponse;

export function makeFakeLlmClient(
  responses: LlmResponse[] | Responder,
): LlmClient & { calls: FakeLlmCall[] } {
  const calls: FakeLlmCall[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const responder = Array.isArray(responses) ? null : responses;

  return {
    calls,
    async complete(params) {
      calls.push({ prompt: params.prompt, model: params.model });
      if (responder) return responder(params);
      const next = queue?.shift();
      if (!next) {
        throw new Error("makeFakeLlmClient: no more canned responses queued");
      }
      return next;
    },
  };
}
