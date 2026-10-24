import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@context-fern/core";
import { loadConfig } from "../src/load-config";

test("no path returns the default config unchanged", async () => {
  const config = await loadConfig();
  expect(config).toEqual(DEFAULT_CONFIG);
});

test("a snake_case TOML file (as bench sweep writes) is translated to camelCase thresholds", async () => {
  const path = `${import.meta.dir}/fixtures/snake-case-config.toml`;
  await Bun.write(
    path,
    [
      "[thresholds]",
      "continue_min = 0.4",
      "new_max = 0.1",
      "return_min = 0.35",
      "stray_max_similarity = 0.08",
      "stray_max_prompt_words = 10",
      "",
    ].join("\n"),
  );

  const config = await loadConfig(path);

  expect(config.thresholds.continueMin).toBe(0.4);
  expect(config.thresholds.newMax).toBe(0.1);
  expect(config.thresholds.returnMin).toBe(0.35);
  expect(config.thresholds.strayMaxSimilarity).toBe(0.08);
  expect(config.thresholds.strayMaxPromptWords).toBe(10);
  // weights/cues fall back to defaults — the TOML file didn't set them
  expect(config.weights).toEqual(DEFAULT_CONFIG.weights);
  expect(config.cues).toEqual(DEFAULT_CONFIG.cues);
});
