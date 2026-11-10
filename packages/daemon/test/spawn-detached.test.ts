// Regression guard for a real incident: `fern ui`'s browser-open spawn
// (packages/cli/src/commands/ui.ts) used to call Bun.spawn directly,
// without `detached: true` + `.unref()`. Since `runUi()` returns, logs
// one line, and the CLI process exits almost immediately after calling
// it, the un-detached child (`cmd /c start "" <url>` on Windows) was
// torn down by the OS before it finished handing off navigation to the
// real browser. Confirmed directly on a real Windows machine, through
// the actual `fern ui` CLI (not this test): 4 consecutive real runs
// with the un-fixed code reproduced it every time — the browser's
// /ui-code exchange never reached the daemon at all, even after
// waiting 10s per run — and 4 consecutive runs succeeded every time,
// each completing in under 500ms, once both call sites (this one and
// the pre-existing daemon-spawn helper) went through spawnDetached().
// This is why Playwright's suite never caught it: page.goto() doesn't
// go through this spawn at all. See docs/decisions.md.
//
// This specific unit test, run under `bun test`, could NOT be made to
// reproduce the hazard itself — it passes whether or not spawnDetached()
// actually sets `detached`/`unref` (tried several process-tree shapes:
// a bare child, a cmd.exe-wrapped child, inherited vs. ignored stdio on
// the launcher). The hazard appears tied to how a plain `bun <file>`
// process spawned by an interactive shell relates to the OS's process/
// job lifecycle, which `bun test`'s own process tree doesn't reproduce.
// So treat this test as a basic behavioural contract check for
// spawnDetached() — a real child, not a mock-call assertion — not as
// proof it would catch a future regression of this exact defect. The
// real evidence for the fix is the repeated, direct reproduction above.

import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("spawnDetached()'s child survives its launching process exiting immediately after the spawn call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fern-spawn-detached-"));
  const marker = join(dir, "marker");
  const grandchildScript = join(dir, "grandchild.ts");
  const launcherScript = join(dir, "launcher.ts");

  // The grandchild delays before writing its marker, standing in for the
  // real gap between a browser process being told to navigate and it
  // actually issuing its first request.
  await writeFile(
    grandchildScript,
    `await new Promise((r) => setTimeout(r, 500));\nawait Bun.write(${JSON.stringify(marker)}, "done");\n`,
  );

  // The launcher calls spawnDetached() and then exits immediately,
  // exactly like runUi() does right after calling openBrowser().
  const clientPath = join(import.meta.dir, "..", "src", "client.ts");
  await writeFile(
    launcherScript,
    `import { spawnDetached } from ${JSON.stringify(clientPath)};\nspawnDetached(["bun", ${JSON.stringify(grandchildScript)}]);\n`,
  );

  try {
    const launcher = Bun.spawn({
      cmd: ["bun", launcherScript],
      stdio: ["ignore", "ignore", "ignore"],
    });
    await launcher.exited;

    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline) {
      found = await exists(marker);
      if (found) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(found).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
