#!/usr/bin/env bun
// Real, committed version of PR 1's spike checks — not the exploratory
// throwaway script. Run against a real compiled binary (its native
// sidecar already placed alongside it, per the release layout —
// docs/decisions.md's PR 1 addendum) on a native CI runner, after:
//   1. scripts/fetch-model.ts (no argument) has pre-warmed the real
//      modelCacheDir() the binary will read from, and
//   2. outbound network to huggingface.co has been blocked at the OS
//      level (a separate, per-OS workflow step — hosts files differ
//      by OS, so that part isn't in this script).
//
// Four checks, same names as the spike/addendum for continuity:
//   CHECK_A_SQLITE          — `fern init` opens a real bun:sqlite db
//   CHECK_B_OFFLINE_EMBED   — `fern new` computes a real embedding
//                             fully offline (proves the two dependency
//                             patches + sidecar + pre-warmed cache all
//                             work together in the compiled binary
//                             itself, not just in an interpreted
//                             bypass script — a deliberate improvement
//                             over the spike's own CHECK B, which
//                             called the embedder library directly
//                             rather than going through the binary)
//   CHECK_C_DAEMON_SELF_SPAWN — the daemon `fern new` spawned writes a
//                               real, alive daemon.json
//   CHECK_D_UI_SERVING        — that daemon serves /ui with a real 200
//
// usage: bun run scripts/smoke-test.ts <path-to-compiled-binary>

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENV_PREFIX } from "@context-fern/core";
import { readDaemonInfo } from "@context-fern/daemon";
import { isAlive, rawGetJson } from "@context-fern/daemon/client";

const binaryArg = process.argv[2];
if (!binaryArg) {
  console.error(
    "usage: bun run scripts/smoke-test.ts <path-to-compiled-binary>",
  );
  process.exit(1);
}
// Resolved against this process's own cwd, not the project dir each
// binary invocation below runs with as its cwd.
const binaryPath = resolve(binaryArg);
if (!existsSync(binaryPath)) {
  console.error(`FAIL: no such binary: ${binaryPath}`);
  process.exit(1);
}

function fail(check: string, detail: string): never {
  console.error(`${check}: FAIL\n${detail}`);
  process.exit(1);
}

/**
 * Real incident, not a hypothetical (docs/decisions.md): this PR's own
 * first CI run sat for 4+ hours at this script before being caught and
 * cancelled, because a different bug let an invocation silently hang
 * instead of failing. `spawnSync`'s own `timeout` option offers no
 * defense against that if it's never reached (CHECK_A_SQLITE had none
 * set at all) or doesn't behave as expected — this always
 * `SIGKILL`s on a hard deadline, streams output live as it happens
 * (so a hang is visible in CI logs in real time, not silent), and
 * never relies on the child's own exit to be the only way out.
 */
function runWithTimeout(
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(binaryPath, args, {
      cwd: projectDir,
      env: runEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });

    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({
        status: timedOut ? null : status,
        output: timedOut ? `${output}\n[killed after ${timeoutMs}ms]` : output,
      });
    });
  });
}

const fernHome = mkdtempSync(join(tmpdir(), "fern-smoke-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "fern-smoke-project-"));
const runEnv = { ...process.env, [`${ENV_PREFIX}HOME`]: fernHome };

// `--no` deterministically declines every prompt runInit() can show
// (gitignore, statusline, project-command) with no interactive input
// needed — piping "n\nn\n" into stdin across readline's multiple
// sequential Interface instances was genuinely unreliable (the second
// prompt in the earlier version of this script would hang forever
// even with enough buffered input, see docs/decisions.md).
const initRes = await runWithTimeout(["init", "--no"], 30_000);
if (
  initRes.status !== 0 ||
  !existsSync(join(projectDir, ".fern", "config.toml"))
) {
  fail("CHECK_A_SQLITE", `exit=${initRes.status}\n${initRes.output}`);
}
console.log("CHECK_A_SQLITE: PASS");

// Timed on purpose: the CLI gives up waiting for a freshly spawned daemon
// after ~5 s (packages/daemon/src/client.ts, MAX_POLLS x POLL_INTERVAL_MS),
// and a CI run once failed at exactly that limit. This is the cold path:
// CLI start, daemon spawn, model load, first reply.
const coldStart = performance.now();
const newRes = await runWithTimeout(["new", "smoke-test-frond"], 60_000);
const coldMs = Math.round(performance.now() - coldStart);
console.log(
  `DAEMON_COLD_START_MS: ${coldMs} (the CLI waits about 5000 ms before giving up)`,
);
if (newRes.status !== 0) {
  fail("CHECK_B_OFFLINE_EMBED", `exit=${newRes.status}\n${newRes.output}`);
}
// `fern new` also succeeds when the daemon has degraded to no-model
// routing, so exit 0 alone proves nothing about the embedder: ask the
// daemon whether the real model actually loaded.
const daemon = await readDaemonInfo(fernHome);
if (!daemon) fail("CHECK_B_OFFLINE_EMBED", "no daemon.json written");
const status = await rawGetJson(
  daemon,
  `/status?projectPath=${encodeURIComponent(projectDir)}`,
  AbortSignal.timeout(10_000),
);
const embedderState = (status.embedder as { state?: string } | undefined)
  ?.state;
if (embedderState !== "ok") {
  fail("CHECK_B_OFFLINE_EMBED", `embedder: ${JSON.stringify(status.embedder)}`);
}
console.log("CHECK_B_OFFLINE_EMBED: PASS");

// The same command against the daemon that is now up, so a slow machine
// (slow process start) can be told apart from a slow daemon start.
const warmStart = performance.now();
await runWithTimeout(["status"], 30_000);
console.log(`WARM_CALL_MS: ${Math.round(performance.now() - warmStart)}`);

const info = await readDaemonInfo(fernHome);
if (!info) fail("CHECK_C_DAEMON_SELF_SPAWN", "no daemon.json written");
if (!(await isAlive(info, AbortSignal.timeout(10_000)))) {
  fail(
    "CHECK_C_DAEMON_SELF_SPAWN",
    "daemon.json exists but daemon is not alive",
  );
}
console.log("CHECK_C_DAEMON_SELF_SPAWN: PASS");

const uiRes = await fetch(`http://127.0.0.1:${info.port}/ui`, {
  headers: { host: `127.0.0.1:${info.port}` },
  signal: AbortSignal.timeout(10_000),
});
if (uiRes.status !== 200) {
  fail("CHECK_D_UI_SERVING", `http ${uiRes.status}`);
}
console.log(`CHECK_D_UI_SERVING: PASS (http ${uiRes.status})`);

await runWithTimeout(["daemon", "stop"], 10_000);
console.log("smoke test: ALL CHECKS PASSED");
