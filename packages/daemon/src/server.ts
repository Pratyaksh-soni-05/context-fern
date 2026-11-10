// The daemon's HTTP surface. Bun.serve on 127.0.0.1 only, port 7420
// falling back to the next free one. Every request passes three checks,
// in order, before any route logic runs: exact Host match, Origin (if
// present) must be a local origin, and the x-fern-token header must
// match daemon.json's token — DNS-rebinding and drive-by protection.
// startDaemon() has zero import-time side effects; only calling it
// starts the server (serve-entrypoint.ts is the only place that does so
// automatically, guarded by `import.meta.main`).

import { basename } from "node:path";
import type { Embedder, Mode } from "@context-fern/core";
import { buildId } from "./build-id";
import {
  daemonInfoPath,
  deleteDaemonInfo,
  writeDaemonInfo,
} from "./daemon-info";
import { createWarmEmbedder } from "./embedder";
import {
  handleFrondBrief,
  handleFronds,
  handleHeatmap,
  handleLeaflets,
  handleMode,
  handleSearch,
  handleStats,
  handleStatus,
  handleTree,
} from "./handlers";
import {
  closeAllProjects,
  getOrOpenProject,
  type ProjectState,
  updateAgentSessionId,
  withProjectLock,
} from "./project-registry";
import {
  listRecentProjects,
  resolveProjectPath,
  touchRecentProject,
} from "./project-registry-file";
import {
  finalizeExchange,
  handleMerge,
  handlePrompt,
  handleTools,
  handleUndo,
} from "./prompt-handler";
import { DaemonError } from "./prompt-util";
import {
  SESSION_COOKIE_NAME,
  TOKEN_HEADER,
  timingSafeStringEquals,
} from "./protocol";
import { serveUiAsset } from "./ui-assets";
import { UiSessionStore } from "./ui-session";

const FIRST_PORT = 7420;
const MAX_PORT_ATTEMPTS = 20;

/** Re-exported for existing callers; defined in protocol.ts so the lightweight client (client.ts) never needs to import this file. */
export { TOKEN_HEADER };

export interface StartDaemonOptions {
  /** Overrides the warm embedder — tests inject a FakeEmbedder. */
  embedder?: Embedder;
  firstPort?: number;
}

export interface DaemonHandle {
  port: number;
  token: string;
  stop(): Promise<void>;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function isLocalHost(hostHeader: string | null, port: number): boolean {
  const host = hostHeader?.toLowerCase() ?? null; // Host is case-insensitive per HTTP semantics
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  // Constant-time: this token gates every route on the one real auth
  // boundary this daemon has. Low practical risk on loopback with a
  // fresh random token per boot, but cheap to do properly. Shared with
  // ui-session.ts's isValidSession, which applies the same discipline
  // to the session cookie — see protocol.ts's timingSafeStringEquals.
  return timingSafeStringEquals(provided, expected);
}

function isLocalOrigin(originHeader: string | null): boolean {
  if (originHeader === null) return true; // most non-browser callers send no Origin at all
  return (
    originHeader === "http://localhost" ||
    originHeader === "http://127.0.0.1" ||
    /^http:\/\/localhost:\d+$/.test(originHeader) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(originHeader)
  );
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * A cookie set for 127.0.0.1 is sent by the browser to every port on
 * 127.0.0.1 — SameSite=Strict doesn't help, since another local process
 * on a different port still counts as "the same site." So a cookie-
 * authenticated (never a token-header-authenticated — CLI/hook callers
 * legitimately send no Origin at all) non-GET request must carry an
 * Origin that exactly matches this daemon's own origin.
 *
 * GET stays exempt: confirmed (via a real Chromium run, not just
 * reasoning about the spec) that the browser does NOT reliably attach
 * an Origin header to a same-origin GET fetch() the way it does for
 * POST — requiring one here 403'd the UI's own ordinary reads and
 * broke every screen. GET /status?restored=true is the one GET with a
 * real side effect; it's guarded separately, below, by refusing to
 * honor `restored=true` for cookie-authenticated callers at all,
 * rather than by an Origin check this method can't reliably carry.
 * See docs/decisions.md.
 */
function isExactDaemonOrigin(
  originHeader: string | null,
  port: number,
): boolean {
  return (
    originHeader === `http://127.0.0.1:${port}` ||
    originHeader === `http://localhost:${port}`
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const embedder = options.embedder ?? (await createWarmEmbedder());
  const token = randomToken();
  const uiSessions = new UiSessionStore();

  let port = options.firstPort ?? FIRST_PORT;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let attempts = 0;

  while (!server) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => handleRequest(req, embedder, port, token, uiSessions),
      });
    } catch (err) {
      attempts++;
      if (attempts >= MAX_PORT_ATTEMPTS) throw err;
      port++;
    }
  }
  // Read back the actually-bound port (matters when `firstPort: 0` asks
  // the OS to assign one, e.g. in tests) — `handleRequest`'s closure
  // reads the same `port` variable, so this takes effect immediately.
  port = server.port ?? port;

  await writeDaemonInfo({
    port,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    buildId: buildId(),
  });

  return {
    port,
    token,
    stop: async () => {
      server?.stop(true);
      await closeAllProjects();
      await deleteDaemonInfo();
    },
  };
}

