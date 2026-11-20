// Decides whether a process that does not answer is really our own daemon,
// for `fern daemon stop` and nothing else. It exists because stopping a
// daemon normally needs the daemon to answer (`isOurDaemon`), and a hung one
// does not. Everything here fails closed: the answer is "ours" only when the
// process's command line is one of the two ways we start a daemon AND the
// port recorded in daemon.json is listened on by that same pid. A stale
// daemon.json whose pid now belongs to some other program (after a reboot, say)
// fails the command-line check; a lookup that cannot be made (the command is
// missing, no permission) is reported as unconfirmed, never as a yes.

import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME } from "@context-fern/core";

/** A lookup that could not be completed. Carries what was found, for the message. */
export class Undetermined extends Error {}

export interface ProcessInspector {
  /** The process's command line as one string, or null if no such process. Throws Undetermined if it cannot be read. */
  commandLine(pid: number): Promise<string | null>;
  /** Whether `pid` listens on `port` (TCP). Throws Undetermined if it cannot be told. */
  holdsPort(pid: number, port: number): Promise<boolean>;
}

export type DaemonVerdict =
  /** Command line is ours and the recorded port is held by this pid: safe to stop. */
  | { verdict: "ours"; commandLine: string }
  /** The pid is a different program (the file is stale): never touch it. */
  | { verdict: "foreign"; commandLine: string }
  /** Could not be confirmed either way: touch nothing, report `why`. */
  | { verdict: "unconfirmed"; why: string };

// The two ways a daemon is started (daemonSpawnCommand in client.ts):
//   source:   bun run <...>/serve-entrypoint.ts
//   compiled: <...>/context-fern --internal-daemon   (or fern, the hard-linked name)
// Each token is either "quoted" (a path with spaces) or a run of non-space characters, so
// nothing else can sit before the program or between its arguments: `/bin/sh -c /x/fern
// --internal-daemon` and `bun run /tmp/evil.ts /y/serve-entrypoint.ts` are not daemons.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (nameRe: string) =>
  `(?:"(?:[^"]*[\\\\/])?${nameRe}"|(?:[^\\s"]*[\\\\/])?${nameRe})`;
const SOURCE_FORM = new RegExp(
  `^${token("bun(?:\\.exe)?")}\\s+run\\s+${token("serve-entrypoint\\.ts")}$`,
  "i",
);
const COMPILED_FORM = new RegExp(
  `^${token(`(?:${escapeRe(CLI_BINARY_NAME)}|${escapeRe(CLI_NAME)})(?:\\.exe)?`)}\\s+--internal-daemon$`,
  "i",
);

/** Whether a command line is one of the two forms a fern daemon is started with. */
export function isDaemonCommandLine(commandLine: string): boolean {
  const c = commandLine.trim();
  return SOURCE_FORM.test(c) || COMPILED_FORM.test(c);
}

export async function inspectDaemonProcess(
  pid: number,
  port: number,
  inspector: ProcessInspector = defaultInspector(),
): Promise<DaemonVerdict> {
  let commandLine: string | null;
  try {
    commandLine = await inspector.commandLine(pid);
  } catch (err) {
    return {
      verdict: "unconfirmed",
      why: `could not read the command line of pid ${pid} (${reason(err)})`,
    };
  }
  if (commandLine === null) {
    return {
      verdict: "unconfirmed",
      why: `pid ${pid} has no readable command line`,
    };
  }
  if (!isDaemonCommandLine(commandLine)) {
    return { verdict: "foreign", commandLine };
  }
  try {
    if (await inspector.holdsPort(pid, port)) {
      return { verdict: "ours", commandLine };
    }
  } catch (err) {
    return {
      verdict: "unconfirmed",
      why: `pid ${pid} looks like a ${CLI_NAME} daemon but whether it holds port ${port} could not be checked (${reason(err)})`,
    };
  }
  return {
    verdict: "unconfirmed",
    why: `pid ${pid} looks like a ${CLI_NAME} daemon but does not hold port ${port}`,
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- platform lookups

function run(
  file: string,
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf-8", timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (err && (err as { killed?: boolean }).killed) {
          reject(new Undetermined(`${file} did not finish in 10 s`));
        } else if (err && typeof code !== "number") {
          // The command could not be started at all (missing, no permission): not an answer.
          reject(
            new Undetermined(`${file} could not be run (${String(code)})`),
          );
        } else {
          resolve({ code: err ? (code as number) : 0, stdout });
        }
      },
    );
  });
}

