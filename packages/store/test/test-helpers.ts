// Shared temp-dir helper for store tests. Extends the existing pattern
// (os.tmpdir() + Date.now(), manually cleaned in afterEach — see
// jsonl-journal-sink.test.ts) so every store test, not just one dedicated
// case, runs inside a directory that itself contains a space — the real
// project path ("Example Projects") has one, and a naive path.join /
// shell-quoting bug would only show up with a space actually present.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

async function makeTempDirUnder(base: string): Promise<TempDir> {
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "run-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** A fresh temp dir whose own name contains a space. */
export function withTempFernDir(): Promise<TempDir> {
  return makeTempDirUnder(join(tmpdir(), `fern store test ${Date.now()}`));
}

/** Mirrors the exact real-world shape that prompted this requirement: a
 * user directory with a space, one path segment away from the project. */
export function withRealWorldSpacedDir(): Promise<TempDir> {
  return makeTempDirUnder(
    join(tmpdir(), "Example Projects", `project-${Date.now()}`),
  );
}
