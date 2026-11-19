// Copies the running executable and its native sidecar into the per-user
// install layout. Needed because the copy `npx`/`uvx` runs lives in a
// cache that gets purged, and hooks call a bare `context-fern` through
// PATH, which on Windows must be a real .exe (not npm's .cmd shim,
// docs/decisions.md 2026-11-10).
//
// Safety rules, all enforced here and by test/install/deletion-safety.test.ts:
//  - A file already at a target is replaced only if the previous manifest
//    lists it AND it still has the recorded hash, or it is byte-identical
//    to what is being installed. Anything else is left alone and init
//    stops with a message naming it.
//  - Nothing is ever deleted except through safe-remove.ts (hash-checked,
//    one file at a time, no recursion).
//  - Replacement never overwrites in place: the new file is written under
//    an exclusive temporary name and renamed over the old one, and an
//    existing target is first moved aside, because Windows lets a running
//    program be renamed but not overwritten or deleted. A moved-aside file
//    that cannot be deleted yet goes on the manifest's pending list.

import { randomBytes } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME } from "@context-fern/core";
import { mkdirTracked } from "./dirs";
import { sha256File } from "./hash";
import { executableNames, type InstallLayout } from "./layout";
import type { ManifestFile, PendingDelete } from "./manifest";
import {
  discardOwnTemp,
  type LeftAlone,
  removeEmptyDir,
  removeIfHash,
} from "./safe-remove";

export interface BinarySource {
  exePath: string;
  /** The directory holding `<platform>-<arch>/onnxruntime_binding.node` and its library. */
  sidecarDir: string;
}

/**
 * Null when this process is not a shipped binary (a `bun run` source
 * checkout, or a test): there is nothing to install. Throws a plain-English
 * error when it is a shipped binary but its sidecar cannot be found.
 */
export function locateBinarySource(
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): BinarySource | null {
  const name = basename(execPath)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name !== CLI_BINARY_NAME && name !== CLI_NAME) return null;
  const exeDir = dirname(execPath);
  const candidates = [
    join(exeDir, "onnxruntime-native"),
    join(exeDir, "..", "share", CLI_BINARY_NAME, "onnxruntime-native"),
  ];
  const sidecarDir = candidates.find((c) => exists(c));
  if (!sidecarDir) {
    throw new Error(
      `the native runtime files are missing next to ${execPath} (looked in ${candidates.join(" and ")}) — reinstall ${CLI_BINARY_NAME} with the same command you used the first time`,
    );
  }
  return { exePath: execPath, sidecarDir: resolve(sidecarDir) };
}

