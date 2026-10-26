import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import type { JournalSink, Stage2CallLog } from "@context-fern/core";
import {
  countingJournalSink,
  groupAndSortByStream,
  loadDoneIds,
} from "./stage2-sample";

let tmpPath = "";

afterEach(async () => {
  if (tmpPath) {
    await rm(tmpPath, { force: true });
    tmpPath = "";
  }
});

function callLog(overrides: Partial<Stage2CallLog> = {}): Stage2CallLog {
  return {
    model: "qwen3:8b",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    escalatedAction: "continue",
    escalatedConfidence: 0.5,
    succeeded: true,
    createdAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

test("countingJournalSink counts succeeded and failed separately and still delegates to the inner sink", async () => {
  const recorded: Stage2CallLog[] = [];
  const inner: JournalSink = { record: (e) => void recorded.push(e) };
  const counts = { succeeded: 0, failed: 0 };
  const sink = countingJournalSink(inner, counts);

  await sink.record(callLog({ succeeded: true }));
  await sink.record(callLog({ succeeded: false }));
  await sink.record(callLog({ succeeded: true }));

  expect(counts).toEqual({ succeeded: 2, failed: 1 });
  expect(recorded).toHaveLength(3);
});

test("groupAndSortByStream groups by stream_id and sorts each group by turn_index", () => {
  const line = (streamId: string, turnIndex: number) => ({
    stream_id: streamId,
    turn_index: turnIndex,
    branch_id: null,
    action_truth: "continue",
    variant: "hard_cut",
    turn: { prompt_text: "p" },
  });
  const grouped = groupAndSortByStream([
    line("s2", 1),
    line("s1", 2),
    line("s1", 0),
    line("s2", 0),
  ]);

  expect([...grouped.keys()]).toEqual(["s2", "s1"]); // insertion order preserved
  expect(grouped.get("s1")?.map((l) => l.turn_index)).toEqual([0, 2]);
  expect(grouped.get("s2")?.map((l) => l.turn_index)).toEqual([0, 1]);
});

test("loadDoneIds returns an empty set when the checkpoint file doesn't exist yet", async () => {
  const done = await loadDoneIds(
    `${import.meta.dir}/.nonexistent-checkpoint.jsonl`,
  );
  expect(done.size).toBe(0);
});

test("loadDoneIds reads checkpointed row ids from an existing file", async () => {
  tmpPath = `${import.meta.dir}/.test-checkpoint.jsonl`;
  await writeFile(
    tmpPath,
    [
      JSON.stringify({ stream_id: "s1", turn_index: 0 }),
      JSON.stringify({ stream_id: "s1", turn_index: 5 }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const done = await loadDoneIds(tmpPath);
  expect(done).toEqual(new Set(["s1#0", "s1#5"]));
});
