import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedder } from "@context-fern/embed";
import { readBrief, writeBriefSections } from "@context-fern/store";
import { closeAllProjects, getOrOpenProject } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { type TempDir, withTempProjectDir } from "./test-helpers";

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;
let projectDir: TempDir | undefined;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });
  projectDir = await withTempProjectDir();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  if (projectDir) await projectDir.cleanup();
  await closeAllProjects();
});

function baseUrl(): string {
  return `http://127.0.0.1:${daemon?.port}`;
}

interface CallOpts {
  host?: string;
  origin?: string;
  token?: string | null;
}

async function call(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  opts: CallOpts = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = opts.token === null ? undefined : (opts.token ?? daemon?.token);
  if (token) headers[TOKEN_HEADER] = token;
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

function post(path: string, body: Record<string, unknown>, opts?: CallOpts) {
  return call("POST", path, body, opts);
}

function get(path: string, opts?: CallOpts) {
  return call("GET", path, null, opts);
}

function projectBody(extra: Record<string, unknown> = {}) {
  return { projectPath: projectDir?.path, ...extra };
}

test("rejects a request with no auth token", async () => {
  const { status } = await post("/prompt", projectBody({ prompt: "hello" }), {
    token: null,
  });
  expect(status).toBe(403);
});

test("rejects a request with the wrong auth token", async () => {
  const { status } = await post("/prompt", projectBody({ prompt: "hello" }), {
    token: "wrong-token",
  });
  expect(status).toBe(403);
});

test("rejects a request whose Host header isn't exactly 127.0.0.1:<port> or localhost:<port>", async () => {
  const { status } = await post("/prompt", projectBody({ prompt: "hello" }), {
    host: `127.0.0.1evil.com:${daemon?.port}`,
  });
  expect(status).toBe(403);
});

test("rejects a request with a non-local Origin", async () => {
  const { status } = await post("/prompt", projectBody({ prompt: "hello" }), {
    origin: "https://evil.example.com",
  });
  expect(status).toBe(403);
});

test("accepts a request with a local Origin", async () => {
  const { status } = await post(
    "/prompt",
    projectBody({ prompt: "hello there" }),
    {
      origin: "http://localhost:51234",
    },
  );
  expect(status).toBe(200);
});

test("the full /prompt -> /tools -> /exchange-end happy path records a leaflet", async () => {
  const prompt = await post(
    "/prompt",
    projectBody({ prompt: "please fix the login bug" }),
  );
  expect(prompt.status).toBe(200);
  expect(prompt.json.ok).toBe(true);

  const tools = await post(
    "/tools",
    projectBody({
      filesTouched: [{ path: "src/login.ts", source: "tool_input" }],
    }),
  );
  expect(tools.status).toBe(200);

  const end = await post("/exchange-end", projectBody());
  expect(end.status).toBe(200);

  const tree = await get(
    `/tree?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(tree.status).toBe(200);
  expect(tree.json.stemName).toBe("stem");
});

test("/tools never records a .fern/ path as a touched file, even if a caller sends one directly — the hook's own filter isn't the only enforcement", async () => {
  await post("/prompt", projectBody({ prompt: "please fix the login bug" }));
  await post(
    "/tools",
    projectBody({
      filesTouched: [
        { path: ".fern/fronds/stem.md", source: "tool_input" },
        { path: ".fern/journal.jsonl", source: "tool_input" },
        { path: "src/login.ts", source: "tool_input" },
      ],
    }),
  );
  await post("/exchange-end", projectBody());

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const stem = (await state.store.listFronds(state.sessionId)).find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("stem not found");
  const brief = await readBrief(stem.briefPath);
  expect(brief.Files).toBe("src/login.ts");
  expect(brief.Files).not.toContain(".fern");
});

test("a manual /fern stray (bare) retroactively marks the last exchange", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "unrelated question about pizza toppings" }),
  );
  await post("/exchange-end", projectBody());

  const stray = await post("/prompt", projectBody({ prompt: "/fern stray" }));
  expect(stray.status).toBe(200);
  expect(stray.json.receipt).toContain("stray (marked)");
});

test("bare /fern stray right after a suggestion-producing prompt (no /exchange-end in between) marks THAT prompt, not an older leaflet nor a stray 'continue'", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "switching to investigate the flaky checkout test" }),
  );
  const stray = await post("/prompt", projectBody({ prompt: "/fern stray" }));
  expect(stray.status).toBe(200);

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const rows = state.store.db
    .query(
      "SELECT action, prompt_hash FROM decisions d JOIN leaflets l ON d.leaflet_id = l.id ORDER BY d.seq ASC",
    )
    .all() as { action: string; prompt_hash: string }[];

  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("stray");
  const realPromptHash = `sha256:${createHash("sha256")
    .update("switching to investigate the flaky checkout test")
    .digest("hex")}`;
  expect(rows[0]?.prompt_hash).toBe(realPromptHash);
});

test("the '? ' prefix marks the current prompt stray immediately", async () => {
  const res = await post(
    "/prompt",
    projectBody({ prompt: "? what's a good lunch spot" }),
  );
  expect(res.status).toBe(200);
  expect(res.json.receipt).toBe(
    "fern ▸ stray · answered, kept off every frond",
  );
});

test("a bare /fern new accepts the pending suggestion using its proposed name", async () => {
  // A prompt whose cue phrase clears the "new" display bar every time, independent of embeddings.
  const prompted = await post(
    "/prompt",
    projectBody({ prompt: "switching to set up the docker build pipeline" }),
  );
  expect(prompted.status).toBe(200);
  expect(prompted.json.suggestion).toBeTruthy();

  const accepted = await post("/prompt", projectBody({ prompt: "/fern new" }));
  expect(accepted.status).toBe(200);
  expect(accepted.json.receipt).toContain("fern ▸ on set-docker-build");

  const tree = await get(
    `/tree?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  const fronds = tree.json.fronds as { name: string }[];
  expect(fronds.map((f) => f.name)).toContain("set-docker-build");
});

test("accepting a pending suggestion reclassifies the ORIGINAL triggering prompt — not a disconnected synthetic leaflet, and not also recorded as a stray 'continue' on the stem", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "switching to set up the docker build pipeline" }),
  );
  await post("/prompt", projectBody({ prompt: "/fern new" }));

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const rows = state.store.db
    .query(
      "SELECT action, prompt_hash, frond_id FROM decisions d JOIN leaflets l ON d.leaflet_id = l.id ORDER BY d.seq ASC",
    )
    .all() as {
    action: string;
    prompt_hash: string;
    frond_id: string | null;
  }[];

  // Exactly one decision for this whole exchange — the real prompt was
  // reclassified as "new", never first recorded as a stray "continue"
  // on the stem.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("new");

  // Its leaflet carries the REAL prompt's hash, not the literal command
  // text "/fern new set-docker-build".
  const realPromptHash = `sha256:${createHash("sha256")
    .update("switching to set up the docker build pipeline")
    .digest("hex")}`;
  expect(rows[0]?.prompt_hash).toBe(realPromptHash);

  // The new frond's centroid came from the real prompt's embedding, not null.
  const fronds = state.store.db
    .query("SELECT centroid FROM fronds WHERE name = 'set-docker-build'")
    .get() as { centroid: string | null };
  expect(fronds.centroid).not.toBeNull();
});