/** Real path with symlinks and Windows 8.3 short names resolved, so `C:\\Users\\USERNA~1` and `C:\\Users\\User Name` compare equal (the same case `canonicalizeProjectPath` handles for projects). */
function realDir(p: string): string {
  let out: string;
  try {
    out = realpathSync.native(p);
  } catch {
    out = resolve(p);
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export function isAlreadyInstalled(
  execPath: string,
  layout: InstallLayout,
): boolean {
  return realDir(dirname(execPath)) === realDir(layout.binDir);
}

/**
 * The key a file is known by in the ownership map: its directory resolved
 * through symlinks and 8.3 short names, plus its own name, so the same
 * file spelled two ways (`RUNNER~1` and the long name, `/var` and
 * `/private/var`, a relative prefix and an absolute one) is one key.
 */
export function ownedKey(path: string): string {
  const key = canonicalKey(path);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/** The path with its directory resolved through symlinks and short names (case as the OS reports it). */
export function canonicalKey(path: string): string {
  const abs = resolve(path);
  let dir = dirname(abs);
  try {
    dir = realpathSync.native(dir);
  } catch {
    // the directory does not exist yet: the plain resolved path is the key
  }
  return join(dir, basename(abs));
}

export interface InstallResult {
  entries: ManifestFile[];
  /** Moved-aside files that could not be deleted yet (a running program holds them). */
  pending: PendingDelete[];
  /** Files init found and did not touch. */
  leftAlone: LeftAlone[];
  /** Directories this run created, leaf first. */
  createdDirs: string[];
}

/**
 * Deletes the moved-aside files from an earlier run, each only if it
 * still has the hash recorded when it was moved. A changed file is
 * dropped from the list and reported, never deleted; one that is still
 * locked stays on the list for next time.
 */
export async function sweepPending(
  pending: readonly PendingDelete[],
): Promise<{ remaining: PendingDelete[]; leftAlone: LeftAlone[] }> {
  const remaining: PendingDelete[] = [];
  const leftAlone: LeftAlone[] = [];
  for (const p of pending) {
    const r = await removeIfHash(p.path, p.sha256);
    if (r.state === "failed") remaining.push(p);
    else if (r.state === "left-alone") {
      leftAlone.push({ path: r.path, reason: r.reason });
    }
  }
  return { remaining, leftAlone };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

/** An existing file at `target` may be replaced only if we installed it and it is unchanged, or it already is what we are installing. */
async function assertReplaceable(
  target: string,
  owned: ReadonlyMap<string, string>,
  newSha: string,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target);
  } catch {
    return; // nothing there
  }
  const refuse = (why: string) =>
    new Error(
      `${target} ${why} · left alone · move it aside or delete it yourself, then run init again`,
    );
  if (!info.isFile()) throw refuse("exists and is not a regular file");
  const existing = await sha256File(target);
  if (existing === newSha) return;
  const recorded = owned.get(ownedKey(target));
  if (recorded === undefined) {
    throw refuse(`already exists and was not installed by ${CLI_BINARY_NAME}`);
  }
  if (recorded !== existing) {
    throw refuse(`was installed by ${CLI_BINARY_NAME} but has changed since`);
  }
}

// Random suffixes: a temporary name cannot collide with a file the user
// has, and every temporary file is created exclusively (COPYFILE_EXCL), so
// the cleanup below only ever touches a file this process just made.
const suffix = () => `${process.pid}-${randomBytes(6).toString("hex")}`;
const tempName = (target: string) => `${target}.new-${suffix()}`;

/**
 * Creates `staged` with `make` (which must create it exclusively), then
 * `finish`es. If anything fails, the staged file is removed only when
 * `make` itself succeeded, i.e. only if this call created it; a failure to
 * create because the name already existed leaves that file alone.
 */
async function withStaged(
  staged: string,
  make: () => Promise<unknown>,
  finish: () => Promise<void>,
): Promise<void> {
  let created = false;
  try {
    await make();
    created = true;
    await finish();
  } catch (err) {
    if (created) await discardOwnTemp(staged);
    throw err;
  }
}

/**
 * Puts `staged` at `target`, moving any existing file aside first and
 * recording it for deletion. Re-checks, immediately before the first
 * rename, that what is at `target` is still something we may replace
 * (`allowed` holds the hashes: the one being installed and the one the
 * manifest recorded), so an edit made after the up-front check is not
 * moved aside and deleted. A dangling symlink counts as "something there".
 */
async function swapIn(
  staged: string,
  target: string,
  pending: PendingDelete[],
  allowed: ReadonlySet<string>,
): Promise<void> {
  let present = true;
  try {
    await lstat(target);
  } catch {
    present = false;
  }
  if (!present) {
    await rename(staged, target);
    return;
  }
  if (!(await lstat(target)).isFile()) {
    throw new Error(`${target} is not a regular file · left alone`);
  }
  const existingSha = await sha256File(target);
  if (!allowed.has(existingSha)) {
    throw new Error(
      `${target} changed while init was running · left alone · run init again`,
    );
  }
  const aside = `${target}.old-${suffix()}`;
  await rename(target, aside);
  try {
    await rename(staged, target);
  } catch (err) {
    await rename(aside, target);
    throw err;
  }
  const r = await removeIfHash(aside, existingSha);
  if (r.state !== "removed" && r.state !== "missing") {
    pending.push({ path: aside, sha256: existingSha });
  }
}

async function manifestEntry(
  path: string,
  role: ManifestFile["role"],
  sha256?: string,
): Promise<ManifestFile> {
  return {
    path,
    sha256: sha256 ?? (await sha256File(path)),
    bytes: (await stat(path)).size,
    role,
  };
}

export async function installBinary(
  source: BinarySource,
  layout: InstallLayout,
  previous: readonly ManifestFile[] = [],
): Promise<InstallResult> {
  const owned = new Map(previous.map((f) => [ownedKey(f.path), f.sha256]));
  const pending: PendingDelete[] = [];
  const leftAlone: LeftAlone[] = [];
  const entries: ManifestFile[] = [];

  const [primaryName, ...otherNames] = executableNames(layout);
  const primary = join(layout.binDir, primaryName as string);
  const sidecarRoot = join(layout.shareDir, "onnxruntime-native");
  const exeSha = await sha256File(source.exePath);
  const sidecarSources = (await listFiles(source.sidecarDir)).sort();
  const sidecarPlan = await Promise.all(
    sidecarSources.map(async (src) => ({
      src,
      dest: join(sidecarRoot, relative(source.sidecarDir, src)),
      sha: await sha256File(src),
    })),
  );

  // Check everything first, so a refusal changes nothing.
  await assertReplaceable(primary, owned, exeSha);
  for (const name of otherNames) {
    await assertReplaceable(join(layout.binDir, name), owned, exeSha);
  }
  for (const f of sidecarPlan) await assertReplaceable(f.dest, owned, f.sha);

  const createdDirs: string[] = [];
  createdDirs.push(...(await mkdirTracked(layout.binDir)));
  createdDirs.push(...(await mkdirTracked(layout.shareDir)));

  // The executables.
  const allowedFor = (target: string, newSha: string) =>
    new Set(
      [newSha, owned.get(ownedKey(target))].filter(
        (x): x is string => x !== undefined,
      ),
    );
  const stagedPrimary = tempName(primary);
  await withStaged(
    stagedPrimary,
    () => copyFile(source.exePath, stagedPrimary, constants.COPYFILE_EXCL),
    async () => {
      await chmod(stagedPrimary, 0o755);
      await swapIn(
        stagedPrimary,
        primary,
        pending,
        allowedFor(primary, exeSha),
      );
    },
  );
  entries.push(await manifestEntry(primary, "binary", exeSha));

  // The short name: a hard link to the primary where the filesystem
  // allows it (no second 110 MB on disk), otherwise a copy.
  for (const name of otherNames) {
    const target = join(layout.binDir, name);
    const staged = tempName(target);
    await withStaged(
      staged,
      () =>
        link(primary, staged).catch(() =>
          copyFile(primary, staged, constants.COPYFILE_EXCL),
        ),
      () => swapIn(staged, target, pending, allowedFor(target, exeSha)),
    );
    entries.push(await manifestEntry(target, "binary", exeSha));
  }

  // The sidecar, one file at a time (no directory is ever removed
  // recursively, and a file that is already right is not touched).
  for (const f of sidecarPlan) {
    createdDirs.push(...(await mkdirTracked(dirname(f.dest))));
    if (!(existsSync(f.dest) && (await sha256File(f.dest)) === f.sha)) {
      const staged = tempName(f.dest);
      await withStaged(
        staged,
        () => copyFile(f.src, staged, constants.COPYFILE_EXCL),
        async () => {
          await chmod(staged, 0o755);
          await swapIn(staged, f.dest, pending, allowedFor(f.dest, f.sha));
        },
      );
    }
    entries.push(await manifestEntry(f.dest, "sidecar", f.sha));
  }

  // Files an earlier install put in the sidecar that this one no longer has.
  const keep = new Set(sidecarPlan.map((f) => ownedKey(f.dest)));
  for (const old of previous) {
    if (old.role !== "sidecar" || keep.has(ownedKey(old.path))) continue;
    // Whatever the spelling or case (a case-insensitive macOS volume), a
    // file that is the same file as one just installed is never "stale".
    if (
      sameFileAsAny(
        old.path,
        sidecarPlan.map((f) => f.dest),
      )
    )
      continue;
    const r = await removeIfHash(old.path, old.sha256);
    if (r.state === "left-alone") {
      leftAlone.push({ path: r.path, reason: r.reason });
    } else if (r.state === "failed") {
      pending.push({ path: old.path, sha256: old.sha256 });
    } else {
      // Tidy the directory it was in, but only while it is empty.
      let dir = dirname(old.path);
      while (dir.startsWith(sidecarRoot) && dir !== layout.shareDir) {
        if ((await removeEmptyDir(dir)).state !== "removed") break;
        dir = dirname(dir);
      }
    }
  }
  return { entries, pending, leftAlone, createdDirs };
}

function sameFileAsAny(path: string, candidates: readonly string[]): boolean {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return false; // not there: nothing to protect
  }
  const fold = (p: string) =>
    process.platform === "win32" || process.platform === "darwin"
      ? p.toLowerCase()
      : p;
  return candidates.some((c) => {
    try {
      return fold(realpathSync.native(c)) === fold(real);
    } catch {
      return false;
    }
  });
}
