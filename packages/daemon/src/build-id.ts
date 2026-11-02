// A per-process fingerprint of "which code is this" — the package
// version plus a short git sha of the current checkout. Lets the
// client detect a daemon left running from an older checkout (the real
// cause of a stray-daemon incident during dogfooding, where a daemon
// spawned hours earlier kept answering with stale code for the rest of
// the session — see docs/decisions.md) and replace it instead of
// talking to it.
//
// Git-based rather than a full content hash of the source tree: a
// single `git rev-parse` is one fast subprocess call, safe to run on
// every hook invocation (a fresh process per call, so there's no
// in-process cache to rely on across calls); hashing every source
// file's mtime+size on every hook invocation would add real,
// unnecessary I/O to the passive hooks' already-tight budget. The
// trade-off: two *uncommitted* edits in a row between the daemon's
// spawn and a client's check won't be detected as different (same sha
// both times) — commit before retesting a fix if that matters. No
// published package exists yet (installers are Phase 4) — once one
// does, a checkout without `.git` falls back to the version string
// alone, which makes this a permanent no-op match rather than a crash;
// revisit with a real content hash of the built artifacts then.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function gitShortSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Memoized per process — cheap enough to call again, but no reason to re-spawn git more than once per hook invocation. */
export function buildId(): string {
  if (cached) return cached;
  const sha = gitShortSha();
  cached = sha ? `${packageVersion()}+${sha}` : packageVersion();
  return cached;
}
