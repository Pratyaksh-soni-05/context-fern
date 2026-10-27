// Mirrors packages/store/test/test-helpers.ts's pattern (a small,
// deliberate duplication rather than reaching into another package's
// test directory) — every temp dir's own name contains a space, since
// the real project path does.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

export async function withTempProjectDir(): Promise<TempDir> {
  const base = join(tmpdir(), `fern daemon test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "run-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
