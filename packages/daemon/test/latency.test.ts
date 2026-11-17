// The real p95 < 300ms budget (spec/task requirement), measured against
// the real warm TransformersEmbedder and a real temp SQLite store — not
// a FakeEmbedder. Slower than the rest of the suite by nature (genuine
// ONNX inference); that's the point of this file existing separately.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllProjects } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { withTempProjectDir } from "./test-helpers";

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

  const latencies: number[] = [];

  for (const prompt of PROMPTS) {
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
    latencies.push(performance.now() - start);
    expect(res.status).toBe(200);
  }

  latencies.sort((a, b) => a - b);
  const p95Index = Math.min(
    latencies.length - 1,
    Math.ceil(latencies.length * 0.95) - 1,
  );
  const p95 = latencies[p95Index] ?? 0;

  console.log(
    `/prompt latencies (ms): ${latencies.map((l) => l.toFixed(1)).join(", ")}`,
  );
  console.log(`p95: ${p95.toFixed(1)}ms`);

  expect(p95).toBeLessThan(300);
}, 60_000);
