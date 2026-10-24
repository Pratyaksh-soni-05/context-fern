import type { Embedder } from "@context-fern/core";
import { env, pipeline } from "@huggingface/transformers";
import { modelCacheDir } from "./cache-dir";

/**
 * Xenova/all-MiniLM-L6-v2: the standard ONNX conversion of
 * sentence-transformers/all-MiniLM-L6-v2 used throughout the
 * transformers.js ecosystem. 384-dim, strong semantic-similarity
 * performance for its size, Apache-2.0-compatible. Quantized (q8, ~23MB)
 * for a small download and fast CPU inference — this is Stage 0's local,
 * always-on embedder, so it has to run comfortably without a GPU.
 */
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class TransformersEmbedder implements Embedder {
  private extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(private readonly modelId: string = DEFAULT_MODEL_ID) {
    env.cacheDir = modelCacheDir();
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
