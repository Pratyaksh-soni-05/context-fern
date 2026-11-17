import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@context-fern/core";
import { loadFernConfig } from "../src/config";
import { type TempDir, withTempFernDir } from "./test-helpers";

let dir: TempDir | undefined;

afterEach(async () => {
  if (dir) await dir.cleanup();
  dir = undefined;
});

test("no path returns core's DEFAULT_CONFIG unchanged, including the interim suggestionPrecision thresholds", async () => {
  const config = await loadFernConfig();
  expect(config).toEqual(DEFAULT_CONFIG);
  expect(config.suggestionPrecision).toEqual({ new: 0.88, stray: 0.603 });
});

test("a well-formed TOML file overrides thresholds, cues and suggestion_precision", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "config.toml");
  await Bun.write(
    path,
    [
      "[thresholds]",
      "continue_min = 0.4",
      "",
      "[cues]",
      'new = ["switching to", "moving on to"]',
      "",
      "[suggestion_precision]",
      "new = 0.9",
      "stray = 0.7",
      "",
    ].join("\n"),
  );

  const config = await loadFernConfig(path);
  expect(config.thresholds.continueMin).toBe(0.4);
  expect(config.cues.new).toEqual(["switching to", "moving on to"]);
  expect(config.suggestionPrecision).toEqual({ new: 0.9, stray: 0.7 });
  // untouched sections fall back to defaults
  expect(config.thresholds.newMax).toBe(DEFAULT_CONFIG.thresholds.newMax);
});

const invalidCases: { name: string; toml: string; messageContains: string }[] =
  [
    {
      name: "unknown top-level section",
      toml: "[nonsense]\nfoo = 1\n",
      messageContains: "nonsense",
    },
    {
      name: "unknown threshold key",
      toml: "[thresholds]\nnot_a_real_threshold = 0.5\n",
      messageContains: "thresholds.not_a_real_threshold",
    },
    {
      name: "wrong type for a threshold",
      toml: '[thresholds]\ncontinue_min = "high"\n',
      messageContains: "must be a number",
    },
    {
      name: "a unit-interval field out of range",
      toml: "[escalation]\nlow = 1.5\n",
      messageContains: "between 0 and 1",
    },
    {
      name: "unknown suggestion_precision key",
      toml: "[suggestion_precision]\ncombine = 0.5\n",
      messageContains: "suggestion_precision.combine",
    },
  ];

for (const { name, toml, messageContains } of invalidCases) {
  test(`loadFernConfig rejects: ${name}`, async () => {
    dir = await withTempFernDir();
    const path = join(dir.path, "config.toml");
    await Bun.write(path, toml);

    await expect(loadFernConfig(path)).rejects.toThrow(
      new RegExp(messageContains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
}

test("[briefs] record_reply_gist defaults to on, and false turns the gist off", async () => {
  expect(DEFAULT_CONFIG.briefs.recordReplyGist).toBe(true);
  expect((await loadFernConfig()).briefs.recordReplyGist).toBe(true);

  dir = await withTempFernDir();
  const path = join(dir.path, "config.toml");
  await Bun.write(path, "[briefs]\nrecord_reply_gist = false\n");
  expect((await loadFernConfig(path)).briefs.recordReplyGist).toBe(false);

  await Bun.write(path, "[thresholds]\ncontinue_min = 0.4\n");
  expect((await loadFernConfig(path)).briefs.recordReplyGist).toBe(true);
});

test("[briefs] rejects a non-boolean value and an unknown key, naming the exact key", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "config.toml");

  await Bun.write(path, '[briefs]\nrecord_reply_gist = "no"\n');
  await expect(loadFernConfig(path)).rejects.toThrow(
    /briefs\.record_reply_gist.*true or false/,
  );

  await Bun.write(path, "[briefs]\nrecord_replies = true\n");
  await expect(loadFernConfig(path)).rejects.toThrow(/briefs\.record_replies/);
});
