import {
  type EscalationConfig,
  mergeConfig,
  type RouterConfig,
  type RouterThresholds,
  type SuggestionPrecisionConfig,
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

function toEscalation(
  raw: Record<string, unknown> | undefined,
): Partial<EscalationConfig> {
  const out: Partial<EscalationConfig> = {};
  if (typeof raw?.low === "number") out.low = raw.low;
  if (typeof raw?.high === "number") out.high = raw.high;
  return out;
}

function toSuggestionPrecision(
  raw: Record<string, unknown> | undefined,
): Partial<SuggestionPrecisionConfig> {
  const out: Partial<SuggestionPrecisionConfig> = {};
  if (typeof raw?.new === "number") out.new = raw.new;
  if (typeof raw?.stray === "number") out.stray = raw.stray;
  return out;
}

/** core stays pure (no fs) — this is the one place a TOML path gets read. */
export async function loadConfig(path?: string): Promise<RouterConfig> {
  if (!path) return mergeConfig();
  const text = await Bun.file(path).text();
  const parsed = Bun.TOML.parse(text) as {
    thresholds?: Record<string, unknown>;
    escalation?: Record<string, unknown>;
    suggestion_precision?: Record<string, unknown>;
  };
  return mergeConfig({
    thresholds: toCamelThresholds(parsed.thresholds),
    escalation: toEscalation(parsed.escalation),
    suggestionPrecision: toSuggestionPrecision(parsed.suggestion_precision),
  });
}
