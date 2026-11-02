import { CLI_NAME } from "@context-fern/core";
import { deleteDaemonInfo, readDaemonInfo } from "@context-fern/daemon";
import { ensureDaemonRunning, isAlive } from "@context-fern/daemon/client";

export async function runDaemon(subcommand: string | undefined): Promise<void> {
  if (subcommand === "start") {
    const info = await ensureDaemonRunning();
    console.log(
      `${CLI_NAME} ▸ daemon running on 127.0.0.1:${info.port} (pid ${info.pid})`,
    );
    return;
  }

  if (subcommand === "stop") {
    const info = await readDaemonInfo();
    if (!info) {
      console.log(`${CLI_NAME} ▸ daemon not running`);
      return;
    }
    // Only kill if this daemon.json actually still answers — a stale
    // file left behind by a crash could otherwise name a PID the OS has
    // since recycled for an unrelated process.
    if (await isAlive(info)) {
      try {
        process.kill(info.pid);
      } catch {
        // already gone
      }
    }
    await deleteDaemonInfo();
    console.log(`${CLI_NAME} ▸ daemon stopped`);
    return;
  }

  if (subcommand === "status") {
    const info = await readDaemonInfo();
    if (!info) {
      console.log(`${CLI_NAME} ▸ daemon not running`);
      return;
    }
    const alive = await isAlive(info);
    console.log(
      `${CLI_NAME} ▸ daemon ${alive ? "running" : "not responding"} on 127.0.0.1:${info.port} (pid ${info.pid}, started ${info.startedAt})`,
    );
    return;
  }

  console.error(
    `${CLI_NAME}: unknown daemon subcommand "${subcommand}" (expected start|stop|status)`,
  );
}
