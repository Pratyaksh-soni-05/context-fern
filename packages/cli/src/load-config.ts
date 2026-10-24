import {
  mergeConfig,
  type RouterConfig,
  type RouterThresholds,
} from "@context-fern/core";

// TOML config files use snake_case (bench/results/thresholds.toml included);
// RouterConfig uses camelCase. This is the one place that gap gets bridged.
const THRESHOLD_KEY_MAP: Record<string, keyof RouterThresholds> = {
  continue_min: "continueMin",
  new_max: "newMax",
  return_min: "returnMin",
  stray_max_similarity: "strayMaxSimilarity",
  stray_max_prompt_words: "strayMaxPromptWords",
};

function toCamelThresholds(
  raw: Record<string, unknown> | undefined,
): Partial<RouterThresholds> {
  const out: Partial<RouterThresholds> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const camelKey = THRESHOLD_KEY_MAP[key];
    if (camelKey && typeof value === "number") {
      (out as Record<string, number>)[camelKey] = value;
    }
  }
  return out;
}

/** core stays pure (no fs) — this is the one place a TOML path gets read. */
export async function loadConfig(path?: string): Promise<RouterConfig> {
  if (!path) return mergeConfig();
  const text = await Bun.file(path).text();
  const parsed = Bun.TOML.parse(text) as {
    thresholds?: Record<string, unknown>;
  };
  return mergeConfig({ thresholds: toCamelThresholds(parsed.thresholds) });
}
