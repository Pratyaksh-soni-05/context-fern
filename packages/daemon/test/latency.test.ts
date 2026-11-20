// The real p95 < 300ms budget (spec/task requirement), measured against
// the real warm TransformersEmbedder and a real temp SQLite store — not
// a FakeEmbedder. Slower than the rest of the suite by nature (genuine
// ONNX inference); that's the point of this file existing separately.
//
// How the measurement is made robust without loosening the product budget
// (docs/decisions.md, 2026-11-20): the old version timed 10 prompts, so its
// "p95" was just the slowest of ten and one stalled request on a busy CI
// runner failed the run (a 319 ms outlier among nine requests of 6-19 ms).
// Now: untimed warm-up requests first, then 100 timed requests per round, so
// the p95 is the 95th of 100 and tolerates up to five slow ones. The budget
// is the same everywhere: p95 < 300 ms. Locally that is one round. On CI
// (CI=true) a shared runner can stall for seconds, so the run gets up to three
// independent rounds and passes if any one round is within the budget; a
// regression is slow in every round and still fails. In both modes the median
// must stay under half the budget, a separate and stricter check that a stall
// does not move but code that is slow for everyone does.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllProjects } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { withTempProjectDir } from "./test-helpers";

/** The product's /prompt budget (spec §3: p95). Never changed by the CI allowance below. */
const BUDGET_MS = 300;
const ON_CI = process.env.CI === "true" || process.env.CI === "1";
const WARMUP_REQUESTS = 10;
const SAMPLES_PER_ROUND = 100;
const ROUNDS = ON_CI ? 3 : 1;
/** The p95 ceiling is the product budget on every machine; CI only gets more rounds, never a higher ceiling. */
const P95_CEILING_MS = BUDGET_MS;
const MEDIAN_CEILING_MS = BUDGET_MS / 2;

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle;
let projectPath: string;

beforeAll(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  daemon = await startDaemon({ firstPort: 0 }); // real warm embedder, no override
  const dir = await withTempProjectDir();
  projectPath = dir.path;
}, 60_000); // model load/first warm-up can be slow on a cold cache

afterAll(async () => {
  await daemon.stop();
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await closeAllProjects();
});

const PROMPTS = [
  "fix the login bug in the auth module",
  "add a loading spinner to the dashboard",
  "refactor the database connection pool",
  "write unit tests for the payment service",
  "update the README with install instructions",
  "switching to set up the CI pipeline",
  "what's a good name for a feature flag",
  "investigate the flaky integration test",
  "clean up unused imports across the repo",
  "add retry logic to the HTTP client",
];

/** The value at the given quantile of an ascending list: the 95th of 100 for q = 0.95. */
function quantile(sortedAscending: number[], q: number): number {
  const index = Math.min(
    sortedAscending.length - 1,
    Math.ceil(sortedAscending.length * q) - 1,
  );
  return sortedAscending[index] ?? 0;
}

async function timedPrompt(prompt: string): Promise<number> {
  const start = performance.now();
  const res = await fetch(`http://127.0.0.1:${daemon.port}/prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TOKEN_HEADER]: daemon.token,
    },
    body: JSON.stringify({ projectPath, prompt }),
  });
  await res.json();
  const elapsed = performance.now() - start;
  expect(res.status).toBe(200);
  return elapsed;
}

/** Distinct text per request, so no turn is an exact repeat of an earlier one. */
function promptFor(n: number): string {
  return `${PROMPTS[n % PROMPTS.length]} (${n})`;
}

test("the percentile helper takes the 95th of 100, not the slowest", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(quantile(hundred, 0.95)).toBe(95);
  expect(quantile(hundred, 0.5)).toBe(50);
  expect(quantile([7], 0.95)).toBe(7);
  expect(quantile([], 0.95)).toBe(0);
});

test("/prompt answers within 300ms p95 against a warm real embedder and a real store", async () => {
  // The daemon degrades instead of failing when the model is absent, so
  // without this the budget would be "met" by an embedder that does no
  // work. Fetch the model once: bun run scripts/fetch-model.ts
  const status = (await (
    await fetch(
      `http://127.0.0.1:${daemon.port}/status?projectPath=${encodeURIComponent(projectPath)}`,
      { headers: { [TOKEN_HEADER]: daemon.token } },
    )
  ).json()) as { embedder: { state: string } };
  expect(status.embedder).toEqual({ state: "ok" });

  // Untimed: the first requests pay for lazy setup (connections, allocator, JIT) that the budget is not about.
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    await timedPrompt(`warm-up ${promptFor(i)}`);
  }

  const rounds: { p95: number; median: number }[] = [];
  let next = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const latencies: number[] = [];
    for (let i = 0; i < SAMPLES_PER_ROUND; i++) {
      latencies.push(await timedPrompt(promptFor(next++)));
    }
    latencies.sort((a, b) => a - b);
    const p95 = quantile(latencies, 0.95);
    const median = quantile(latencies, 0.5);
    rounds.push({ p95, median });
    console.log(
      `/prompt round ${round + 1}/${ROUNDS}: median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, max ${(latencies.at(-1) ?? 0).toFixed(1)}ms (p95 must be < ${P95_CEILING_MS}ms and median < ${MEDIAN_CEILING_MS}ms in ${ON_CI ? "one of up to 3 rounds, CI" : "the one round, local"})`,
    );
    if (p95 < P95_CEILING_MS && median < MEDIAN_CEILING_MS) break;
  }

  const passed = rounds.some(
    (r) => r.p95 < P95_CEILING_MS && r.median < MEDIAN_CEILING_MS,
  );
  expect(
    passed,
    `no round met p95 < ${P95_CEILING_MS}ms and median < ${MEDIAN_CEILING_MS}ms: ${JSON.stringify(rounds)}`,
  ).toBe(true);
}, 180_000);
