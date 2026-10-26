import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, decideAlwaysContinue } from "@context-fern/core";
import { FakeEmbedder } from "@context-fern/embed";
import {
  type ReplayTurnInput,
  type ReplayTurnOutput,
  replay,
} from "../src/replay";

const FIXTURE = new URL("./fixtures/tiny-stream.jsonl", import.meta.url);

async function loadLines(): Promise<ReplayTurnInput[]> {
  const text = await Bun.file(FIXTURE).text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function collect(
  rows: AsyncGenerator<ReplayTurnOutput>,
): Promise<ReplayTurnOutput[]> {
  const out: ReplayTurnOutput[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

test("golden: a clean new/continue/new/return stream replays correctly with the fake embedder", async () => {
  const lines = await loadLines();
  const embedder = new FakeEmbedder();
  const output = await collect(replay(lines, embedder, DEFAULT_CONFIG));

  expect(output).toHaveLength(4);
  expect(output.map((o) => o.predicted_action)).toEqual([
    "new",
    "continue",
    "new",
    "return",
  ]);

  // first-co-occurrence mapping: predicted branch ids must match ground truth
  expect(output[0]?.predicted_branch_id).toBe("session-a");
  expect(output[1]?.predicted_branch_id).toBe("session-a");
  expect(output[2]?.predicted_branch_id).toBe("session-b");
  expect(output[3]?.predicted_branch_id).toBe("session-a");

  // turn 3 returns to the SAME frond turn 0 created
  expect(output[3]?.target).toBe(output[0]?.target);

  // the raw ground-truth branch_id is passed through, not just the mapping
  expect(output.map((o) => o.branch_id)).toEqual([
    "session-a",
    "session-a",
    "session-b",
    "session-a",
  ]);

  for (const row of output) {
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.confidence).toBeGreaterThanOrEqual(0);
    expect(row.confidence).toBeLessThanOrEqual(1);
  }
});

test("a pluggable decideFn (e.g. the always-continue baseline) is honored", async () => {
  const lines = await loadLines();
  const embedder = new FakeEmbedder();
  const output = await collect(
    replay(lines, embedder, DEFAULT_CONFIG, decideAlwaysContinue),
  );

  expect(output.every((o) => o.predicted_action === "continue")).toBe(true);
});