async function handleRequest(
  req: Request,
  embedder: Embedder,
  port: number,
  token: string,
  uiSessions: UiSessionStore,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (!isLocalHost(req.headers.get("host"), port)) {
    return jsonResponse({ ok: false, error: "forbidden host" }, 403);
  }
  if (!isLocalOrigin(req.headers.get("origin"))) {
    return jsonResponse({ ok: false, error: "forbidden origin" }, 403);
  }

  // Static UI assets carry no project data — no credential required.
  // Still gated on the Host/Origin checks above.
  if (
    req.method === "GET" &&
    (pathname === "/ui" || pathname.startsWith("/ui/"))
  ) {
    return serveUiAsset(pathname);
  }

  const hasValidToken = tokenMatches(req.headers.get(TOKEN_HEADER), token);

  // POST /ui-code: token-header only, never cookie-eligible — this is
  // what mints the browser's very first (short-lived) credential, so it
  // can't itself be authenticated by a cookie that doesn't exist yet.
  if (req.method === "POST" && pathname === "/ui-code") {
    if (!hasValidToken)
      return jsonResponse({ ok: false, error: "forbidden" }, 403);
    return jsonResponse({ ok: true, code: uiSessions.mintCode() });
  }

  // POST /session: authenticated by the one-time code in the body
  // (minted by /ui-code above), not by a token header or cookie — a
  // cookie is what this mints.
  if (req.method === "POST" && pathname === "/session") {
    const body = await readJsonBody(req);
    const code = typeof body.code === "string" ? body.code : "";
    const result = code ? uiSessions.redeemCode(code) : "unknown";
    if (result === "expired") {
      return jsonResponse(
        {
          ok: false,
          error: "That link expired. Run `fern ui` again.",
        },
        403,
      );
    }
    if (result === "unknown") {
      return jsonResponse(
        {
          ok: false,
          error: "That link was already used. Run `fern ui` again.",
        },
        403,
      );
    }
    const sessionToken = uiSessions.mintSession();
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      },
    });
  }

  const cookieToken = readCookie(
    req.headers.get("cookie"),
    SESSION_COOKIE_NAME,
  );
  const hasValidCookie =
    cookieToken !== null && uiSessions.isValidSession(cookieToken);

  if (!hasValidToken && !hasValidCookie) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }

  if (!hasValidToken && hasValidCookie && req.method !== "GET") {
    if (!isExactDaemonOrigin(req.headers.get("origin"), port)) {
      return jsonResponse({ ok: false, error: "forbidden origin" }, 403);
    }
  }

  // GET /status?restored=true is meant only for SessionStart's own
  // token-authenticated restore call — a cookie-authenticated (browser)
  // caller has no legitimate reason to ever set it, and honoring it
  // would let a blind cross-port GET set pendingRestoreReceipt without
  // needing to read the response (see the comment on isExactDaemonOrigin).
  if (
    !hasValidToken &&
    pathname === "/status" &&
    url.searchParams.get("restored") === "true"
  ) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }

  // Same reasoning, a gap an adversarial security review found: GET
  // /status's own agentSessionId param updates ProjectState's
  // lastAgentSessionId unconditionally — a cookie-authenticated caller
  // (the browser UI never sends this param at all; see api/client.ts's
  // getStatus) has no legitimate reason to set it either, and since GET
  // is Origin-exempt by design, a same-machine, different-local-port
  // actor could otherwise ride the cookie to inject a bogus value and
  // make the real CLI's next /prompt wrongly believe a resume/clear/
  // compaction/fork happened, surfacing a false "restored" receipt.
  // Low-stakes (cosmetic, no data read or write), but the same pattern
  // as restored=true, so closed the same way. See docs/decisions.md.
  if (
    !hasValidToken &&
    pathname === "/status" &&
    url.searchParams.has("agentSessionId")
  ) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }

  try {
    return await route(req, url, embedder);
  } catch (err) {
    if (err instanceof DaemonError) {
      return jsonResponse({ ok: false, error: err.message }, 400);
    }
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

async function projectFromQuery(url: URL): Promise<ProjectState> {
  const projectPath = url.searchParams.get("projectPath");
  if (!projectPath) throw new DaemonError("projectPath is required");
  return getOrOpenProject(projectPath);
}

async function projectFromBody(
  body: Record<string, unknown>,
): Promise<ProjectState> {
  const projectPath = body.projectPath;
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new DaemonError("projectPath is required");
  }
  return getOrOpenProject(projectPath);
}

