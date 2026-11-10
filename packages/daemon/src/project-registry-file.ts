// ~/.fern/projects.json — the user-level "recent projects" list fern
// ui's Start screen reads. Lives alongside daemon.json (same OS-config-
// dir resolver pattern as daemon-info.ts — see that module's own doc
// comment for why every function here takes an optional `homeDir`
// override). Deliberately a different module/name from
// project-registry.ts's in-memory, per-process open-project cache —
// that's a different thing entirely that happens to share "project
// registry" in its name; don't conflate the two. See docs/decisions.md.
//
// Touched in exactly three places, never on every /status call (hooks
// fire that on every prompt, and that must never cause a disk write):
// `fern init`, `fern ui` (when run from inside an already-initialized
// project), and POST /projects/open (the Start screen's own "open a
// project" action, via resolveProjectPath below).

import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, ENV_PREFIX } from "@context-fern/core";
import { canonicalizeProjectPath, isSamePath } from "./client";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  /** A real count, cached from the touch that wrote this entry — not re-queried live on every /projects list, so it can go stale between touches but is never invented. See docs/decisions.md. */
  sessionCount: number;
}

interface ProjectsFile {
  projects: RecentProject[];
}

function fernHomeDir(): string {
  return process.env[`${ENV_PREFIX}HOME`] || homedir();
}

export function projectsFilePath(homeDir: string = fernHomeDir()): string {
  return join(homeDir, CONFIG_DIR, "projects.json");
}

async function readProjectsFile(homeDir: string): Promise<ProjectsFile> {
  try {
    const text = await readFile(projectsFilePath(homeDir), "utf-8");
    const parsed = JSON.parse(text) as Partial<ProjectsFile>;
    return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch {
    return { projects: [] };
  }
}

/** Write-temp-then-rename — a crash mid-write never leaves a half-written projects.json, since `rename` is atomic within one directory on every OS this ships for. */
async function writeProjectsFileAtomic(
  file: ProjectsFile,
  homeDir: string,
): Promise<void> {
  const dir = join(homeDir, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const finalPath = projectsFilePath(homeDir);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf-8");
  await rename(tmpPath, finalPath);
}

/** Every known project, most-recently-opened first. */
export async function listRecentProjects(
  homeDir: string = fernHomeDir(),
): Promise<RecentProject[]> {
  const file = await readProjectsFile(homeDir);
  return [...file.projects].sort((a, b) =>
    b.lastOpenedAt.localeCompare(a.lastOpenedAt),
  );
}

/**
 * Records (or refreshes) one project's entry — replaces any existing
 * entry for the same real project (canonicalized, not a raw string
 * match) rather than duplicating it. Without canonicalizing here, the
 * same project reached via a Windows short path one time and the long
 * path another would show up as two separate "recent projects" rows
 * for what's really one project. See docs/decisions.md.
 */
export async function touchRecentProject(
  path: string,
  name: string,
  sessionCount: number,
  homeDir: string = fernHomeDir(),
): Promise<void> {
  const canonicalPath = canonicalizeProjectPath(path);
  const file = await readProjectsFile(homeDir);
  const entry: RecentProject = {
    path: canonicalPath,
    name,
    lastOpenedAt: new Date().toISOString(),
    sessionCount,
  };
  const withoutThisPath = file.projects.filter(
    (p) => !isSamePath(canonicalizeProjectPath(p.path), canonicalPath),
  );
  await writeProjectsFileAtomic(
    { projects: [entry, ...withoutThisPath] },
    homeDir,
  );
}

/** Test-only: clears every entry. */
export async function clearRecentProjects(
  homeDir: string = fernHomeDir(),
): Promise<void> {
  await rm(projectsFilePath(homeDir), { force: true });
}

/**
 * Resolves a user-supplied path to a real project directory that
 * already has `.fern/fern.db` — symlinks followed, relative segments
 * collapsed, never creating anything. Returns null for anything else
 * (no such path, no `.fern/`, no `fern.db` yet — e.g. a project that's
 * been through `fern init` for its config but never opened by the
 * daemon). The Start screen's folder input and POST /projects/open both
 * use this as their only validation; the UI never triggers `fern init`.
 */
export async function resolveProjectPath(
  rawPath: string,
): Promise<string | null> {
  try {
    const real = canonicalizeProjectPath(rawPath);
    await access(join(real, CONFIG_DIR, "fern.db"));
    return real;
  } catch {
    return null;
  }
}
