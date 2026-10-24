// Computes the (expensive) signals stage0 decides from: one embedding call,
// then cheap cosine/Jaccard/cue-phrase math against the given state.
// Deliberately separated from decide.ts so a threshold sweep can run
// decide() repeatedly against signals computed once — see bench/ts/sweep.ts.

import type { Embedder } from "../types";
import {
  cosineSimilarity,
  extractFileMentions,
  isShortQuestionForm,
  jaccard,
} from "./math";
import type { RouterConfig, RouterState, Signals } from "./types";

function hasAnyCue(prompt: string, phrases: readonly string[]): boolean {
  const lower = prompt.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

export async function computeSignals(
  prompt: string,
  state: RouterState,
  embedder: Embedder,
  config: RouterConfig,
): Promise<Signals> {
  const embeddings = await embedder.embed([prompt]);
  const promptEmbedding = embeddings[0];
  if (!promptEmbedding) {
    throw new Error("Embedder.embed returned no vector for the prompt");
  }
  const mentionedFiles = extractFileMentions(prompt);
  const stemCosine = cosineSimilarity(promptEmbedding, state.stemCentroid);

  const frondSignals = Object.values(state.fronds).map((frond) => {
    const cosine = cosineSimilarity(promptEmbedding, frond.centroid);
    const fileOverlap = jaccard(mentionedFiles, frond.files);
    const combined =
      config.weights.embedding * cosine +
      config.weights.fileOverlap * fileOverlap;
    return { frondId: frond.id, cosine, fileOverlap, combined };
  });

  return {
    promptEmbedding,
    mentionedFiles,
    stemCosine,
    frondSignals,
    hasCue: {
      new: hasAnyCue(prompt, config.cues.new),
      return: hasAnyCue(prompt, config.cues.return),
      stray: hasAnyCue(prompt, config.cues.stray),
    },
    isShortQuestion: isShortQuestionForm(
      prompt,
      config.thresholds.strayMaxPromptWords,
    ),
  };
}
