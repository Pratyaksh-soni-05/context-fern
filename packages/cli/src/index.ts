#!/usr/bin/env bun
import { CLI_NAME } from "@context-fern/core";
import { parseArgs } from "./argv";

export { parseArgs } from "./argv";
export { loadConfig } from "./load-config";
export { type ReplayTurnInput, type ReplayTurnOutput, replay } from "./replay";

// Every command's own module is imported dynamically, per case, rather
// than statically at the top of this file. Two real reasons, not just
// style: (1) `context-fern hook <event>`/`context-fern mcp` fire on
// every single prompt/tool-call — a static import here would make that
// cold-start eagerly load every *other* command's module too (route.ts
// pulls in packages/store and packages/embed for its dev-only --replay
// harness, per docs/architecture.md), adding real, unmeasured latency
// to the one path with an actual budget (hooks.json's timeout; see
// docs/decisions.md's Phase-4 PR 2 latency entry). (2) it's what keeps
// commands/hook.ts's own import graph — verified by
// test/hooks/import-graph.test.ts — meaningful as a *runtime* guarantee
// and not just a documentation comment: that test walks from
// commands/hook.ts directly, which is accurate regardless of how this
// switch is written, but only the dynamic-import form here actually
// delivers the latency benefit that test can't itself measure.
async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case "route": {
        const { runRoute } = await import("./commands/route");
        await runRoute(flags);
        return 0;
      }
      case "init": {
        // The machine-wide half first (binary, model, PATH, plugin); it
        // installs nothing from a source checkout. Then the project half,
        // unless this is the home directory, where `.fern/` would collide
        // with the daemon's own state.
        const { runGlobalInit, shouldRunProjectInit } = await import(
          "./install/global-init"
        );
        await runGlobalInit(flags);
        const { homedir } = await import("node:os");
        if (!shouldRunProjectInit(process.cwd(), homedir(), flags)) {
          console.log(
            `${CLI_NAME} ▸ not a project folder, so no project set up here · run "${CLI_NAME} init" inside a project to start routing`,
          );
          return 0;
        }
        const { runInit } = await import("./commands/init");
        const { materializeAndRegisterProject } = await import(
          "./commands/init-materialize"
        );
        await runInit(flags);
        await materializeAndRegisterProject(process.cwd());
        return 0;
      }
      case "--version":
      case "version": {
        const { CLI_VERSION } = await import("@context-fern/core");
        console.log(CLI_VERSION);
        return 0;
      }
      case "uninstall": {
        const { runUninstallCommand } = await import("./commands/uninstall");
        return await runUninstallCommand(flags);
      }
      case "daemon": {
        const { runDaemon } = await import("./commands/daemon");
        await runDaemon(positional[0]);
        return 0;
      }
      case "status": {
        const { runStatus } = await import("./commands/status");
        await runStatus(flags);
        return 0;
      }
      case "tree": {
        const { runTree } = await import("./commands/tree");
        await runTree();
        return 0;
      }
      case "new": {
        const { runNew } = await import("./commands/frond");
        await runNew(positional[0]);
        return 0;
      }
      case "switch": {
        const { runSwitch } = await import("./commands/frond");
        await runSwitch(positional[0]);
        return 0;
      }
      case "stray": {
        const { runStray } = await import("./commands/frond");
        await runStray();
        return 0;
      }
      case "undo": {
        const { runUndo } = await import("./commands/frond");
        await runUndo();
        return 0;
      }
      case "merge": {
        const { runMerge } = await import("./commands/frond");
        await runMerge(positional[0]);
        return 0;
      }
      case "mode": {
        const { runMode } = await import("./commands/frond");
        return runMode(positional[0]);
      }
      case "doctor": {
        const { runDoctor } = await import("./commands/doctor");
        return await runDoctor(flags);
      }
      case "statusline": {
        const { runStatusline } = await import("./commands/statusline");
        const { recordStatusline } = await import(
          "./install/record-statusline"
        );
        // `--install` records what it added in the install manifest, as init does,
        // so an uninstall removes exactly that entry.
        await recordStatusline(await runStatusline(flags));
        return 0;
      }
      case "ui": {
        const { runUi } = await import("./commands/ui");
        await runUi();
        return 0;
      }
      case "hook": {
        const { runHook } = await import("./commands/hook");
        return runHook(positional[0]);
      }
      case "fern-fallback": {
        const { runFernFallback } = await import("./commands/fern-fallback");
        return runFernFallback();
      }
      case "mcp": {
        const { runMcp } = await import("./commands/mcp");
        return runMcp();
      }
      default:
        console.error(`${CLI_NAME}: unknown command "${command}"`);
        return 1;
    }
  } catch (err) {
    console.error(
      `${CLI_NAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--internal-daemon") {
    // Checked before parseArgs/main() entirely, and never followed by
    // process.exit() below — a compiled binary has no real
    // "../serve-entrypoint.ts" file to `bun run` (import.meta.dir
    // doesn't point at a real path inside --compile), so
    // spawnDaemonDetached() (packages/daemon/src/client.ts) re-invokes
    // this exact executable with this flag instead. startDaemon()'s
    // own open listening socket is what keeps this process alive from
    // here — exactly the same tier serve-entrypoint.ts's own
    // top-level `if (import.meta.main)` code already occupies for the
    // dev/bun-run path. The first attempt wired this inside main()
    // instead, and the daemon started, printed its listening line,
    // then immediately exited, because main()'s caller always exits
    // once main() resolves. See docs/decisions.md's PR 1 spike finding.
    const { startDaemon } = await import("@context-fern/daemon");
    const handle = await startDaemon();
    console.log(`${CLI_NAME} daemon listening on 127.0.0.1:${handle.port}`);
  } else {
    // `main().then((code) => process.exit(code))` lost already-written
    // stdout here on Windows for any command that does real I/O before
    // its final console.log/stdout write (confirmed with `fern doctor` —
    // exit code 0, zero output, reproduced outside this file too) — a
    // latent bug promoted to a real one once `context-fern hook <event>`
    // made a subcommand's stdout the actual payload Claude Code reads,
    // not just terminal output a human skims. A plain top-level `await`
    // (no separate .then() callback microtask) does not lose it. See
    // docs/decisions.md's Phase-4 PR 2 entry.
    const code = await main();
    process.exit(code);
  }
}
