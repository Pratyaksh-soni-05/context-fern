import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/router/config";
import { routeTurnStage2 } from "../../src/router/route-turn-stage2";
import type { Clock } from "../../src/router/stage2";
import type { RouterState } from "../../src/router/types";
import type { Embedder } from "../../src/types";
import { makeFakeJournalSink } from "./fake-journal-sink";
import { makeFakeLlmClient } from "./fake-llm-client";

// A fixed-vector embedder (not the hash-based fake) so the resulting
// cosine similarity against a frond's centroid is exactly controllable —
// needed to land Stage 0's confidence precisely inside or outside the
// escalation band ([0.25, 0.5] by default).
const fixedEmbedder: Embedder = {
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]));
  },
};

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => {
      t += 1;
      return t;
    },
    nowIso: () => "2026-10-25T00:00:00.000Z",
  };
}

function emptyState(): RouterState {
  return { activeFrondId: null, stemCentroid: null, stemFiles: [], fronds: {} };
}

// activeScore = cosine(0, since [1,0] vs [0,1]) * weights.embedding(0.7)
// + fileOverlap(1, prompt mentions a.ts, frond.files=["a.ts"]) * weights.fileOverlap(0.3)
// = 0.3 -> inside [0.25, 0.5] -> continue fires with confidence 0.3.
function stateWithInBandActiveFrond(): RouterState {
  return {
    activeFrondId: "frond-active",
    stemCentroid: null,
    stemFiles: [],
    fronds: {
      "frond-active": {
        id: "frond-active",
        centroid: [0, 1],
        count: 1,
        files: ["a.ts"],
        status: "active",
      },
    },
  };
}

const canned = {
  text: JSON.stringify({
    same_goal: false,
    unrelated: true,
    confidence: 0.95,
    reason: "off topic",
  }),
  inputTokens: 10,
  outputTokens: 5,
};

test("routeTurnStage2: confidence outside the band never calls the LLM, decision stays stage 0", async () => {
  const llm = makeFakeLlmClient([canned]);
  const journal = makeFakeJournalSink();

  // Empty state -> zero topic fronds -> "no-frond-match" isn't evidence
  // of a new topic (see docs/decisions.md), so this falls through to
  // fallback-continue-bias at confidence 0 — clearly below the default
  // band's low (0.25).
  const result = await routeTurnStage2(
    "a brand new unrelated prompt",
    emptyState(),
    [],
    fixedEmbedder,
    DEFAULT_CONFIG,
    { llmClient: llm, model: "qwen3:8b", journal, clock: fakeClock() },
    { recentPrompts: [], briefSummary: null, stemGoal: null },
    "candidate-frond",
  );

  expect(result.decision.stage).toBe(0);
  expect(result.decision.action).toBe("continue");
  expect(llm.calls).toHaveLength(0);
  expect(journal.entries).toHaveLength(0);
  expect(result.stage0LatencyMs).toBeGreaterThan(0);
  expect(result.stage2LatencyMs).toBeNull();
});

test("routeTurnStage2: confidence inside the band calls the LLM and the decision becomes stage 2", async () => {
  const llm = makeFakeLlmClient([canned]);
  const journal = makeFakeJournalSink();

  const result = await routeTurnStage2(
    "let's edit a.ts some more",
    stateWithInBandActiveFrond(),
    [],
    fixedEmbedder,
    DEFAULT_CONFIG,
    { llmClient: llm, model: "qwen3:8b", journal, clock: fakeClock() },
    { recentPrompts: [], briefSummary: null, stemGoal: null },
  );

  expect(result.decision.stage).toBe(2);
  expect(result.decision.action).toBe("stray"); // from the canned response: unrelated:true
  // Stage 0's own pre-escalation call is preserved alongside the final
  // one, so an always-escalate pass can be sliced to simulate any band.
  expect(result.stage0Decision.action).toBe("continue");
  expect(result.stage0Decision.stage).toBe(0);
  expect(llm.calls).toHaveLength(1);
  expect(journal.entries).toHaveLength(1);
  expect(result.stage0LatencyMs).toBeGreaterThan(0);
  expect(result.stage2LatencyMs).toBeGreaterThan(0);
});

test("routeTurnStage2: alwaysEscalate forces the LLM call even when confidence is outside the band", async () => {
  const llm = makeFakeLlmClient([canned]);
  const journal = makeFakeJournalSink();

  const { decision } = await routeTurnStage2(
    "a brand new unrelated prompt",
    emptyState(),
    [],
    fixedEmbedder,
    DEFAULT_CONFIG,
    {
      llmClient: llm,
      model: "qwen3:8b",
      journal,
      clock: fakeClock(),
      alwaysEscalate: true,
    },
    { recentPrompts: [], briefSummary: null, stemGoal: null },
    "candidate-frond",
  );

  expect(decision.stage).toBe(2);
  expect(llm.calls).toHaveLength(1);
});

test("routeTurnStage2 still applies the decision to state exactly like routeTurn does", async () => {
  const llm = makeFakeLlmClient([
    {
      text: JSON.stringify({
        same_goal: true,
        unrelated: false,
        confidence: 0.6,
        reason: "same work",
      }),
      inputTokens: 1,
      outputTokens: 1,
    },
  ]);
  const journal = makeFakeJournalSink();

  const { nextState } = await routeTurnStage2(
    "let's edit a.ts some more",
    stateWithInBandActiveFrond(),
    ["a.ts"],
    fixedEmbedder,
    DEFAULT_CONFIG,
    { llmClient: llm, model: "qwen3:8b", journal, clock: fakeClock() },
    { recentPrompts: [], briefSummary: null, stemGoal: null },
  );

  // continue folds the new embedding into the active frond's centroid
  // and keeps its files — same applyDecision rules Stage 0 uses.
  expect(nextState.activeFrondId).toBe("frond-active");
  expect(nextState.fronds["frond-active"]?.count).toBe(2);
});