async function route(
  req: Request,
  url: URL,
  embedder: Embedder,
): Promise<Response> {
  const { pathname } = url;

  if (req.method === "POST" && pathname === "/prompt") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    // handlePrompt itself compares this against the project's current
    // lastAgentSessionId (and updates it) — the comparison has to
    // happen there, before it's overwritten, to detect "first prompt
    // after a resume/clear/compaction/fork" and attach a restored
    // receipt. See docs/decisions.md.
    const agentSessionId =
      typeof body.agentSessionId === "string" ? body.agentSessionId : undefined;
    const result = await withProjectLock(state, (s) =>
      handlePrompt(s, embedder, prompt, agentSessionId),
    );
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "POST" && pathname === "/tools") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    const filesTouched = Array.isArray(body.filesTouched)
      ? body.filesTouched
      : [];
    await withProjectLock(state, async (s) => {
      handleTools(s, filesTouched as never);
    });
    return jsonResponse({ ok: true });
  }

  if (req.method === "POST" && pathname === "/exchange-end") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    await withProjectLock(state, (s) => finalizeExchange(s));
    return jsonResponse({ ok: true });
  }

  if (req.method === "POST" && pathname === "/undo") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    const result = await withProjectLock(state, (s) => handleUndo(s));
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "POST" && pathname === "/merge") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    const frondName = typeof body.frondName === "string" ? body.frondName : "";
    const result = await withProjectLock(state, (s) =>
      handleMerge(s, frondName),
    );
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "POST" && pathname === "/mode") {
    const body = await readJsonBody(req);
    const state = await projectFromBody(body);
    const mode = body.mode as Mode;
    await withProjectLock(state, (s) => handleMode(s, mode));
    return jsonResponse({ ok: true });
  }

  if (req.method === "GET" && pathname === "/tree") {
    const state = await projectFromQuery(url);
    const result = await withProjectLock(state, (s) => handleTree(s));
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "GET" && pathname === "/status") {
    const state = await projectFromQuery(url);
    updateAgentSessionId(state, url.searchParams.get("agentSessionId"));
    const markRestored = url.searchParams.get("restored") === "true";
    const result = await withProjectLock(state, (s) =>
      handleStatus(s, markRestored),
    );
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "GET" && pathname === "/fronds") {
    const state = await projectFromQuery(url);
    const result = await withProjectLock(state, (s) => handleFronds(s));
    return jsonResponse({ ok: true, ...result });
  }

  const briefMatch = /^\/frond\/([^/]+)\/brief$/.exec(pathname);
  if (req.method === "GET" && briefMatch) {
    const state = await projectFromQuery(url);
    const frondName = decodeURIComponent(briefMatch[1] ?? "");
    const result = await withProjectLock(state, (s) =>
      handleFrondBrief(s, frondName),
    );
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "GET" && pathname === "/search") {
    const state = await projectFromQuery(url);
    const query = url.searchParams.get("q") ?? "";
    const result = await withProjectLock(state, (s) => handleSearch(s, query));
    return jsonResponse({ ok: true, ...result });
  }

  // --- fern ui's data API -----------------------------------------------

  if (req.method === "GET" && pathname === "/projects") {
    const projects = await listRecentProjects();
    return jsonResponse({ ok: true, projects });
  }

  if (req.method === "POST" && pathname === "/projects/open") {
    const body = await readJsonBody(req);
    const rawPath = typeof body.path === "string" ? body.path : "";
    const resolved = rawPath ? await resolveProjectPath(rawPath) : null;
    if (!resolved) {
      return jsonResponse(
        {
          ok: false,
          error: "no .fern/fern.db at that path — run `fern init` there first",
        },
        404,
      );
    }
    const state = await getOrOpenProject(resolved);
    const sessionCount = await withProjectLock(state, (s) =>
      s.store.countSessionsForProjectPath(resolved),
    );
    const name = basename(resolved);
    await touchRecentProject(resolved, name, sessionCount);
    return jsonResponse({ ok: true, path: resolved, name });
  }

  if (req.method === "GET" && pathname === "/leaflets") {
    const state = await projectFromQuery(url);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(
      500,
      Math.max(1, Number(url.searchParams.get("limit")) || 100),
    );
    const result = await withProjectLock(state, (s) =>
      handleLeaflets(s, { offset, limit }),
    );
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "GET" && pathname === "/stats") {
    const state = await projectFromQuery(url);
    const result = await withProjectLock(state, (s) => handleStats(s));
    return jsonResponse({ ok: true, ...result });
  }

  if (req.method === "GET" && pathname === "/heatmap") {
    const state = await projectFromQuery(url);
    const result = await withProjectLock(state, (s) => handleHeatmap(s));
    return jsonResponse({ ok: true, ...result });
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

export { daemonInfoPath };