test("a later plain prompt's suggestion replaces (expires) an earlier pending one", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "switching to set up the docker build pipeline" }),
  );
  await post(
    "/prompt",
    projectBody({ prompt: "switching to fix the flaky login test" }),
  );

  const accepted = await post("/prompt", projectBody({ prompt: "/fern new" }));
  expect(accepted.status).toBe(200);
  expect(accepted.json.receipt).toContain("flaky-login-test");
  expect(accepted.json.receipt).not.toContain("docker");
});

test("a bare /fern new with nothing pending and no name is a 400, not a 500", async () => {
  const res = await post("/prompt", projectBody({ prompt: "/fern new" }));
  expect(res.status).toBe(400);
});

test("/fern new <name> works standalone, with no pending suggestion", async () => {
  const res = await post(
    "/prompt",
    projectBody({ prompt: "/fern new docker-build" }),
  );
  expect(res.status).toBe(200);
  expect(res.json.receipt).toContain("fern ▸ on docker-build");
});

test("/fern new <name> typed twice switches to the existing frond instead of creating a duplicate", async () => {
  const first = await post(
    "/prompt",
    projectBody({ prompt: "/fern new greetings" }),
  );
  expect(first.json.receipt).toContain("fern ▸ on greetings");

  const second = await post(
    "/prompt",
    projectBody({ prompt: "/fern new greetings" }),
  );
  expect(second.json.receipt).toBe(
    "fern ▸ greetings already exists · switched",
  );

  const tree = await get(
    `/tree?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  const fronds = tree.json.fronds as { name: string }[];
  expect(fronds.filter((f) => f.name === "greetings")).toHaveLength(1);
});

test("accepting a suggestion deterministically fills the new brief's Goal from the real triggering prompt, no model call", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "switching to set up the docker build pipeline" }),
  );
  await post("/prompt", projectBody({ prompt: "/fern new" }));

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "set-docker-build");
  if (!frond) throw new Error("frond not created");
  const brief = await readBrief(frond.briefPath);
  expect(brief.Goal).toBe("switching to set up the docker build pipeline");
});

test("a frond created by a direct /fern new <name>, with nothing pending, starts with an empty Goal — filled by the next prompt instead", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  expect((await readBrief(frond.briefPath)).Goal).toBe("");

  await post(
    "/prompt",
    projectBody({ prompt: "let's wire up the dockerfile first" }),
  );
  await post("/exchange-end", projectBody());
  expect((await readBrief(frond.briefPath)).Goal).toBe(
    "let's wire up the dockerfile first",
  );
});

test("Goal is set once and never overwritten by a later prompt on the same frond, even though Files keeps growing", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  await post(
    "/prompt",
    projectBody({ prompt: "let's wire up the dockerfile first" }),
  );
  await post("/prompt", projectBody({ prompt: "now the compose file too" }));

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  expect((await readBrief(frond.briefPath)).Goal).toBe(
    "let's wire up the dockerfile first",
  );
});

test("Files is filled deterministically from the frond's accumulated touched paths", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  await post("/prompt", projectBody({ prompt: "editing the dockerfile" }));
  await post(
    "/tools",
    projectBody({
      filesTouched: [{ path: "Dockerfile", source: "tool_input" }],
    }),
  );
  await post("/exchange-end", projectBody());

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  expect((await readBrief(frond.briefPath)).Files).toContain("Dockerfile");
});

test("the restored receipt pluralizes the file count correctly at exactly 1", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "/fern new greetings", agentSessionId: "session-A" }),
  );
  await post(
    "/prompt",
    projectBody({
      prompt: "editing the readme",
      agentSessionId: "session-A",
    }),
  );
  await post(
    "/tools",
    projectBody({
      filesTouched: [{ path: "README.md", source: "tool_input" }],
    }),
  );
  await post("/exchange-end", projectBody());

  const restored = await post(
    "/prompt",
    projectBody({ prompt: "what's next", agentSessionId: "session-B" }),
  );
  expect(restored.json.receipt).toContain(
    "fern ▸ restored greetings · brief · 1 file",
  );
  expect(restored.json.receipt).not.toContain("1 files");
});

test("restore (receipt and brief content) works on the stem, with no frond ever created — the common case, since most users never run /fern new", async () => {
  await post(
    "/prompt",
    projectBody({
      prompt: "fix the typo in the readme",
      agentSessionId: "session-A",
    }),
  );
  await post(
    "/prompt",
    projectBody({
      prompt: "also update the changelog",
      agentSessionId: "session-A",
    }),
  );

  // A different agentSessionId simulates /clear.
  const restored = await post(
    "/prompt",
    projectBody({ prompt: "what's next", agentSessionId: "session-B" }),
  );
  expect(restored.json.receipt).toContain("fern ▸ restored stem · brief");

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const stem = (await state.store.listFronds(state.sessionId)).find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("stem not found");
  const brief = await readBrief(stem.briefPath);
  expect(brief.Goal).toBe("fix the typo in the readme");
  expect(brief.Recent).toContain("- also update the changelog");

  const status = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(status.json.brief as string).toContain("fix the typo in the readme");
});

test("GET /status?restored=true queues the receipt for the next /prompt even when agentSessionId never changes — whether Claude Code mints a new one across /clear isn't confirmed either way", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "/fern new greetings", agentSessionId: "session-A" }),
  );

  // Same agentSessionId throughout — simulates Claude Code NOT minting
  // a new one for /clear, the scenario the agentSessionId-only check
  // alone would miss entirely.
  await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&agentSessionId=session-A&restored=true`,
  );

  const restored = await post(
    "/prompt",
    projectBody({ prompt: "what's next", agentSessionId: "session-A" }),
  );
  expect(restored.json.receipt).toContain("fern ▸ restored greetings · brief");

  // The flag is one-shot: the call after that gets no receipt.
  const again = await post(
    "/prompt",
    projectBody({ prompt: "and then", agentSessionId: "session-A" }),
  );
  expect(again.json.receipt).not.toContain("restored");
});

