import type { LlmClient, LlmResponse } from "@context-fern/core";

export interface TimeoutRetryLlmClientOptions {
  timeoutMs?: number;
  retries?: number;
}

/**
 * Wraps any LlmClient with a per-call timeout and a fixed number of
 * retries on timeout or thrown error. Core's `adjudicate()` already
 * falls back to the Stage 0 decision and journals `succeeded: false` on
 * any thrown error — this wrapper just makes "the model hung" become a
 * thrown error after `timeoutMs` instead of blocking forever, so a
 * single stuck call can't stall an entire batch run.
 */
export class TimeoutRetryLlmClient implements LlmClient {
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(
    private readonly inner: LlmClient,
    options: TimeoutRetryLlmClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retries = options.retries ?? 1;
  }

  async complete(params: {
    prompt: string;
    model: string;
  }): Promise<LlmResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.withTimeout(this.inner.complete(params));
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`LlmClient call timed out after ${this.timeoutMs}ms`),
          ),
        this.timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
