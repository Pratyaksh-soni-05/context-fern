import { expect, test } from "bun:test";
import { buildCandidates, sampleCandidates } from "./ceiling-sample";

function line(
  streamId: string,
  turnIndex: number,
  actionTruth: string,
  prompt: string,
) {
  return {
    stream_id: streamId,
    turn_index: turnIndex,
    action_truth: actionTruth,
    turn: { prompt_text: prompt, assistant_text: `reply-${prompt}` },
  };
}

test("buildCandidates excludes the first 3 turns of every stream", () => {
  const lines = [
    line("s1", 0, "continue", "p0"),
    line("s1", 1, "continue", "p1"),
    line("s1", 2, "continue", "p2"),
    line("s1", 3, "new", "p3"),
  ];
  const { newCandidates, continueCandidates } = buildCandidates(lines);
  expect(continueCandidates).toHaveLength(0); // p0-p2 are index < 3, excluded
  expect(newCandidates).toHaveLength(1);
  expect(newCandidates[0]?.id).toBe("s1#3");
  expect(newCandidates[0]?.previous_exchanges).toEqual([
    { prompt: "p0", assistant: "reply-p0" },
    { prompt: "p1", assistant: "reply-p1" },
    { prompt: "p2", assistant: "reply-p2" },
  ]);
});

test("buildCandidates only treats new/continue truths as candidates, not return/stray/combine", () => {
  const lines = [
    line("s1", 0, "continue", "p0"),
    line("s1", 1, "continue", "p1"),
    line("s1", 2, "continue", "p2"),
    line("s1", 3, "return", "p3"),
    line("s1", 4, "stray", "p4"),
    line("s1", 5, "combine", "p5"),
    line("s1", 6, "new", "p6"),
  ];
  const { newCandidates, continueCandidates } = buildCandidates(lines);
  expect(continueCandidates).toHaveLength(0);
  expect(newCandidates).toHaveLength(1);
  // previous 3 for turn 6 are turns 3,4,5 (return/stray/combine) — they're
  // valid context even though they're not candidates themselves.
  expect(newCandidates[0]?.previous_exchanges.map((e) => e.prompt)).toEqual([
    "p3",
    "p4",
    "p5",
  ]);
});

test("buildCandidates groups by stream and sorts by turn_index regardless of input order", () => {
  const lines = [
    line("s1", 3, "new", "p3"),
    line("s1", 1, "continue", "p1"),
    line("s1", 0, "continue", "p0"),
    line("s1", 2, "continue", "p2"),
  ];
  const { newCandidates } = buildCandidates(lines);
  expect(newCandidates[0]?.previous_exchanges.map((e) => e.prompt)).toEqual([
    "p0",
    "p1",
    "p2",
  ]);
});

function dummyCandidates(action: "new" | "continue", count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${action}-${i}`,
    action_truth: action,
    previous_exchanges: [],
    candidate_prompt: `prompt-${action}-${i}`,
  }));
}

test("sampleCandidates picks exactly 60 of each class", () => {
  const sample = sampleCandidates(
    dummyCandidates("new", 70),
    dummyCandidates("continue", 70),
    7,
  );
  expect(sample).toHaveLength(120);
  expect(sample.filter((r) => r.action_truth === "new")).toHaveLength(60);
  expect(sample.filter((r) => r.action_truth === "continue")).toHaveLength(60);
});

test("sampleCandidates is deterministic for the same seed", () => {
  const newC = dummyCandidates("new", 70);
  const contC = dummyCandidates("continue", 70);
  const a = sampleCandidates(newC, contC, 42);
  const b = sampleCandidates(newC, contC, 42);
  expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
});

test("sampleCandidates produces a different order for a different seed", () => {
  const newC = dummyCandidates("new", 70);
  const contC = dummyCandidates("continue", 70);
  const a = sampleCandidates(newC, contC, 1);
  const b = sampleCandidates(newC, contC, 2);
  expect(a.map((r) => r.id)).not.toEqual(b.map((r) => r.id));
});