const POWERSHELL = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const windowsInspector: ProcessInspector = {
  async commandLine(pid) {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction Stop; 'OK'; if ($p) { 'FOUND'; $p.CommandLine }`;
    const { stdout } = await run(POWERSHELL, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const lines = stdout.split(/\r?\n/);
    if (lines[0]?.trim() !== "OK")
      throw new Undetermined("the PowerShell lookup did not run");
    if (lines[1]?.trim() !== "FOUND") return null;
    const line = lines[2]?.trim();
    if (!line) throw new Undetermined("Windows did not give the command line");
    return line;
  },
  async holdsPort(pid, port) {
    // "No listener on that port" is the cmdlet's ObjectNotFound error and is an answer (empty list);
    // any other failure (cmdlet missing, access denied) prints nothing after ERR so it is reported
    // as a lookup that could not be made, not as "does not hold the port".
    const script = `try { $c = Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $c = @() } else { 'ERR'; $_.Exception.Message; exit 0 } }; 'OK'; $c | ForEach-Object { $_.OwningProcess }`;
    const { stdout } = await run(POWERSHELL, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const lines = stdout.split(/\r?\n/).map((l) => l.trim());
    if (lines[0] === "ERR")
      throw new Undetermined(
        `Get-NetTCPConnection failed: ${lines[1] ?? "no message"}`,
      );
    if (lines[0] !== "OK")
      throw new Undetermined("the PowerShell lookup did not run");
    return lines.slice(1).some((l) => l === String(pid));
  },
};

const linuxInspector: ProcessInspector = {
  async commandLine(pid) {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf-8");
      // Arguments are NUL-separated, so one that contains a space is quoted, the way a
      // Windows command line shows it, and the two forms are told apart the same way.
      const args = raw.split("\0").filter(Boolean);
      return args.length === 0
        ? null
        : args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Undetermined(reason(err));
    }
  },
  async holdsPort(pid, port) {
    // Listening sockets on the port (state 0A) from the kernel's tables, then whether
    // this pid has one of those sockets open. No external command is needed.
    const inodes = new Set<string>();
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text: string;
      try {
        text = await readFile(table, "utf-8");
      } catch (err) {
        if (
          table.endsWith("tcp6") &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
          continue;
        throw new Undetermined(`${table}: ${reason(err)}`);
      }
      for (const line of text.split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || f[3] !== "0A") continue;
        const localPort = Number.parseInt(f[1]?.split(":")[1] ?? "", 16);
        if (localPort === port && f[9]) inodes.add(f[9]);
      }
    }
    if (inodes.size === 0) return false;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch (err) {
      throw new Undetermined(`/proc/${pid}/fd: ${reason(err)}`);
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m?.[1] && inodes.has(m[1])) return true;
      } catch {
        // an fd that closed while reading: not the one
      }
    }
    return false;
  },
};

const darwinInspector: ProcessInspector = {
  async commandLine(pid) {
    // -ww: never truncate to the terminal width. `comm` is the executable's own path (spaces
    // included), which lets a program path with spaces be quoted, as the other platforms show it.
    const args = await run("ps", ["-ww", "-p", String(pid), "-o", "command="]);
    const text = args.stdout.trim();
    if (args.code === 1 && !text) return null; // ps: no such process
    if (args.code !== 0 || !text)
      throw new Undetermined(`ps exited ${args.code}`);
    const comm = await run("ps", ["-ww", "-p", String(pid), "-o", "comm="]);
    const exe = comm.stdout.trim();
    if (comm.code === 0 && exe.includes(" ") && text.startsWith(exe))
      return `"${exe}"${text.slice(exe.length)}`;
    return text;
  },
  async holdsPort(pid, port) {
    const { code, stdout } = await run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    if (code === 0) return stdout.split("\n").some((l) => l === `p${pid}`);
    if (code === 1 && stdout.trim() === "") return false; // lsof: nothing matched
    throw new Undetermined(`lsof exited ${code}`);
  },
};

export function defaultInspector(): ProcessInspector {
  if (process.platform === "win32") return windowsInspector;
  if (process.platform === "linux") return linuxInspector;
  if (process.platform === "darwin") return darwinInspector;
  return {
    commandLine: () => {
      throw new Undetermined(`${process.platform} is not supported`);
    },
    holdsPort: () => {
      throw new Undetermined(`${process.platform} is not supported`);
    },
  };
}
