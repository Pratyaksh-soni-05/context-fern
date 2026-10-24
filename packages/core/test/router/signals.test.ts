import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import { computeSignals } from "../../src/router/signals";
import type { RouterState } from "../../src/router/types";
import { embedSingle, makeFakeEmbedder } from "./fake-embedder";

function emptyState(): RouterState {
  return { activeFrondId: null, stemCentroid: null, stemFiles: [], fronds: {} };
}

test("mentioned files are extracted from the prompt text", async () => {
  const embedder = makeFakeEmbedder();
  const signals = await computeSignals(
    "fix the bug in src/auth.ts please",
    emptyState(),
    embedder,
    DEFAULT_CONFIG,
  );
  expect(signals.mentionedFiles).toEqual(["src/auth.ts"]);
});

test("cue phrases are detected case-insensitively", async () => {
  const embedder = makeFakeEmbedder();
  const signals = await computeSignals(
    "OK, Switching To the docker build now",
    emptyState(),
    embedder,
    DEFAULT_CONFIG,
  );
  expect(signals.hasCue.new).toBe(true);
  expect(signals.hasCue.return).toBe(false);
  expect(signals.hasCue.stray).toBe(false);
});

test("a frond sharing vocabulary with the prompt scores higher than an unrelated one", async () => {
  const embedder = makeFakeEmbedder();
  const authCentroid = await embedSingle(
    embedder,
    "look into the authentication login bug",
  );
  const weatherCentroid = await embedSingle(
    embedder,
    "what is the weather forecast today",
  );

  const state: RouterState = {
    activeFrondId: "frond-auth",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-auth": {
        id: "frond-auth",
        centroid: Array.from(authCentroid),
        count: 1,
        files: [],
        status: "active",
      },
      "frond-weather": {
        id: "frond-weather",
        centroid: Array.from(weatherCentroid),
        count: 1,
        files: [],
        status: "resting",
      },
    },
  };

  const signals = await computeSignals(
    "more work on the login authentication flow",
    state,
    embedder,
    DEFAULT_CONFIG,
  );
  const authSignal = signals.frondSignals.find(
    (f) => f.frondId === "frond-auth",
  );
  const weatherSignal = signals.frondSignals.find(
    (f) => f.frondId === "frond-weather",
  );

  if (!authSignal || !weatherSignal)
    throw new Error("expected both signals to exist");
  expect(authSignal.cosine).toBeGreaterThan(weatherSignal.cosine);
});

test("isShortQuestion reflects the configured word-count threshold", async () => {
  const embedder = makeFakeEmbedder();
  const short = await computeSignals(
    "what's the weather like today?",
    emptyState(),
    embedder,
    DEFAULT_CONFIG,
  );
  const long = await computeSignals(
    "please refactor the authentication module to use the new session store and update every call site",
    emptyState(),
    embedder,
    DEFAULT_CONFIG,
  );
  expect(short.isShortQuestion).toBe(true);
  expect(long.isShortQuestion).toBe(false);
});
