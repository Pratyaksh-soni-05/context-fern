// The daemon's HTTP surface. Bun.serve on 127.0.0.1 only, port 7420
// falling back to the next free one. Every request passes three checks,
// in order, before any route logic runs: exact Host match, Origin (if
// present) must be a local origin, and the x-fern-token header must
// match daemon.json's token — DNS-rebinding and drive-by protection.
// startDaemon() has zero import-time side effects; only calling it
// starts the server (serve-entrypoint.ts is the only place that does so
// automatically, guarded by `import.meta.main`).

import { timingSafeEqual } from "node:crypto";
import type { Embedder, Mode } from "@context-fern/core";
import {
  daemonInfoPath,
  deleteDaemonInfo,
  writeDaemonInfo,
} from "./daemon-info";
import { createWarmEmbedder } from "./embedder";
import {
  handleFrondBrief,
  handleFronds,
  handleMode,
  handleSearch,
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
  finalizeExchange,
  handleMerge,
  handlePrompt,
  handleTools,
  handleUndo,
} from "./prompt-handler";
import { DaemonError } from "./prompt-util";
import { TOKEN_HEADER } from "./protocol";

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
  if (provided === null || provided.length !== expected.length) return false;
  // Constant-time: this token gates every route on the one real auth
  // boundary this daemon has. Low practical risk on loopback with a
  // fresh random token per boot, but cheap to do properly.
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
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

  let port = options.firstPort ?? FIRST_PORT;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let attempts = 0;

  while (!server) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => handleRequest(req, embedder, port, token),
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
): Promise<Response> {
  const url = new URL(req.url);

  if (!isLocalHost(req.headers.get("host"), port)) {
    return jsonResponse({ ok: false, error: "forbidden host" }, 403);
  }
  if (!isLocalOrigin(req.headers.get("origin"))) {
    return jsonResponse({ ok: false, error: "forbidden origin" }, 403);
  }
  if (!tokenMatches(req.headers.get(TOKEN_HEADER), token)) {
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
    updateAgentSessionId(
      state,
      typeof body.agentSessionId === "string" ? body.agentSessionId : undefined,
    );
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const result = await withProjectLock(state, (s) =>
      handlePrompt(s, embedder, prompt),
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
    const result = await withProjectLock(state, (s) => handleStatus(s));
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

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

export { daemonInfoPath };
