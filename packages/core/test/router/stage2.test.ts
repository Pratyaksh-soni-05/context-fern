import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import {
  adjudicate,
  type Clock,
  mapAdjudication,
} from "../../src/router/stage2";
import type {
  FrondSignal,
  RouterDecision,
  RouterState,
  Signals,
} from "../../src/router/types";
import type { Stage2CallLog } from "../../src/types";
import { makeFakeJournalSink } from "./fake-journal-sink";
import { makeFakeLlmClient } from "./fake-llm-client";

// adjudicate() only ever journals Stage2CallLog entries, never a Decision —
// this narrows the fake sink's JournalEntry union for property access below.
function stage2Log(entry: unknown): Stage2CallLog {
  return entry as Stage2CallLog;
}

function baseSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    promptEmbedding: new Float32Array([1, 0]),
    mentionedFiles: [],
    stemCosine: 0,
    frondSignals: [],
    hasCue: { new: false, return: false, stray: false },
    isShortQuestion: false,
    ...overrides,
  };
}

function baseState(overrides: Partial<RouterState> = {}): RouterState {
  return {
    activeFrondId: "frond-active",
    stemCentroid: null,
    stemFiles: [],
    fronds: {},
    ...overrides,
  };
}

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => {
      t += 5;
      return t;
    },
    nowIso: () => "2026-10-25T00:00:00.000Z",
  };
}

const stage0Decision: RouterDecision = {
  action: "continue",
  target: "frond-active",
  confidence: 0.4,
  signals: ["active-frond-match"],
  stage: 0,
};

// --- mapAdjudication truth table ---

test("mapAdjudication: same_goal true maps to continue, targeting the active frond", () => {
  const result = mapAdjudication(
    { same_goal: true, unrelated: false },
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
  );
  expect(result).toEqual({ action: "continue", target: "frond-active" });
});

test("mapAdjudication: same_goal true wins even when unrelated is also true (contradictory response)", () => {
  const result = mapAdjudication(
    { same_goal: true, unrelated: true },
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
  );
  expect(result.action).toBe("continue");
});

test("mapAdjudication: unrelated true (and same_goal false) maps to stray", () => {
  const result = mapAdjudication(
    { same_goal: false, unrelated: true },
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
  );
  expect(result).toEqual({ action: "stray", target: null });
});

test("mapAdjudication: neither true, with a strong other-frond match above returnMin, maps to return", () => {
  const frondSignals: FrondSignal[] = [
    { frondId: "frond-other", cosine: 0.9, fileOverlap: 0, combined: 0.9 },
  ];
  const result = mapAdjudication(
    { same_goal: false, unrelated: false },
    baseSignals({ frondSignals }),
    baseState(),
    DEFAULT_CONFIG,
  );
  expect(result).toEqual({ action: "return", target: "frond-other" });
});

test("mapAdjudication: neither true, with no strong other-frond match, maps to new", () => {
  const result = mapAdjudication(
    { same_goal: false, unrelated: false },
    baseSignals({ frondSignals: [] }),
    baseState(),
    DEFAULT_CONFIG,
  );
  expect(result).toEqual({ action: "new", target: null });
});

// --- adjudicate() ---

const context = {
  promptText: "let's work on something else",
  recentPrompts: ["earlier prompt 1", "earlier prompt 2"],
  briefSummary: null,
  stemGoal: null,
};

test("adjudicate: a valid response produces a stage-2 decision and journals succeeded:true", async () => {
  const llm = makeFakeLlmClient([
    {
      text: JSON.stringify({
        same_goal: false,
        unrelated: true,
        confidence: 0.9,
        reason: "off topic",
      }),
      inputTokens: 100,
      outputTokens: 20,
    },
  ]);
  const journal = makeFakeJournalSink();

  const decision = await adjudicate(
    stage0Decision,
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
    context,
    llm,
    "qwen3:8b",
    journal,
    fakeClock(),
  );

  expect(decision).toEqual({
    action: "stray",
    target: null,
    confidence: 0.9,
    signals: ["stage2-same_goal:false", "stage2-unrelated:true"],
    stage: 2,
  });
  expect(journal.entries).toHaveLength(1);
  expect(journal.entries[0]).toEqual({
    model: "qwen3:8b",
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 5,
    escalatedAction: "stray",
    escalatedConfidence: 0.9,
    succeeded: true,
    createdAt: "2026-10-25T00:00:00.000Z",
  });
  expect(llm.calls).toHaveLength(1);
});

test("adjudicate: a malformed (schema-invalid) response falls back to stage0Decision and journals succeeded:false", async () => {
  const llm = makeFakeLlmClient([
    {
      text: JSON.stringify({ reason: "no required fields" }),
      inputTokens: 5,
      outputTokens: 1,
    },
  ]);
  const journal = makeFakeJournalSink();

  const decision = await adjudicate(
    stage0Decision,
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
    context,
    llm,
    "qwen3:8b",
    journal,
    fakeClock(),
  );

  expect(decision).toBe(stage0Decision);
  expect(journal.entries).toHaveLength(1);
  expect(stage2Log(journal.entries[0]).succeeded).toBe(false);
  expect(stage2Log(journal.entries[0]).escalatedAction).toBe(
    stage0Decision.action,
  );
  expect(stage2Log(journal.entries[0]).escalatedConfidence).toBe(
    stage0Decision.confidence,
  );
});

test("adjudicate: a thrown error (e.g. network failure) falls back to stage0Decision and still journals", async () => {
  const llm = makeFakeLlmClient(() => {
    throw new Error("connection refused");
  });
  const journal = makeFakeJournalSink();

  const decision = await adjudicate(
    stage0Decision,
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
    context,
    llm,
    "qwen3:8b",
    journal,
    fakeClock(),
  );

  expect(decision).toBe(stage0Decision);
  expect(journal.entries).toHaveLength(1);
  expect(stage2Log(journal.entries[0]).succeeded).toBe(false);
});

test("adjudicate: non-JSON response text falls back and journals succeeded:false", async () => {
  const llm = makeFakeLlmClient([
    { text: "not json at all", inputTokens: 3, outputTokens: 1 },
  ]);
  const journal = makeFakeJournalSink();

  const decision = await adjudicate(
    stage0Decision,
    baseSignals(),
    baseState(),
    DEFAULT_CONFIG,
    context,
    llm,
    "qwen3:8b",
    journal,
    fakeClock(),
  );

  expect(decision).toBe(stage0Decision);
  expect(stage2Log(journal.entries[0]).succeeded).toBe(false);
});
