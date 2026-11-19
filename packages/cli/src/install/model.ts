// Copies the embedding model from the package that carried it into the
// OS cache dir, then verifies it against the pinned SHA-256s. The binary
// has no code that can download anything (docs/decisions.md 2026-11-13):
// the model arrives inside `context-fern-model` (npm and PyPI), and this
// only moves it into place.
//
// It copies only the pinned files, into names that do not exist yet. A
// file that is already there with the wrong hash is not ours to replace
// or delete: it is left alone and reported. If the copied files then fail
// verification, only the files this run just wrote are removed, through
// the same hash-checked delete as everything else.

import { constants, existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLI_BINARY_NAME, ENV_PREFIX } from "@context-fern/core";
import {
  checkModelFiles,
  DEFAULT_MODEL_ID,
  MODEL_FILE_SHA256,
} from "@context-fern/embed/model-integrity";
import { mkdirTracked } from "./dirs";
import { sha256File } from "./hash";
import { removeIfHash } from "./safe-remove";

export const MODEL_PAYLOAD_ENV = `${ENV_PREFIX}MODEL_PAYLOAD`;

/**
 * Where the model package's files are, or null. In order:
 * 1. `FERN_MODEL_PAYLOAD`, set by the npm launcher, which knows where npm
 *    put `context-fern-model`.
 * 2. `<exe-dir>/../share/context-fern-model`, where a pip/uv install of
 *    `context-fern-model` puts it, beside the `bin`/`Scripts` directory.
 * The returned directory contains `Xenova/all-MiniLM-L6-v2/...`.
 */
export function findModelPayload(
  env: Record<string, string | undefined>,
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    env[MODEL_PAYLOAD_ENV],
    join(dirname(execPath), "..", "share", `${CLI_BINARY_NAME}-model`),
  ];
  for (const c of candidates) {
    if (c && exists(join(c, DEFAULT_MODEL_ID))) return c;
  }
  return null;
}

export type ModelInstallResult =
  | { state: "already-installed" }
  | { state: "installed"; dir: string; createdDirs: string[] }
  | { state: "no-payload" }
  | { state: "failed"; reason: string };

export async function installModel(
  payloadDir: string | null,
  cacheDir: string,
): Promise<ModelInstallResult> {
  if ((await checkModelFiles(cacheDir)) === null) {
    return { state: "already-installed" };
  }
  if (payloadDir === null) return { state: "no-payload" };
  const target = join(cacheDir, DEFAULT_MODEL_ID);
  const copied: { path: string; sha256: string }[] = [];
  const createdDirs: string[] = [];
  try {
    for (const [file, pinned] of Object.entries(MODEL_FILE_SHA256)) {
      const dest = join(target, file);
      if (existsSync(dest)) {
        if ((await sha256File(dest)) === pinned) continue;
        return {
          state: "failed",
          reason: `${dest} does not match the pinned checksum · left alone · delete it yourself and run init again`,
        };
      }
      const src = join(payloadDir, DEFAULT_MODEL_ID, file);
      const srcSha = await sha256File(src);
      createdDirs.push(...(await mkdirTracked(dirname(dest))));
      await copyFile(src, dest, constants.COPYFILE_EXCL);
      copied.push({ path: dest, sha256: srcSha });
    }
  } catch (err) {
    await undo(copied);
    return {
      state: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const problem = await checkModelFiles(cacheDir);
  if (problem) {
    await undo(copied);
    return {
      state: "failed",
      reason: `${problem.kind} ${problem.path} (the model package does not match the pinned checksums)`,
    };
  }
  return { state: "installed", dir: target, createdDirs };
}

/** Removes only what this run copied, and only while it still has the hash it was copied with. */
async function undo(copied: { path: string; sha256: string }[]): Promise<void> {
  for (const c of copied) await removeIfHash(c.path, c.sha256);
}
