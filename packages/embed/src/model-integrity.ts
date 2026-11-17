// The embedding model is a pinned, checksummed asset (docs/decisions.md):
// it is never fetched at runtime, and a file that is missing or does not
// match its pinned hash is never loaded. Deliberately free of
// @huggingface/transformers imports so `fern doctor` and the daemon can
// check the model without loading the ONNX runtime.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { modelCacheDir } from "./cache-dir";

/**
 * Xenova/all-MiniLM-L6-v2: the standard ONNX conversion of
 * sentence-transformers/all-MiniLM-L6-v2 used throughout the
 * transformers.js ecosystem. 384-dim, strong semantic-similarity
 * performance for its size, Apache-2.0-compatible. Quantized (q8, ~23MB)
 * for a small download and fast CPU inference — this is Stage 0's local,
 * always-on embedder, so it has to run comfortably without a GPU.
 */
export const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** SHA-256 of every file the q8 pipeline reads, relative to `<cache>/<model id>/`. */
export const MODEL_FILE_SHA256: Readonly<Record<string, string>> = {
  "config.json":
    "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer.json":
    "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json":
    "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx":
    "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
};

export interface ModelProblem {
  kind: "missing" | "checksum";
  /** Absolute path of the first file that failed. */
  path: string;
}

function sha256File(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", () => resolve(null));
  });
}

/** Null when every pinned file is present and matches; otherwise the first problem found. Reads only — never fetches, never writes. */
export async function checkModelFiles(
  cacheDir: string = modelCacheDir(),
): Promise<ModelProblem | null> {
  for (const [file, expected] of Object.entries(MODEL_FILE_SHA256)) {
    const path = join(cacheDir, DEFAULT_MODEL_ID, file);
    const actual = await sha256File(path);
    if (actual === null) return { kind: "missing", path };
    if (actual !== expected) return { kind: "checksum", path };
  }
  return null;
}
