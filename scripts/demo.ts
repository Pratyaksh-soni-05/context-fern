#!/usr/bin/env bun
// `bun run demo` — seeds a throwaway, synthetic project (3 fronds, 2
// strays, several returns, one combine, one merge, a couple of real
// undone decisions, real briefs — see demo-seed.ts) and opens the `ui`
// command against it, so a reviewer can see a populated UI without
// touching any real project. Everything lives under a fresh OS temp
// directory for this run only: FERN_HOME is redirected there before the
// daemon ever starts, so nothing here reads or writes the real
// ~/.fern. Ctrl+C stops it; nothing here persists afterward.

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@context-fern/core";
import {
  readDaemonInfo,
  startDaemon,
  touchRecentProject,
} from "@context-fern/daemon";
import { rawPostJson, spawnDetached } from "@context-fern/daemon/client";
import { FakeEmbedder } from "@context-fern/embed";
import { seedDemoProject } from "./demo-seed";

function openBrowserCmd(url: string): string[] {
  return process.platform === "win32"
    ? ["cmd", "/c", "start", "", url]
    : process.platform === "darwin"
      ? ["open", url]
      : ["xdg-open", url];
}

async function main(): Promise<void> {
  const runRoot = await mkdtemp(join(tmpdir(), "fern-demo-"));
  const fernHome = join(runRoot, "home");
  const projectDir = join(runRoot, "project");
  await mkdir(fernHome, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // Must be set before startDaemon() — daemon.json, projects.json, and
  // every other piece of daemon state this run touches all resolve
  // against FERN_HOME, never the real home directory.
  process.env.FERN_HOME = fernHome;

  const { store, sessionId } = await seedDemoProject(projectDir);
  const sessionCount = await store.countSessionsForProjectPath(projectDir);
  store.close();

  const daemon = await startDaemon({ embedder: new FakeEmbedder() });
  const info = await readDaemonInfo(fernHome);
  if (!info) throw new Error("daemon.json missing right after startDaemon()");

  await touchRecentProject(projectDir, basename(projectDir), sessionCount);

  const { code } = (await rawPostJson(info, "/ui-code", {})) as {
    code: string;
  };
  const url = `http://127.0.0.1:${daemon.port}/ui#code=${code}`;
  spawnDetached(openBrowserCmd(url));

  console.log(`${CLI_NAME} ▸ ${PRODUCT_NAME} demo running`);
  console.log(`${CLI_NAME} ▸ synthetic project: ${projectDir}`);
  console.log(`${CLI_NAME} ▸ session: ${sessionId}`);
  console.log(
    `${CLI_NAME} ▸ opening ${CLI_NAME} ui at http://127.0.0.1:${daemon.port}/ui`,
  );
  console.log(
    `${CLI_NAME} ▸ press Ctrl+C to stop — ${runRoot} is deleted by the OS's own temp-dir cleanup, not by this script`,
  );
}

void main();
