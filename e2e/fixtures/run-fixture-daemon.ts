// A plain Bun script, spawned as a subprocess by playwright.config.ts's
// webServer.command — NOT imported by any Playwright spec/config file
// directly. Playwright's own spec/config loader is Node-based and
// can't resolve `bun:sqlite` (confirmed: it throws
// "Only URLs with a scheme in: file, data, and node are supported" on
// any file that transitively imports @context-fern/store), so every
// package that touches the real daemon/store has to run in its own,
// genuinely-Bun-executed process — this file is that process. It never
// touches the real home directory (a fresh temp FERN_HOME every run).
//
// The one-time `/ui-code` is consumed on first use, so a single code
// written once to disk only serves the first spec file that navigates
// to it — every other spec would hit a dead code and never get past
// the Start screen. This runs a tiny second HTTP server (E2E_HELPER_PORT,
// fixture-only, unauthenticated by design — this whole process already
// holds the real daemon token, and binds to 127.0.0.1 only) that mints
// a fresh code and URL on every request, so each spec file can ask for
// its own right before navigating.

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  closeAllProjects,
  startDaemon,
  TOKEN_HEADER,
  touchRecentProject,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";
import { seedDemoProject } from "../../scripts/demo-seed";
import { E2E_DAEMON_PORT, E2E_HELPER_PORT } from "./constants";
import { seedFixtureProject } from "./seed";

async function main(): Promise<void> {
  const fakeHome = await mkdtemp(join(tmpdir(), "fern-e2e-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();

  const base = join(tmpdir(), `fern e2e fixture ${Date.now()}`);
  await mkdir(base, { recursive: true });
  // Resolved up front, before anything else uses it — POST /projects/open
  // resolves the path via realpath() too (Windows can normalize a fresh
  // mkdtemp() path to its short 8.3 form), and seeding under the
  // unresolved path would leave the daemon unable to find this session
  // once the browser opens the project through that real endpoint.
  const projectPath = await realpath(await mkdtemp(join(base, "run-")));

  const { store } = await seedFixtureProject(projectPath);
  const sessionCount = await store.countSessionsForProjectPath(projectPath);
  store.close();
  await closeAllProjects();
  // POST /projects/open (every spec's own "open shop-api" click) sets
  // the registry's display name to basename(path) too, the same as
  // `fern init`/`fern ui` do — real, consistent product behaviour, not
  // a bug. Seeding under any OTHER name here just meant the first spec
  // to open the project would silently rename it out from under every
  // later spec, which still shares this one fixture project. Matching
  // it from the start avoids that entirely. See docs/decisions.md.
  const projectName = basename(projectPath);
  await touchRecentProject(projectPath, projectName, sessionCount);

  // A second, separately-seeded project for demo-data.spec.ts — the
  // same real daemon can serve any number of distinct projects, so
  // this doesn't need its own webServer/port. Not registered via
  // touchRecentProject: demo-data.spec.ts opens it through the Start
  // screen's folder-path form instead, so it can't be confused with
  // (or shift the ordering of) the main fixture project above.
  const demoBase = join(tmpdir(), `fern e2e demo ${Date.now()}`);
  await mkdir(demoBase, { recursive: true });
  const demoProjectPath = await realpath(await mkdtemp(join(demoBase, "run-")));
  const { store: demoStore } = await seedDemoProject(demoProjectPath);
  demoStore.close();
  await closeAllProjects();

  const daemon = await startDaemon({
    embedder: new FakeEmbedder(),
    firstPort: E2E_DAEMON_PORT,
  });

  async function mintUrl(): Promise<string> {
    // A plain, no-timeout fetch() can hang indefinitely rather than
    // reject on a flaky connection — confirmed: this self-call (the
    // helper, in the same process, calling the daemon's own /ui-code)
    // occasionally did exactly that, and since it's the one call every
    // spec file's navigation depends on, a hang here silently ate the
    // caller's entire retry budget instead of ever actually retrying.
    const codeRes = await fetch(`http://127.0.0.1:${daemon.port}/ui-code`, {
      method: "POST",
      headers: {
        [TOKEN_HEADER]: daemon.token,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    const { code } = (await codeRes.json()) as { code: string };
    return `http://127.0.0.1:${daemon.port}/ui#code=${code}`;
  }

  const helper = Bun.serve({
    hostname: "127.0.0.1",
    port: E2E_HELPER_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/mint-code") {
        try {
          return Response.json({
            url: await mintUrl(),
            projectPath,
            projectName,
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 503 },
          );
        }
      }
      if (url.pathname === "/demo-project") {
        return Response.json({ path: demoProjectPath });
      }
      return new Response("not found", { status: 404 });
    },
  });

  process.on("SIGTERM", async () => {
    helper.stop(true);
    await daemon.stop();
    await rm(fakeHome, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
    await rm(demoProjectPath, { recursive: true, force: true });
    process.exit(0);
  });

  console.log(
    `fixture daemon ready on 127.0.0.1:${daemon.port}, helper on 127.0.0.1:${E2E_HELPER_PORT}`,
  );
}

void main();
