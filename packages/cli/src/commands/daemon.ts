import { CLI_NAME } from "@context-fern/core";
import { readDaemonInfo } from "@context-fern/daemon";
import {
  ensureDaemonRunning,
  isAlive,
  stopRunningDaemon,
} from "@context-fern/daemon/client";

export async function runDaemon(subcommand: string | undefined): Promise<void> {
  if (subcommand === "start") {
    const info = await ensureDaemonRunning();
    console.log(
      `${CLI_NAME} ▸ daemon running on 127.0.0.1:${info.port} (pid ${info.pid})`,
    );
    return;
  }

  if (subcommand === "stop") {
    // Waits for the process to exit, so a caller that deletes the
    // executable next is not racing it (docs/decisions.md, 2026-11-18).
    const result = await stopRunningDaemon();
    if (result.state === "not-running") {
      console.log(`${CLI_NAME} ▸ daemon not running`);
    } else if (result.state === "stale-removed") {
      console.log(
        `${CLI_NAME} ▸ daemon not running (removed a stale daemon.json)`,
      );
    } else if (result.state === "stopped") {
      console.log(`${CLI_NAME} ▸ daemon stopped`);
    } else {
      console.log(
        `${CLI_NAME} ▸ daemon (pid ${result.pid}) did not exit within 5 s · it may still be starting up or busy · run "${CLI_NAME} daemon stop" again`,
      );
    }
    return;
  }

  if (subcommand === "status") {
    const info = await readDaemonInfo();
    if (!info) {
      console.log(`${CLI_NAME} ▸ daemon not running`);
      return;
    }
    const alive = await isAlive(info, AbortSignal.timeout(2000));
    console.log(
      `${CLI_NAME} ▸ daemon ${alive ? "running" : "not responding"} on 127.0.0.1:${info.port} (pid ${info.pid}, started ${info.startedAt})`,
    );
    return;
  }

  console.error(
    `${CLI_NAME}: unknown daemon subcommand "${subcommand}" (expected start|stop|status)`,
  );
}
