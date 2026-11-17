import type { Embedder } from "@context-fern/core";
import { env, pipeline } from "@huggingface/transformers";
import { modelCacheDir } from "./cache-dir";
import { DEFAULT_MODEL_ID } from "./model-integrity";

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class TransformersEmbedder implements Embedder {
  private extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private readonly modelId: string = DEFAULT_MODEL_ID,
    cacheDir: string = modelCacheDir(),
  ) {
    env.cacheDir = cacheDir;
    // Spec §3.2: observe/suggest make no network call, ever. A cache
    // miss must fail fast, never fall through to a Hugging Face fetch —
    // that fetch hung a CI job for four hours against a blocked host
    // (docs/decisions.md, 2026-11-10). The daemon checks the pinned
    // files first and degrades instead of constructing this at all.
    env.allowRemoteModels = false;
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractorPromise) {
      this.extractorPromise = pipeline("feature-extraction", this.modelId, {
        dtype: "q8",
      }) as unknown as Promise<FeatureExtractionPipeline>;
    }
    return this.extractorPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((vector) => new Float32Array(vector));
  }
}
