// The ONLY place install code deletes anything. Everything `context-fern
// init` (and, later, `fern uninstall`) removes goes through
// `removeIfHash`: a file is deleted only if it is a regular file whose
// SHA-256 right now equals the hash we recorded when we put it there.
// A different hash (the user edited it), a symlink, a directory or
// anything else is left alone and reported. There is no recursive
// delete anywhere in install code; `removeEmptyDir` refuses a directory
// that has anything in it. `test/install/deletion-safety.test.ts`
// enforces this by scanning the install sources.
//
// There is an unavoidable gap between the hash check and the unlink; the
// install directories are the user's own and this is not a defence
// against a local attacker, only against deleting a file we do not own.

import { lstat, rmdir, unlink } from "node:fs/promises";
import { sha256File } from "./hash";

export interface LeftAlone {
  path: string;
  reason: "changed-since-install" | "not-a-regular-file" | "not-empty";
}

export type RemoveOutcome =
  | { state: "removed" }
  | { state: "missing" }
  | ({ state: "left-alone" } & LeftAlone)
  | { state: "failed"; path: string; error: string };

export async function removeIfHash(
  path: string,
  expectedSha256: string,
): Promise<RemoveOutcome> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return { state: "missing" };
  }
  if (!info.isFile()) {
    return { state: "left-alone", path, reason: "not-a-regular-file" };
  }
  let actual: string;
  try {
    actual = await sha256File(path);
  } catch (err) {
    return { state: "failed", path, error: (err as Error).message };
  }
  if (actual !== expectedSha256) {
    return { state: "left-alone", path, reason: "changed-since-install" };
  }
  try {
    await unlink(path);
    return { state: "removed" };
  } catch (err) {
    // Typically a running program holds it (Windows): the caller keeps it
    // on the manifest's pending list and tries again next time.
    return { state: "failed", path, error: (err as Error).message };
  }
}

/** Removes a directory only if it is empty. Never recursive. */
export async function removeEmptyDir(path: string): Promise<RemoveOutcome> {
  try {
    await rmdir(path);
    return { state: "removed" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return { state: "left-alone", path, reason: "not-empty" };
    }
    return { state: "failed", path, error: (err as Error).message };
  }
}

/**
 * For a temporary file this process just created itself with an exclusive
 * create (COPYFILE_EXCL, or the "wx" flag), and wants gone after a later
 * step failed. Callers must only call it after that create succeeded: a
 * failure to create because the name already existed must leave that file
 * alone (see `withStaged` in binary.ts and `writeManifest`). The hash is
 * taken here, so this is the same checked delete, but the check is only
 * meaningful because of that caller rule; it is not a manifest check.
 */
export async function discardOwnTemp(path: string): Promise<void> {
  try {
    await removeIfHash(path, await sha256File(path));
  } catch {
    // not there
  }
}
