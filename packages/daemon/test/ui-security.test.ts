// fern ui's browser-facing surface: the one-time code -> session cookie
// handoff (POST /ui-code, POST /session), the CSRF Origin rule for
// cookie-authenticated writes, the new read endpoints' auth gate, and
// the recent-projects flow (GET /projects, POST /projects/open). See
// docs/decisions.md.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDecision, buildDecisionInverse } from "@context-fern/core";
import { FakeEmbedder } from "@context-fern/embed";
import { buildId } from "../src/build-id";
import { closeAllProjects, getOrOpenProject } from "../src/project-registry";
import { type DaemonHandle, startDaemon, TOKEN_HEADER } from "../src/server";
import { type TempDir, withTempProjectDir } from "./test-helpers";

/** Creates a real, undoable decision (a "new" frond) directly via the store API, so /undo's CSRF tests exercise a real request that would otherwise fully succeed — not just an empty-state 400 that would pass for the wrong reason. */
async function seedUndoableDecision(projectPath: string): Promise<void> {
  const state = await getOrOpenProject(projectPath);
  const before = state.routerState;
  const frond = await state.store.createFrond({
    sessionId: state.sessionId,
    parentId: state.stemFrondId,
    name: "auth-refactor",
    colorIndex: 1,
  });
  const leaflet = await state.store.recordLeaflet({
    sessionId: state.sessionId,
    index: 0,
    frondId: frond.id,
    strayFrom: null,
    promptHash: "sha256:fixture",
    tokenCount: 5,
    filesTouched: [],
  });
  const decision = buildDecision({
    id: "csrf-test-decision",
    createdAt: new Date().toISOString(),
    sessionId: state.sessionId,
    leafletId: leaflet.id,
    action: "new",
    target: null,
    stage: "manual",
    signals: ["manual"],
    confidence: 1,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inverse: buildDecisionInverse(before, "new", frond.id),
  });
  await state.store.recordDecision(decision, null);
}

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

async function rawFetch(
  method: string,
  path: string,
  opts: {
    body?: Record<string, unknown>;
    token?: string | undefined;
    cookie?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["content-type"] = "application/json";
  if (opts.token) headers[TOKEN_HEADER] = opts.token;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== undefined && opts.origin !== null) {
    headers.origin = opts.origin;
  }
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header on response");
  const match = /^([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`couldn't parse set-cookie: ${setCookie}`);
  return match[1] ?? "";
}

async function mintSessionCookie(): Promise<string> {
  const codeRes = await rawFetch("POST", "/ui-code", {
    body: {},
    token: daemon?.token,
  });
  const { code } = (await codeRes.json()) as { code: string };
  const sessionRes = await rawFetch("POST", "/session", { body: { code } });
  expect(sessionRes.status).toBe(204);
  return cookieFrom(sessionRes);
}

test("POST /ui-code requires the real daemon token, never a cookie", async () => {
  const noAuth = await rawFetch("POST", "/ui-code", { body: {} });
  expect(noAuth.status).toBe(403);

  const withToken = await rawFetch("POST", "/ui-code", {
    body: {},
    token: daemon?.token,
  });
  expect(withToken.status).toBe(200);
  const { code } = (await withToken.json()) as { code: string };
  expect(typeof code).toBe("string");
  expect(code.length).toBeGreaterThan(0);
});

test("POST /session exchanges a valid one-time code for a session cookie, which alone then authenticates a GET request", async () => {
  const cookie = await mintSessionCookie();

  const statusWithoutAuth = await rawFetch("GET", "/status", {});
  expect(statusWithoutAuth.status).toBe(403);

  const statusWithCookie = await rawFetch("GET", "/status", {
    cookie,
  });
  // No projectPath on this call — it should get past auth and fail with
  // a 400 (DaemonError) for the missing projectPath, not a 403. Getting
  // past the auth gate at all is what this test is checking.
  expect(statusWithCookie.status).toBe(400);
});

test("POST /session rejects a reused code — consumed on first lookup regardless of outcome — with a plain 'already used' message, not a bare 'forbidden'", async () => {
  const codeRes = await rawFetch("POST", "/ui-code", {
    body: {},
    token: daemon?.token,
  });
  const { code } = (await codeRes.json()) as { code: string };

  const first = await rawFetch("POST", "/session", { body: { code } });
  expect(first.status).toBe(204);

  const second = await rawFetch("POST", "/session", { body: { code } });
  expect(second.status).toBe(403);
  const json = (await second.json()) as { error: string };
  expect(json.error).toBe("That link was already used. Run `fern ui` again.");
});

test("POST /session rejects a wrong/made-up code with the same 'already used' message — a single-use code can't distinguish reused from fabricated, by design", async () => {
  const res = await rawFetch("POST", "/session", {
    body: { code: "not-a-real-code" },
  });
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: string };
  expect(json.error).toBe("That link was already used. Run `fern ui` again.");
});

test("a cookie-authenticated non-GET request without an Origin header is rejected, unlike the token-header path", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch("POST", "/mode", {
    body: { projectPath: projectDir?.path, mode: "suggest" },
    cookie,
    // no origin at all
  });
  expect(res.status).toBe(403);
});

test("a cookie-authenticated non-GET request from a different local port's Origin is rejected (cookies aren't port-scoped)", async () => {
  const cookie = await mintSessionCookie();
  const otherPort = (daemon?.port ?? 0) + 1;
  const res = await rawFetch("POST", "/mode", {
    body: { projectPath: projectDir?.path, mode: "suggest" },
    cookie,
    origin: `http://127.0.0.1:${otherPort}`,
  });
  expect(res.status).toBe(403);
});

