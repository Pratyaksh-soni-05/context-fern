// Loads the real project config, `.fern/config.toml` — spec §12. Mirrors
// packages/cli/src/load-config.ts's snake_case-to-camelCase translation
// (bench/results/thresholds.toml included), but with real validation:
// an unknown key, a wrong type, or an out-of-[0,1] value throws a plain-
// English error naming the exact key and file, instead of being silently
// ignored. packages/cli's loader serves `route --replay`'s explicit
// dev/bench path and is untouched here — see docs/decisions.md for the
// note that the two loaders currently overlap and should eventually be
// unified once a live CLI/daemon command reads this real config path.

import {
  DEFAULT_CONFIG,
  mergeConfig,
  type RouterConfig,
} from "@context-fern/core";

const TOP_LEVEL_SECTIONS = new Set([
  "thresholds",
  "weights",
  "cues",
  "escalation",
  "suggestion_precision",
  "briefs",
]);

const UNIT_INTERVAL_FIELDS = new Set([
  "thresholds.continue_min",
  "thresholds.new_max",
  "thresholds.return_min",
  "thresholds.stray_max_similarity",
  "weights.embedding",
  "weights.file_overlap",
  "escalation.low",
  "escalation.high",
  "suggestion_precision.new",
  "suggestion_precision.stray",
]);

class ConfigValidationError extends Error {
  constructor(path: string, message: string) {
    super(`Invalid .fern/config.toml: "${path}" ${message}`);
    this.name = "ConfigValidationError";
  }
}

function requireNumber(section: string, key: string, value: unknown): number {
  const path = `${section}.${key}`;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigValidationError(
      path,
      `must be a number, got ${JSON.stringify(value)}`,
    );
  }
  if (UNIT_INTERVAL_FIELDS.has(path) && (value < 0 || value > 1)) {
    throw new ConfigValidationError(
      path,
      `must be between 0 and 1, got ${value}`,
    );
  }
  return value;
}

function validateTopLevel(parsed: Record<string, unknown>): void {
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_SECTIONS.has(key)) {
      throw new ConfigValidationError(
        key,
        `is not a recognized config section (expected one of: ${[...TOP_LEVEL_SECTIONS].join(", ")})`,
      );
    }
  }
}

function toThresholds(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: Record<string, number> = {};
  const map: Record<string, string> = {
    continue_min: "continueMin",
    new_max: "newMax",
    return_min: "returnMin",
    stray_max_similarity: "strayMaxSimilarity",
    stray_max_prompt_words: "strayMaxPromptWords",
  };
  for (const [key, value] of Object.entries(raw)) {
    const camel = map[key];
    if (!camel) {
      throw new ConfigValidationError(
        `thresholds.${key}`,
        "is not a recognized threshold",
      );
    }
    out[camel] = requireNumber("thresholds", key, value);
  }
  return out;
}

function toWeights(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: Record<string, number> = {};
  const map: Record<string, string> = {
    embedding: "embedding",
    file_overlap: "fileOverlap",
  };
  for (const [key, value] of Object.entries(raw)) {
    const camel = map[key];
    if (!camel) {
      throw new ConfigValidationError(
        `weights.${key}`,
        "is not a recognized weight",
      );
    }
    out[camel] = requireNumber("weights", key, value);
  }
  return out;
}

function toCues(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: Record<string, string[]> = {};
  for (const key of ["new", "return", "stray"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new ConfigValidationError(
        `cues.${key}`,
        "must be a list of strings",
      );
    }
    out[key] = value as string[];
  }
  for (const key of Object.keys(raw)) {
    if (!["new", "return", "stray"].includes(key)) {
      throw new ConfigValidationError(
        `cues.${key}`,
        "is not a recognized cue list",
      );
    }
  }
  return out;
}

function toEscalation(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const key of ["low", "high"]) {
    if (raw[key] !== undefined)
      out[key] = requireNumber("escalation", key, raw[key]);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "low" && key !== "high") {
      throw new ConfigValidationError(
        `escalation.${key}`,
        "is not a recognized escalation field",
      );
    }
  }
  return out;
}

function toSuggestionPrecision(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const key of ["new", "stray"]) {
    if (raw[key] !== undefined) {
      out[key] = requireNumber("suggestion_precision", key, raw[key]);
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== "new" && key !== "stray") {
      throw new ConfigValidationError(
        `suggestion_precision.${key}`,
        "is not a recognized suggestion precision field",
      );
    }
  }
  return out;
}

function toBriefs(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  const out: { recordReplyGist?: boolean } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "record_reply_gist") {
      throw new ConfigValidationError(
        `briefs.${key}`,
        "is not a recognized briefs field",
      );
    }
    if (typeof value !== "boolean") {
      throw new ConfigValidationError(
        "briefs.record_reply_gist",
        `must be true or false, got ${JSON.stringify(value)}`,
      );
    }
    out.recordReplyGist = value;
  }
  return out;
}

/** No path given returns core's unmodified `DEFAULT_CONFIG` — including the interim `suggestionPrecision` thresholds. */
export async function loadFernConfig(path?: string): Promise<RouterConfig> {
  if (!path) return mergeConfig();

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new Error(`Can't read config file: ${path}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${path} isn't valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  validateTopLevel(parsed);

  return mergeConfig({
    thresholds: toThresholds(
      parsed.thresholds as Record<string, unknown> | undefined,
    ),
    weights: toWeights(parsed.weights as Record<string, unknown> | undefined),
    cues: toCues(parsed.cues as Record<string, unknown> | undefined),
    escalation: toEscalation(
      parsed.escalation as Record<string, unknown> | undefined,
    ),
    suggestionPrecision: toSuggestionPrecision(
      parsed.suggestion_precision as Record<string, unknown> | undefined,
    ),
    briefs: toBriefs(parsed.briefs as Record<string, unknown> | undefined),
  });
}

export { DEFAULT_CONFIG };
