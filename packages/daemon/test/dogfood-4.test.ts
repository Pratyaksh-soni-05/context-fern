// Dogfood findings, driven through a real daemon, real HTTP and a real
// store (docs/decisions.md, 2026-11-17): frond names come from topic words,
// no invented numbers, a switch to the frond you are on is a no-op, and the
// reply gist lives in the brief file only.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllProjects } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { withTempProjectDir } from "./test-helpers";

let fakeHome: string;
let emptyCache: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;

beforeAll(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  emptyCache = await mkdtemp(join(tmpdir(), "fern-no-model-"));
  process.env.FERN_HOME = fakeHome;
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await closeAllProjects();
});

afterAll(async () => {
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(emptyCache, { recursive: true, force: true });
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

async function turn(
  projectPath: string,
  prompt: string,
  replyGist?: string,
): Promise<Record<string, unknown>> {
  const out = await call("POST", "/prompt", { projectPath, prompt });
  await call("POST", "/exchange-end", {
    projectPath,
    ...(replyGist ? { replyGist } : {}),
  });
  return out;
}

async function journal(
  projectPath: string,
): Promise<Array<{ action: string; signals: string[] }>> {
  return (await readFile(join(projectPath, ".fern", "journal.jsonl"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function briefTexts(projectPath: string): Promise<string[]> {
  const dir = join(projectPath, ".fern", "fronds");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  return Promise.all(files.map((f) => readFile(join(dir, f), "utf-8")));
}

test("a cue phrase's suggestion is named from the topic words and shows no number", async () => {
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });
  await turn(project.path, "fix the login bug in the auth module");

  const cued = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt:
      "Switching to something else: how would I add a README badge for build status?",
  });

  expect((cued.suggestion as { proposedName: string }).proposedName).toBe(
    "readme-badge",
  );
  expect(cued.receipt).toBe(
    "fern ▸ new frond? readme-badge · cue phrase · /fern new",
  );
  expect(String(cued.receipt)).not.toMatch(/\d/);

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
}, 30_000);

test("a manual switch shows no number, and the journal says it was manual", async () => {
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });
  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern new cleanup",
  });
  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern new billing",
  });
  const back = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern switch cleanup",
  });

  expect(back.receipt).toBe("fern ▸ returned to cleanup · /fern undo");
  expect(String(back.receipt)).not.toMatch(/\d\.\d\d/);

  const status = await call(
    "GET",
    `/status?projectPath=${encodeURIComponent(project.path)}`,
  );
  expect(String(status.statusReceipt)).not.toMatch(/\d\.\d\d/);

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
}, 30_000);

test("/fern switch to the frond you are already on is a no-op: no leaflet, no decision", async () => {
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });
  await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern new cleanup",
  });
  const before = await call(
    "GET",
    `/status?projectPath=${encodeURIComponent(project.path)}`,
  );
  const journalBefore = (await journal(project.path)).length;

  const same = await call("POST", "/prompt", {
    projectPath: project.path,
    prompt: "/fern switch cleanup",
  });

  expect(same.receipt).toBe("fern ▸ already on cleanup");
  const after = await call(
    "GET",
    `/status?projectPath=${encodeURIComponent(project.path)}`,
  );
  expect(after.leafletCount).toBe(before.leafletCount);
  expect((await journal(project.path)).length).toBe(journalBefore);

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
}, 30_000);

test("the reply gist lands in the brief under its prompt, redacted, and never in fern.db", async () => {
  const project = await withTempProjectDir();
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });

  await turn(
    project.path,
    "fix the login bug in the auth module",
    "Changed src/auth.ts to refresh the token. key sk-proj-AbCdEf0123456789AbCdEf0123 ok",
  );

  const [brief] = await briefTexts(project.path);
  expect(brief).toContain("fix the login bug");
  expect(brief).toMatch(
    /↳ reply: Changed src\/auth\.ts to refresh the token\./,
  );
  expect(brief).not.toContain("sk-proj");

  const db = await readFile(join(project.path, ".fern", "fern.db"));
  expect(db.includes(Buffer.from("refresh the token"))).toBe(false);
  expect(db.includes(Buffer.from("fix the login bug"))).toBe(false);

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
}, 30_000);

test("with [briefs] record_reply_gist = false the brief keeps the prompt but no reply", async () => {
  const project = await withTempProjectDir();
  await Bun.write(
    join(project.path, ".fern", "config.toml"),
    "[briefs]\nrecord_reply_gist = false\n",
  );
  daemon = await startDaemon({ firstPort: 0, modelCacheDir: emptyCache });

  await turn(
    project.path,
    "fix the login bug in the auth module",
    "Changed src/auth.ts to refresh the token.",
  );

  const [brief] = await briefTexts(project.path);
  expect(brief).toContain("fix the login bug");
  expect(brief).not.toContain("↳ reply");
  expect(brief).not.toContain("refresh the token");

  await daemon.stop();
  daemon = undefined;
  await project.cleanup();
}, 30_000);