test("the first /prompt under a new agentSessionId (a resume/clear/compaction/fork) gets a restored receipt prepended, belt-and-suspenders with SessionStart's own", async () => {
  await post(
    "/prompt",
    projectBody({ prompt: "/fern new greetings", agentSessionId: "session-A" }),
  );

  // Same agentSessionId again — no restore boundary, no receipt.
  const samesession = await post(
    "/prompt",
    projectBody({ prompt: "hello again", agentSessionId: "session-A" }),
  );
  expect(samesession.json.receipt).not.toContain("restored");

  // A different agentSessionId — exactly what Claude Code mints on
  // resume/clear/compaction/fork — is the restore boundary.
  const restored = await post(
    "/prompt",
    projectBody({ prompt: "what's next", agentSessionId: "session-B" }),
  );
  expect(restored.json.receipt).toContain("fern ▸ restored greetings · brief");
});

test("a session for an existing project path is resumed, not abandoned for a fresh stem, across a cold reopen (the real cause of a broken /clear restore)", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new greetings" }));
  const before = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(before.json.activeFrondName).toBe("greetings");

  // Simulates exactly what a daemon restart (a crash, the version-check
  // self-heal, a reboot) does to the in-memory project registry: the
  // cache is cleared, so the next call must re-open the SAME
  // underlying fern.db from scratch — openProject used to always
  // insert a brand-new session there, silently abandoning the one
  // above in favor of an empty stem.
  await closeAllProjects();

  const after = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(after.json.activeFrondName).toBe("greetings");
});

