import { expect, test } from "bun:test";
import {
  describeSignals,
  hasMeasuredScore,
} from "../../src/router/signal-display";

test("only a Stage 0 similarity match is a measured score", () => {
  expect(hasMeasuredScore(0, ["active-frond-match"])).toBe(true);
  expect(hasMeasuredScore("0", ["other-frond-match"])).toBe(true);
});

test("a cue phrase is never a measured score, whatever it also matched", () => {
  expect(hasMeasuredScore(0, ["cue:new"])).toBe(false);
  expect(hasMeasuredScore(0, ["cue:return", "other-frond-match"])).toBe(false);
});

test("manual, forced, degraded, heuristic and Stage 2 decisions have no measured score", () => {
  expect(hasMeasuredScore("manual", ["manual"])).toBe(false);
  expect(hasMeasuredScore(0, ["forced-continue"])).toBe(false);
  expect(
    hasMeasuredScore(0, ["active-frond-match", "degraded:no-embedding"]),
  ).toBe(false);
  expect(hasMeasuredScore(0, ["no-frond-match", "file-divergence"])).toBe(
    false,
  );
  expect(hasMeasuredScore(0, ["low-similarity", "short-question-form"])).toBe(
    false,
  );
  expect(hasMeasuredScore(0, ["fallback-continue-bias"])).toBe(false);
  expect(hasMeasuredScore(2, ["stage2-same_goal:true"])).toBe(false);
  expect(hasMeasuredScore(null, [])).toBe(false);
});

test("describeSignals names signals in plain words, once each, without the degraded tag", () => {
  expect(describeSignals(["cue:new"])).toBe("cue phrase");
  expect(describeSignals(["cue:new", "cue:return"])).toBe("cue phrase");
  expect(describeSignals(["no-frond-match", "file-divergence"])).toBe(
    "no frond match, file divergence",
  );
  expect(describeSignals(["cue:stray", "degraded:no-embedding"])).toBe(
    "cue phrase",
  );
  expect(describeSignals(["degraded:no-embedding"])).toBe("");
  expect(describeSignals([])).toBe("");
});
