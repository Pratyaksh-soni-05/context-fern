// Spec §3.2 + docs/decisions.md (2026-11-13): when the embedding model is
// missing or fails its pinned checksum, the daemon must still start and
// route — on cue phrases and file overlap only — say so plainly, tag
// every journalled decision, and never reach for the network. Driven
// through a real daemon, real HTTP and a real store; only the model
// directory is fake.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODEL_ID, MODEL_FILE_SHA256 } from "@context-fern/embed";
import { loadEmbedder } from "../src/embedder";
import { closeAllProjects } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { withTempProjectDir } from "./test-helpers";

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;
const realFetch = globalThis.fetch;
let outboundHosts: string[] = [];

beforeAll(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  // Every fetch made by this process is recorded, so "never a network
  // call" is asserted on what actually happened, not assumed.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") outboundHosts.push(url.hostname);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await closeAllProjects();
  outboundHosts = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!daemon) throw new Error("daemon not started");
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      [TOKEN_HEADER]: daemon.token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test("model missing: the daemon starts, says routing is degraded once, journals it on every turn, and makes no outbound call", async () => {
  const emptyCache = await mkdtemp(join(tmpdir(), "fern-no-model-"));
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });

  const first = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "fix the login bug in the auth module",
  });
  expect(first.receipt).toContain("routing degraded");
  expect(first.receipt).toContain("embedding model file missing");
  expect(first.receipt).toContain("suggestions on cue phrases only");
  expect(first.receipt).toContain("fern doctor");

  await call("POST", "/exchange-end", { projectPath: project.path });
  const second = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "add a retry to the auth client",
  });
  expect(second.receipt).not.toContain("routing degraded"); // once, not every prompt
  await call("POST", "/exchange-end", { projectPath: project.path });

  const status = await call(
    "GET",
    `/status?projectPath=${encodeURIComponent(project.path)}`,
  );
  expect(status.embedder).toMatchObject({ state: "degraded" });
  expect(status.statusReceipt).toContain("routing degraded");
  expect(status.leafletCount).toBe(2);

  const journal = (
    await readFile(join(project.path, ".fern", "journal.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { signals: string[] });
  expect(journal.length).toBe(2);
  for (const entry of journal) {
    expect(entry.signals).toContain("degraded:no-embedding");
  }

  expect(outboundHosts).toEqual([]);

  await daemon.stop(); // closes the store before its directory is removed
  daemon = undefined;
  await project.cleanup();
  await rm(emptyCache, { recursive: true, force: true });
}, 30_000);

test("model present but corrupt: refused by checksum, never loaded, cue phrases still route", async () => {
  const corruptCache = await mkdtemp(join(tmpdir(), "fern-bad-model-"));
  for (const file of Object.keys(MODEL_FILE_SHA256)) {
    const path = join(corruptCache, DEFAULT_MODEL_ID, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not the pinned bytes");
  }
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: corruptCache });

  const status = await call(
    "GET",
    `/status?projectPath=${encodeURIComponent(project.path)}`,
  );
  expect(status.embedder).toMatchObject({ state: "degraded" });
  expect((status.embedder as { reason: string }).reason).toContain(
    "failed its checksum",
  );

  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "fix the login bug in the auth module",
  });
  await call("POST", "/exchange-end", { projectPath: project.path });
  const cued = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "side question, what is a monad",
  });
  expect(cued.suggestion).toMatchObject({ action: "stray", confidence: null });
  expect((cued.suggestion as { signals: string[] }).signals).toEqual([
    "cue:stray",
    "degraded:no-embedding",
  ]);
  expect(cued.receipt).toContain("stray? · cue phrase · /fern stray");
  expect(String(cued.receipt)).not.toMatch(/\d\.\d\d/);

  expect(outboundHosts).toEqual([]);

  await daemon.stop(); // closes the store before its directory is removed
  daemon = undefined;
  await project.cleanup();
  await rm(corruptCache, { recursive: true, force: true });
}, 30_000);

test("manual decisions made while degraded are tagged in the journal too", async () => {
  const emptyCache = await mkdtemp(join(tmpdir(), "fern-no-model-"));
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });

  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern new auth-work",
  });
  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern new billing-work",
  });
  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern switch auth-work",
  });

  const journal = (
    await readFile(join(project.path, ".fern", "journal.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string; signals: string[] });
  expect(journal.map((entry) => entry.action)).toEqual([
    "new",
    "new",
    "return",
  ]);
  for (const entry of journal) {
    expect(entry.signals).toEqual(["manual", "degraded:no-embedding"]);
  }

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
  await rm(emptyCache, { recursive: true, force: true });
}, 30_000);

test("files pass their checksum but the model will not load: degraded with the load error, not a crash", async () => {
  const loaded = await loadEmbedder(undefined, {
    check: async () => null,
    create: () => ({
      embed: async () => {
        throw new Error("onnx session could not be created" + "\nstack");
      },
    }),
  });

  expect(loaded.health).toEqual({
    state: "degraded",
    reason: "embedding model failed to load: onnx session could not be created",
  });
  expect((await loaded.embedder.embed(["x"]))[0]?.length).toBe(0);
});

test("degraded: a cue phrase suggests, a prompt that merely names unrelated files does not", async () => {
  const emptyCache = await mkdtemp(join(tmpdir(), "fern-no-model-"));
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });

  const cue = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "new topic: payments",
  });
  expect(cue.suggestion).toMatchObject({ action: "new", confidence: null });
  expect(String(cue.receipt)).toContain("new frond?");
  expect(String(cue.receipt)).toContain(
    "new frond? payments · cue phrase · /fern new",
  );

  await call("POST", "/exchange-end", { projectPath: project.path });
  const files = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "look at src/payments.ts and src/billing.ts and src/invoices.ts",
  });
  expect(files.suggestion).toBeUndefined();

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
  await rm(emptyCache, { recursive: true, force: true });
}, 30_000);
