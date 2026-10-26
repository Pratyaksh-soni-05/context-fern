import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@context-fern/core";
import { FakeLlmClient } from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";
import type { ReplayTurnInput, ReplayTurnOutput } from "../src/replay";
import { replayStage2 } from "../src/replay-stage2";

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

function inMemoryJournal() {
  const entries: unknown[] = [];
  return { entries, record: (entry: unknown) => void entries.push(entry) };
}

function fakeClock() {
  let t = 0;
  return {
    now: () => {
      t += 1;
      return t;
    },
    nowIso: () => "2026-10-25T00:00:00.000Z",
  };
}

test("golden: always-escalate calls the LLM on every turn and journals every call", async () => {
  const lines = await loadLines();
  const journal = inMemoryJournal();
  const llm = new FakeLlmClient(() => ({
    text: JSON.stringify({
      same_goal: true,
      unrelated: false,
      confidence: 0.77,
      reason: "same work",
    }),
    inputTokens: 10,
    outputTokens: 5,
  }));

  const output = await collect(
    replayStage2(lines, new FakeEmbedder(), DEFAULT_CONFIG, {
      llmClient: llm,
      model: "qwen3:8b",
      journal,
      clock: fakeClock(),
      alwaysEscalate: true,
    }),
  );

  expect(output).toHaveLength(4);
  expect(output.every((o) => o.predicted_action === "continue")).toBe(true);
  expect(output.every((o) => o.confidence === 0.77)).toBe(true);
  expect(llm.calls).toHaveLength(4);
  expect(journal.entries).toHaveLength(4);
  for (const row of output) {
    // always-escalate overrides the final action, but Stage 0's own
    // (pre-escalation) call is still reported for later simulation.
    expect(row.stage0_predicted_action).toBeDefined();
    expect(row.stage0_confidence).toBeGreaterThanOrEqual(0);
    expect(row.stage0_latency_ms).toBeGreaterThan(0);
    expect(row.stage2_latency_ms).toBeGreaterThan(0);
    expect(row.latency_ms).toBe(
      (row.stage0_latency_ms as number) + (row.stage2_latency_ms as number),
    );
  }
});

test("escalation band (not always-escalate) skips the LLM on out-of-band turns", async () => {
  const lines = await loadLines();
  const journal = inMemoryJournal();
  const llm = new FakeLlmClient(() => ({
    text: JSON.stringify({
      same_goal: false,
      unrelated: true,
      confidence: 0.5,
      reason: "x",
    }),
    inputTokens: 1,
    outputTokens: 1,
  }));

  const output = await collect(
    replayStage2(lines, new FakeEmbedder(), DEFAULT_CONFIG, {
      llmClient: llm,
      model: "qwen3:8b",
      journal,
      clock: fakeClock(),
    }),
  );

  expect(output).toHaveLength(4);
  // every row that never escalated has a null stage2_latency_ms and the
  // same predicted_action Stage 0 alone would have produced.
  const escalatedCount = output.filter(
    (o) => o.stage2_latency_ms !== null,
  ).length;
  expect(escalatedCount).toBe(llm.calls.length);
  expect(journal.entries).toHaveLength(llm.calls.length);
});