test("a cookie-authenticated non-GET request with this daemon's own Origin succeeds", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch("POST", "/mode", {
    body: { projectPath: projectDir?.path, mode: "suggest" },
    cookie,
    origin: `http://127.0.0.1:${daemon?.port}`,
  });
  expect(res.status).toBe(200);
});

// A real Chromium run confirmed GET fetch() doesn't reliably carry an
// Origin header even same-origin, so GET stays exempt from the Origin
// rule above (unlike every write) — an ordinary cookie-authenticated
// GET with no Origin at all must still succeed.
test("an ordinary cookie-authenticated GET request succeeds with no Origin header at all", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch("GET", "/status", {
    cookie,
    // no origin at all — this is what a real same-origin fetch() sends
  });
  expect(res.status).toBe(400); // past auth; 400 for the missing projectPath
});

// GET /status?restored=true is the one GET with a real side effect
// (ProjectState.pendingRestoreReceipt) — it's meant only for
// SessionStart's own token-authenticated restore call, so a cookie
// can never trigger it, Origin header or not.
test("a cookie-authenticated GET /status?restored=true is rejected outright, Origin or not", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&restored=true`,
    { cookie, origin: `http://127.0.0.1:${daemon?.port}` },
  );
  expect(res.status).toBe(403);
});

test("the real daemon token can still set restored=true on /status", async () => {
  const res = await rawFetch(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&restored=true`,
    { token: daemon?.token },
  );
  expect(res.status).toBe(200);
});

// Found by an adversarial security review: GET is Origin-exempt by
// design, so a cookie-authenticated, different-local-port caller could
// otherwise ride the session cookie to set agentSessionId to an
// arbitrary value with no Origin check at all — the real UI never
// sends this param (see api/client.ts's getStatus), so there's no
// legitimate cookie-authenticated use to preserve. Same closure
// pattern as restored=true, just for this param instead.
test("a cookie-authenticated GET /status?agentSessionId=... is rejected outright, Origin or not", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&agentSessionId=mallory-injected`,
    { cookie, origin: `http://127.0.0.1:${daemon?.port}` },
  );
  expect(res.status).toBe(403);
});

test("the real daemon token can still set agentSessionId on /status", async () => {
  const res = await rawFetch(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}&agentSessionId=real-session-1`,
    { token: daemon?.token },
  );
  expect(res.status).toBe(200);
});

test("an ordinary cookie-authenticated GET /status with neither restored nor agentSessionId still succeeds", async () => {
  const cookie = await mintSessionCookie();
  const res = await rawFetch(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
    { cookie },
  );
  expect(res.status).toBe(200);
});

test("POST /undo from a different local port's Origin is rejected even with a valid cookie (cookies aren't port-scoped)", async () => {
  await seedUndoableDecision(projectDir?.path ?? "");
  const cookie = await mintSessionCookie();
  const otherPort = (daemon?.port ?? 0) + 1;
  const res = await rawFetch("POST", "/undo", {
    body: { projectPath: projectDir?.path },
    cookie,
    origin: `http://127.0.0.1:${otherPort}`,
  });
  expect(res.status).toBe(403);
});

test("POST /undo with this daemon's own Origin succeeds end to end via a cookie", async () => {
  await seedUndoableDecision(projectDir?.path ?? "");
  const cookie = await mintSessionCookie();
  const res = await rawFetch("POST", "/undo", {
    body: { projectPath: projectDir?.path },
    cookie,
    origin: `http://127.0.0.1:${daemon?.port}`,
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { receipt: string };
  expect(json.receipt.length).toBeGreaterThan(0);
});

test("the new UI data endpoints reject a request with neither a cookie nor a token", async () => {
  for (const path of [
    `/leaflets?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
    `/stats?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
    `/heatmap?projectPath=${encodeURIComponent(projectDir?.path ?? "")}`,
    "/projects",
  ]) {
    const res = await rawFetch("GET", path, {});
    expect(res.status).toBe(403);
  }
});

test("GET /projects starts empty and reflects a project touched via POST /projects/open", async () => {
  const empty = await rawFetch("GET", "/projects", { token: daemon?.token });
  expect(await empty.json()).toEqual({
    ok: true,
    projects: [],
    pid: process.pid,
    buildId: buildId(),
  });

  // Materialize .fern/fern.db for this project path first — a fresh
  // temp dir has no fern.db until something opens it.
  await getOrOpenProject(projectDir?.path ?? "");

  const opened = await rawFetch("POST", "/projects/open", {
    body: { path: projectDir?.path },
    token: daemon?.token,
  });
  expect(opened.status).toBe(200);

  const after = await rawFetch("GET", "/projects", { token: daemon?.token });
  const { projects } = (await after.json()) as {
    projects: { path: string; sessionCount: number }[];
  };
  expect(projects).toHaveLength(1);
  expect(projects[0]?.sessionCount).toBe(1);
});

test("POST /projects/open rejects a path with no .fern/fern.db, with the one-line fix", async () => {
  const res = await rawFetch("POST", "/projects/open", {
    body: { path: projectDir?.path }, // never opened — no fern.db yet
    token: daemon?.token,
  });
  expect(res.status).toBe(404);
  const json = (await res.json()) as { error: string };
  expect(json.error).toContain("fern init");
});

test("GET /ui is reachable with no credential at all", async () => {
  // Whatever packages/ui/dist actually contains in this checkout (the
  // real build, a stale stub, or nothing at all) is exercised in depth,
  // including the security headers, against a controlled temp dir in
  // ui-assets.test.ts — this just confirms the route is reachable with
  // zero auth (no token, no cookie passed above), i.e. never a 403.
  const res = await rawFetch("GET", "/ui", {});
  expect(res.status).not.toBe(403);
});