test("Recent accumulates the last 5 prompts' first lines, newest first, independent of Goal", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");

  await post(
    "/prompt",
    projectBody({ prompt: "let's wire up the dockerfile first" }),
  );
  await post("/prompt", projectBody({ prompt: "now the compose file too" }));
  await post("/exchange-end", projectBody());

  const brief = await readBrief(frond.briefPath);
  expect(brief.Goal).toBe("let's wire up the dockerfile first");
  expect(brief.Recent).toBe(
    ["- now the compose file too", "- let's wire up the dockerfile first"].join(
      "\n",
    ),
  );
});

test("a user's own edit to Goal is kept — the deterministic fill never clobbers it", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, {
    Goal: "my own hand-written goal",
  });

  await post(
    "/prompt",
    projectBody({ prompt: "let's wire up the dockerfile first" }),
  );
  expect((await readBrief(frond.briefPath)).Goal).toBe(
    "my own hand-written goal",
  );
});

test("the deterministic fill works on the stem exactly as on a real frond — most users never run /fern new at all", async () => {
  await post("/prompt", projectBody({ prompt: "just a plain prompt" }));
  await post("/prompt", projectBody({ prompt: "editing the readme" }));
  await post(
    "/tools",
    projectBody({
      filesTouched: [{ path: "README.md", source: "tool_input" }],
    }),
  );
  await post("/exchange-end", projectBody());

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const stem = (await state.store.listFronds(state.sessionId)).find(
    (f) => f.parentId === null,
  );
  if (!stem) throw new Error("stem not found");
  const brief = await readBrief(stem.briefPath);
  expect(brief.Goal).toBe("just a plain prompt");
  expect(brief.Files).toContain("README.md");
  expect(brief.Recent).toContain("- editing the readme");
});

test("/fern new <name> rejects a path-traversal name and never creates anything on disk for it", async () => {
  const res = await post(
    "/prompt",
    projectBody({ prompt: "/fern new ../../../../etc/passwd" }),
  );
  expect(res.status).toBe(400);
  expect(res.json.error).toContain("valid frond name");

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  expect(existsSync(join(projectDir?.path ?? "", ".fern", "etc"))).toBe(false);
});

test("/fern new <name> rejects a shell-metacharacter name", async () => {
  const res = await post(
    "/prompt",
    projectBody({ prompt: "/fern new x; rm -rf ." }),
  );
  expect(res.status).toBe(400);
  expect(res.json.error).toContain("valid frond name");
});

