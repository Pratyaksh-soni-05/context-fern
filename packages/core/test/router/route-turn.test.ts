import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import { decide } from "../../src/router/decide";
import { routeTurn } from "../../src/router/route-turn";
import { computeSignals } from "../../src/router/signals";
import { applyDecision } from "../../src/router/state";
import type { RouterState } from "../../src/router/types";
import { embedSingle, makeFakeEmbedder } from "./fake-embedder";

test("no leakage: this exchange's files must not influence this exchange's own decision", async () => {
  const embedder = makeFakeEmbedder();
  const centroid = await embedSingle(embedder, "look into the login system");
  const baseState: RouterState = {
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
  const prompt = "now edit login.ts to add the new field";
  const filesThisExchange = ["login.ts"]; // discovered only AFTER the prompt is routed

  // Correct order: compute signals on the OLD state. frond-1 hasn't
  // touched login.ts yet, so overlap must be 0.
  const correctSignals = await computeSignals(
    prompt,
    baseState,
    embedder,
    DEFAULT_CONFIG,
  );
  const correctOverlap = correctSignals.frondSignals.find(
    (f) => f.frondId === "frond-1",
  )?.fileOverlap;
  expect(correctOverlap).toBe(0);

  // Deliberately WRONG order: apply this exchange's files before deciding,
  // simulating the exact bug the no-leakage rule forbids.
  const leakedState = applyDecision(
    baseState,
    {
      action: "continue",
      target: "frond-1",
      confidence: 1,
      signals: [],
      stage: 0,
    },
    correctSignals.promptEmbedding,
    filesThisExchange,
  );
  const leakedSignals = await computeSignals(
    prompt,
    leakedState,
    embedder,
    DEFAULT_CONFIG,
  );
  const leakedOverlap = leakedSignals.frondSignals.find(
    (f) => f.frondId === "frond-1",
  )?.fileOverlap;

  // This proves leakage is real and observable: getting the order wrong
  // measurably changes the signal.
  expect(leakedOverlap).toBe(1);
  expect(correctOverlap).not.toBe(leakedOverlap);

  // routeTurn must take the CORRECT path: its decision must exactly match
  // deciding against the pre-update state, never the leaked one.
  const { decision, nextState } = await routeTurn(
    prompt,
    baseState,
    filesThisExchange,
    embedder,
    DEFAULT_CONFIG,
  );
  const decisionOnOldState = decide(correctSignals, baseState, DEFAULT_CONFIG);
  expect(decision).toEqual(decisionOnOldState);

  // routeTurn must not mutate the state it was given...
  expect(baseState.fronds["frond-1"]?.files).toEqual([]);
  // ...but the files DO land in the returned next state, for the NEXT turn.
  expect(nextState.fronds["frond-1"]?.files).toEqual(["login.ts"]);
});
