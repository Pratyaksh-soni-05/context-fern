import { CLI_NAME } from "@context-fern/core";
import { readDaemonInfo } from "@context-fern/daemon";
import {
  ensureDaemonRunning,
  isAlive,
  stopRunningDaemon,
} from "@context-fern/daemon/client";

function shorten(text: string): string {
  // Keep both ends: the program is at the start and the file or argument that says what it is at the end.
  return text.length > 90 ? `${text.slice(0, 30)}...${text.slice(-55)}` : text;
}

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
    // The one place a daemon that does not answer may be stopped, and only after
    // its command line and the recorded port both confirm it is ours.
    const result = await stopRunningDaemon(5000, { killUnresponsive: true });
    if (result.state === "not-running") {
      console.log(`${CLI_NAME} ▸ daemon not running`);
    } else if (result.state === "stale-removed") {
      console.log(
        result.pidReused
          ? `${CLI_NAME} ▸ daemon not running (removed a stale daemon.json; pid ${result.pidReused.pid} now belongs to another program, "${shorten(result.pidReused.commandLine)}", and was not touched)`
          : `${CLI_NAME} ▸ daemon not running (removed a stale daemon.json)`,
      );
    } else if (result.state === "stopped") {
      console.log(`${CLI_NAME} ▸ daemon stopped`);
    } else if (result.state === "unresponsive-stopped") {
      console.log(
        `${CLI_NAME} ▸ daemon (pid ${result.pid}) was not answering and was stopped`,
      );
    } else if (result.state === "unresponsive-left") {
      console.log(
        `${CLI_NAME} ▸ daemon not stopped: daemon.json names pid ${result.pid}, which is running but does not answer · ${result.why} · nothing was stopped and daemon.json was kept`,
      );
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