test("/undo after a manual /fern new removes the frond", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const undo = await post("/undo", projectBody());
  expect(undo.status).toBe(200);

  const tree = await get(
    `/tree?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  const fronds = tree.json.fronds as { name: string }[];
  expect(fronds.map((f) => f.name)).not.toContain("docker-build");
});

test("/merge joins a frond's Decided section into the stem", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const merge = await post(
    "/merge",
    projectBody({ frondName: "docker-build" }),
  );
  expect(merge.status).toBe(200);
  expect(merge.json.receipt).toContain("merged docker-build");
});

test("/status returns the statusline receipt", async () => {
  const res = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(200);
  expect(res.json.receipt).toStartWith("fern ▸ ");
});

test("/status's statusReceipt includes the leaflet count and mode, so dogfooding can tell whether exchanges are recorded", async () => {
  await post("/prompt", projectBody({ prompt: "fix the login bug" }));
  await post("/exchange-end", projectBody());

  const res = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(200);
  expect(res.json.leafletCount).toBe(1);
  expect(res.json.statusReceipt).toBe(
    "fern ▸ stem · 0 fronds · 0 strays · 1 leaflet · suggest",
  );
});

test("GET /tree without a projectPath is a 400, not a 500", async () => {
  const res = await get("/tree");
  expect(res.status).toBe(400);
});

test("an unknown route is a 404", async () => {
  const res = await get("/nonsense");
  expect(res.status).toBe(404);
});

test("/prompt's focusNote names the active frond and its brief's first Goal line", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));

  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, { Goal: "Get CI green again." });

  const res = await post("/prompt", projectBody({ prompt: "add a retry" }));
  expect(res.json.focusNote).toBe(
    "Active frond: docker-build · Get CI green again. · brief: .fern/fronds/docker-build.md",
  );
});

test("/prompt's focusNote always includes the brief's path, even with an empty Goal", async () => {
  const res = await post("/prompt", projectBody({ prompt: "hello there" }));
  expect(res.json.focusNote).toBe(
    "Active frond: stem · brief: .fern/fronds/stem.md",
  );
});

test("observe mode suppresses /prompt's focusNote and /status's brief entirely", async () => {
  await post("/mode", projectBody({ mode: "observe" }));

  const prompt = await post("/prompt", projectBody({ prompt: "hello there" }));
  expect(prompt.json.focusNote).toBeUndefined();

  const status = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(status.json.brief).toBeUndefined();
});

test("/status includes the active frond's brief content outside observe mode", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, { Goal: "Get CI green again." });

  const res = await get(
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.json.brief).toContain("## Goal");
  expect(res.json.brief).toContain("Get CI green again.");
});

test("GET /fronds returns the same frond data /tree renders as ASCII", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const res = await get(
    `/fronds?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(200);
  const fronds = res.json.fronds as { name: string }[];
  expect(fronds.map((f) => f.name)).toContain("docker-build");
});

test("GET /frond/:name/brief returns the named frond's brief sections", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, {
    Goal: "Get CI green again.",
    Open: "Flaky runner on windows-latest.",
  });

  const res = await get(
    `/frond/docker-build/brief?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(200);
  expect(res.json.goal).toBe("Get CI green again.");
  expect(res.json.open).toBe("Flaky runner on windows-latest.");
});

test("GET /frond/:name/brief is a 400, not a 500, for an unknown frond name", async () => {
  const res = await get(
    `/frond/no-such-frond/brief?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(400);
});

test("GET /search finds a case-insensitive substring match in a frond's brief", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  const state = await getOrOpenProject(projectDir?.path ?? "");
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  await writeBriefSections(frond.briefPath, {
    Open: "Flaky runner on windows-latest.",
  });

  const res = await get(
    `/search?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&q=WINDOWS-latest`,
  );
  expect(res.status).toBe(200);
  const results = res.json.results as {
    name: string;
    section: string;
    snippet: string;
  }[];
  expect(results).toEqual([
    { name: "docker-build", section: "Open", snippet: expect.any(String) },
  ]);
});

test("GET /frond/:name/brief is a 400 in observe mode — the model must not pull brief content through the MCP tool when observe mode says no change to model input", async () => {
  await post("/prompt", projectBody({ prompt: "/fern new docker-build" }));
  await post("/mode", projectBody({ mode: "observe" }));

  const res = await get(
    `/frond/docker-build/brief?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
  );
  expect(res.status).toBe(400);
});

test("GET /search is a 400 in observe mode, for the same reason", async () => {
  await post("/mode", projectBody({ mode: "observe" }));

  const res = await get(
    `/search?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&q=anything`,
  );
  expect(res.status).toBe(400);
});

test("GET /search with an empty query returns no results, not every brief", async () => {
  const res = await get(
    `/search?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&q=`,
  );
  expect(res.status).toBe(200);
  expect(res.json.results).toEqual([]);
});
