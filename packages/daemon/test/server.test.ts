import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedder } from "@context-fern/embed";
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
  expect(accepted.json.receipt).toContain("fix-flaky-login");
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

test("GET /tree without a projectPath is a 400, not a 500", async () => {
  const res = await get("/tree");
  expect(res.status).toBe(400);
});

test("an unknown route is a 404", async () => {
  const res = await get("/nonsense");
  expect(res.status).toBe(404);
});
