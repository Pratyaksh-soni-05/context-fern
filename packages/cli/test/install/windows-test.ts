// Shared by the tests that run real Windows PowerShell against a scratch
// registry key or wait for a real helper process. Each of those starts at
// least one powershell.exe; that takes 0.3-1 s on a healthy machine and
// more than 5 s, bun's default per-test timeout, when a shared CI runner
// stalls (run 44742137729: seven tests timed out at 5 s and one waited out
// a 15 s poll, on a job that took 8m45s instead of 4m43s). So these tests
// get a generous timeout by default, and waits are bounded by a deadline,
// not by a count of short sleeps. docs/decisions.md, 2026-11-20.

import { test } from "bun:test";

export const WINDOWS_TEST_TIMEOUT_MS = 60_000;

/** `test` on Windows, `test.skip` elsewhere, with WINDOWS_TEST_TIMEOUT_MS unless the test says otherwise. */
export function win(
  name: string,
  fn: () => void | Promise<void>,
  timeoutMs: number = WINDOWS_TEST_TIMEOUT_MS,
): void {
  const run = process.platform === "win32" ? test : test.skip;
  run(name, fn, timeoutMs);
}

/** Polls until `done()` is true or `withinMs` has passed; the caller asserts the result. */
export async function waitFor(
  done: () => boolean,
  withinMs = 45_000,
  everyMs = 150,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(everyMs);
}
