import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import { stage0 } from "../../src/router/stage0";
import type { RouterState } from "../../src/router/types";
import { embedSingle, makeFakeEmbedder } from "./fake-embedder";

function emptyState(): RouterState {
  return { activeFrondId: null, stemCentroid: null, stemFiles: [], fronds: {} };
}

test("stage0 composes computeSignals and decide end to end: first prompt of a session is new", async () => {
  const embedder = makeFakeEmbedder();
  const decision = await stage0(
    "look into the auth bug in the login flow",
    emptyState(),
    embedder,
    DEFAULT_CONFIG,
  );
  expect(decision.action).toBe("new");
  expect(decision.stage).toBe(0);
});

test("stage0 continues a clearly on-topic follow-up", async () => {
  const embedder = makeFakeEmbedder();
  const centroid = await embedSingle(
    embedder,
    "look into the auth bug in the login flow",
  );
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-1": {
        id: "frond-1",
        centroid: Array.from(centroid),
        count: 1,
        files: [],
        status: "active",
      },
    },
  };

  const decision = await stage0(
    "did the auth login bug fix pass the tests",
    state,
    embedder,
    DEFAULT_CONFIG,
  );
  expect(decision.action).toBe("continue");
  expect(decision.target).toBe("frond-1");
});

test("stage0 fires stray on an explicit cue even mid-session", async () => {
  const embedder = makeFakeEmbedder();
  const centroid = await embedSingle(
    embedder,
    "look into the auth bug in the login flow",
  );
  const state: RouterState = {
    activeFrondId: "frond-1",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-1": {
        id: "frond-1",
        centroid: Array.from(centroid),
        count: 1,
        files: [],
        status: "active",
      },
    },
  };

  const decision = await stage0(
    "side question, what's a good name for a pet goldfish?",
    state,
    embedder,
    DEFAULT_CONFIG,
  );
  expect(decision.action).toBe("stray");
});
