// What a user gets from the real npm registry, on a clean machine, end to end:
//
//   bun scripts/registry-e2e.ts [--spec rc|next|<version>] [--add-to-path]
//
// 1. resolves --spec to a version (npm view) and installs context-fern from the
//    registry, retrying in a fresh directory while the registry catches up
//    (the same rule as scripts/verify-npm-release.ts);
// 2. `init` with a scratch HOME / profile, then `doctor --json`;
// 3. a scripted hook run against a scratch project: SessionStart,
//    UserPromptSubmit, and a SessionStart restore after a frond exists;
// 4. `daemon stop`, `uninstall`, and an assertion that nothing was left behind
//    (files, a process, the statusline entry, a PATH entry).
//
// Nothing is published and nothing reads a secret. It runs a real daemon and
// writes real files, so it belongs on a CI runner or in a scratch profile:
// HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_*, CLAUDE_CONFIG_DIR and
// FERN_HOME all point into one temporary directory, the install prefix
// defaults to a folder inside it, and the caller's own FERN_* and npm_config_*
// variables are dropped. The one thing a scratch profile cannot
// redirect is the Windows user PATH (the registry), so it is only edited with
// --add-to-path, and the script checks that uninstall puts it back exactly as
// it was. FERN_E2E_KEEP=1 keeps the scratch directory for inspection.
//
// Dependency-free on purpose (node built-ins only), so the workflow can run it
// without `bun install`.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep as SEP } from "node:path";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const INSTALL_TRIES = 20;
const INSTALL_EVERY_MS = 15_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const spec = flag("spec") ?? "rc";
const addToPath = process.argv.includes("--add-to-path");
// a dist-tag or a version: letters, digits, dots and dashes only
if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(spec))
  throw new Error(
    `--spec is a dist-tag or a version, not ${JSON.stringify(spec)}`,
  );

const NEWLINE = String.fromCharCode(10);
const failures: string[] = [];
const fail = (m: string) => {
  failures.push(m);
  console.error(`FAIL: ${m}`);
};
const step = (m: string) => console.log(`\n== ${m}`);
const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const root = mkdtempSync(join(tmpdir(), "fern-registry-e2e-"));
const userHome = join(root, "userhome");
const project = join(root, "project");
const fernHome = join(root, "fernhome");
for (const d of [userHome, project, fernHome, join(userHome, ".claude")])
  mkdirSync(d, { recursive: true });

// Nothing of the caller's own install may leak in: every FERN_* variable
// (FERN_INSTALL_PREFIX would point init and uninstall at a real install) and
// every npm_config_* setting is dropped, then the scratch ones are set.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) => v !== undefined && !/^FERN_|^npm_config_/i.test(k),
  ),
) as Record<string, string>;
const env: Record<string, string> = {
  ...inherited,
  HOME: userHome,
  USERPROFILE: userHome,
  LOCALAPPDATA: join(userHome, "AppData", "Local"),
  APPDATA: join(userHome, "AppData", "Roaming"),
  XDG_CACHE_HOME: join(userHome, ".cache"),
  XDG_CONFIG_HOME: join(userHome, ".config"),
  XDG_DATA_HOME: join(userHome, ".local", "share"),
  ZDOTDIR: userHome,
  CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
  FERN_HOME: fernHome,
};

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeout?: number } = {},
): Result {
  const shell = WIN && /^npm$|\.cmd$/i.test(cmd);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    env,
    input: opts.input,
    encoding: "utf-8",
    timeout: opts.timeout ?? 120_000,
    shell,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function platformPackage(): string {
  const t: Record<string, string> = {
    "win32-x64": "win-x64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "darwin-arm64": "darwin-arm64",
  };
  const k = `${process.platform}-${process.arch}`;
  if (!t[k]) throw new Error(`${k} is not a supported target`);
  return `@context-fern/${t[k]}`;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The Windows user PATH as the registry holds it, unexpanded. */
function registryPath(): string | undefined {
  if (!WIN) return undefined;
  const r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], {
    encoding: "utf-8",
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Processes whose command line names the scratch directory (a daemon that outlived `daemon stop`). */
function leftoverProcesses(): string[] {
  const listing = WIN
    ? spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
        ],
        { encoding: "utf-8" },
      )
    : spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf-8" });
  // the directory's own name is unique, and survives short (8.3) versus long Windows paths
  const needle = basename(root).toLowerCase();
  return (listing.stdout ?? "")
    .split("\n")
    .filter(
      (l) => l.toLowerCase().includes(needle) && !l.includes("registry-e2e.ts"),
    )
    .map((l) => l.trim());
}

let version = "";
process.on("uncaughtException", (e) => {
  fail(`unexpected error: ${e instanceof Error ? e.stack : String(e)}`);
  summary();
});
function summary(): never {
  if (process.env.FERN_E2E_KEEP) console.log(`kept ${root}`);
  else
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} problem(s):\n- ${failures.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(
    `\nregistry-e2e ok: context-fern@${version} on ${process.platform}-${process.arch}`,
  );
  process.exit(0);
}

// 1. resolve and install --------------------------------------------------
step(`resolve ${spec} and install from the real registry`);
let installDir = "";
const platform = platformPackage();
for (let attempt = 1; attempt <= INSTALL_TRIES; attempt++) {
  const v = run("npm", [
    "view",
    `context-fern@${spec}`,
    "version",
    "--prefer-online",
  ]);
  const lines = v.stdout.trim().split(NEWLINE);
  version = lines.length === 1 ? (lines[0] ?? "") : "";
  if (
    v.status === 0 &&
    version &&
    !/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version)
  ) {
    fail(
      `${spec} resolved to ${JSON.stringify(v.stdout.trim())}, not one exact version`,
    );
    summary();
  }
  if (v.status === 0 && version) {
    installDir = mkdtempSync(join(root, "npm-"));
    writeFileSync(
      join(installDir, "package.json"),
      '{"name":"e2e","private":true}\n',
    );
    const i = run(
      "npm",
      [
        "install",
        `context-fern@${version}`,
        "--prefer-online",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installDir, timeout: 300_000 },
    );
    const have = (n: string) =>
      existsSync(
        join(installDir, "node_modules", ...n.split("/"), "package.json"),
      );
    const missing = ["context-fern", "context-fern-model", platform].filter(
      (n) => !have(n),
    );
    const ok = i.status === 0 && missing.length === 0;
    console.log(
      `install attempt ${attempt}/${INSTALL_TRIES}: ${ok ? "ok" : `missing ${missing.join(", ") || "(npm failed)"}`}`,
    );
    if (ok) break;
  } else
    console.log(
      `install attempt ${attempt}/${INSTALL_TRIES}: ${spec} does not resolve yet`,
    );
  if (attempt === INSTALL_TRIES) {
    fail(
      `context-fern@${spec} did not install with its platform package after ${INSTALL_TRIES} attempts`,
    );
    summary();
  }
  sleep(INSTALL_EVERY_MS);
}
console.log(`installed context-fern@${version} (${platform})`);

const launcher = join(
  installDir,
  "node_modules",
  "context-fern",
  "bin",
  "launcher.js",
);
const printed = run("node", [launcher, "--version"]).stdout.trim();
if (printed !== version)
  fail(
    `launcher --version printed ${JSON.stringify(printed)}, expected ${version}`,
  );

// 2. init and doctor -------------------------------------------------------
step("init in a scratch profile");
run("git", ["init", "-q"], { cwd: project });
const pathBefore = registryPath();
const initArgs = [
  "init",
  "--yes",
  "--no-plugin",
  "--statusline",
  "yes",
  "--project-command",
  "yes",
];
if (addToPath) initArgs.push("--add-to-path");
const init = run("node", [launcher, ...initArgs], {
  cwd: project,
  timeout: 300_000,
});
console.log(init.stdout);
if (init.status !== 0) fail(`init exited ${init.status}: ${init.stderr}`);
if (addToPath) {
  const binDir = join(
    WIN
      ? join(env.LOCALAPPDATA as string, "context-fern")
      : join(userHome, ".local"),
    "bin",
  );
  const named = WIN
    ? registryPath() !== pathBefore
    : [".bashrc", ".bash_profile", ".zshrc", ".profile"].some((rc) => {
        const f = join(userHome, rc);
        return existsSync(f) && readFileSync(f, "utf-8").includes(binDir);
      });
  if (!named)
    fail("init --add-to-path did not put the install folder on the PATH");
}
const prefix = WIN
  ? join(env.LOCALAPPDATA as string, "context-fern")
  : join(userHome, ".local");
const installed = join(prefix, "bin", `context-fern${EXE}`);
for (const p of [
  installed,
  join(prefix, "bin", `fern${EXE}`),
  join(prefix, "share", "context-fern", "install-manifest.json"),
])
  if (!existsSync(p)) fail(`init did not leave ${p}`);
// FERN_HOME is where init looks for the user's .claude directory
const settings = join(fernHome, ".claude", "settings.json");
const statusLine = existsSync(settings)
  ? (
      JSON.parse(readFileSync(settings, "utf-8")) as {
        statusLine?: { command?: string };
      }
    ).statusLine
  : undefined;
if (statusLine?.command !== "context-fern statusline")
  fail(
    `init --statusline yes wrote the statusLine command ${JSON.stringify(statusLine?.command)}, expected "context-fern statusline"`,
  );
if (!existsSync(join(project, ".fern")))
  fail("init did not create .fern/ in the project");

step("doctor --json");
const doctor = run(installed, ["doctor", "--json"], { cwd: project });
let checks: { id: string; status: string; message: string }[] = [];
try {
  checks = (JSON.parse(doctor.stdout) as { checks: typeof checks }).checks;
} catch {
  fail(`doctor --json did not print JSON: ${doctor.stdout}${doctor.stderr}`);
}
for (const c of checks)
  console.log(`  ${c.status.padEnd(7)} ${c.id}: ${c.message}`);
// A scratch run may only complain about what this process cannot have: the
// install directory is not on the PATH of this shell, and `claude` is absent.
const unexpected = checks.filter(
  (c) => c.status === "problem" && !["context-fern", "plugin"].includes(c.id),
);
if (unexpected.length > 0)
  fail(`doctor reported problems: ${JSON.stringify(unexpected)}`);
for (const id of ["native library", "install"])
  if (checks.find((c) => c.id === id)?.status !== "ok")
    fail(`doctor check "${id}" is not ok`);

// 3. a scripted hook run ---------------------------------------------------
step("hooks against the scratch project");
const payload = (name: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    session_id: "registry-e2e",
    cwd: project,
    hook_event_name: name,
    ...extra,
  });
const hook = (name: string, extra: Record<string, unknown>) =>
  run(installed, ["hook", name], {
    cwd: project,
    input: payload(name, extra),
    timeout: 60_000,
  });

const start = hook("SessionStart", { source: "startup" });
if (start.status !== 0)
  fail(`SessionStart (startup) exited ${start.status}: ${start.stderr}`);

const made = run(installed, ["new", "registry-e2e-topic"], {
  cwd: project,
  timeout: 180_000,
});
console.log(made.stdout.trim());
if (made.status !== 0) fail(`new exited ${made.status}: ${made.stderr}`);

const prompt = hook("UserPromptSubmit", {
  prompt: "add a retry to the uploader",
});
if (prompt.status !== 0 || /"decision"\s*:\s*"block"/.test(prompt.stdout))
  fail(
    `UserPromptSubmit exited ${prompt.status} or blocked: ${prompt.stdout}${prompt.stderr}`,
  );

const restore = hook("SessionStart", { source: "compact" });
if (restore.status !== 0)
  fail(`SessionStart (compact) exited ${restore.status}: ${restore.stderr}`);
else if (!restore.stdout.includes("registry-e2e-topic"))
  fail(`the SessionStart restore did not mention the frond: ${restore.stdout}`);

// 4. daemon stop, uninstall, end state ---------------------------------------
step("daemon stop");
const infos = files(root).filter((f) => f.endsWith("daemon.json"));
let daemonPid = 0;
for (const f of infos) {
  try {
    daemonPid =
      Number(
        (JSON.parse(readFileSync(f, "utf-8")) as { pid?: number }).pid ?? 0,
      ) || daemonPid;
  } catch {}
}
if (infos.length === 0)
  fail("no daemon.json after the hook run: the daemon was never started");
else if (daemonPid === 0) fail("daemon.json has no readable pid");
const stop = run(installed, ["daemon", "stop"], { cwd: project });
console.log(stop.stdout.trim());
if (stop.status !== 0 || !/daemon stopped/.test(stop.stdout))
  fail(`daemon stop: exit ${stop.status}: ${stop.stdout}${stop.stderr}`);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (daemonPid > 0 && alive(daemonPid))
  fail(`daemon ${daemonPid} is still running after daemon stop`);
if (files(root).some((f) => f.endsWith("daemon.json")))
  fail("daemon.json is still there after daemon stop");
const settled = (): string[] => {
  let found = leftoverProcesses();
  for (let i = 0; i < 20 && found.length > 0; i++) {
    sleep(500);
    found = leftoverProcesses();
  }
  return found;
};
const afterStop = settled();
if (afterStop.length > 0)
  fail(`processes still running after daemon stop:\n${afterStop.join("\n")}`);

step("uninstall");
const un = run(installed, ["uninstall", "--yes", "--keep-plugin"], {
  cwd: project,
  timeout: 180_000,
});
console.log(un.stdout.trim());
if (un.status !== 0) fail(`uninstall exited ${un.status}: ${un.stderr}`);
// on Windows the running binary's last files are removed by a helper just after it exits
const ours = WIN ? prefix : join(prefix, "share", "context-fern");
for (let i = 0; i < 480 && existsSync(ours); i++) sleep(250);
if (existsSync(ours))
  fail(
    `${ours} is still there 120 s after uninstall:\n${files(ours).join("\n")}`,
  );
for (const exe of ["context-fern", "fern"])
  if (existsSync(join(prefix, "bin", `${exe}${EXE}`)))
    fail(
      `${join(prefix, "bin", `${exe}${EXE}`)} is still there after uninstall`,
    );
const afterUninstall = settled();
if (afterUninstall.length > 0)
  fail(
    `processes still running after uninstall:\n${afterUninstall.join("\n")}`,
  );
if (
  existsSync(settings) &&
  readFileSync(settings, "utf-8").includes("statusLine")
)
  fail("uninstall left the statusLine entry in settings.json");
if (WIN) {
  if (registryPath() !== pathBefore)
    fail(
      `the Windows user PATH changed: before ${pathBefore}, after ${registryPath()}`,
    );
} else {
  for (const rc of [".bashrc", ".bash_profile", ".zshrc", ".profile"]) {
    const f = join(userHome, rc);
    if (existsSync(f) && readFileSync(f, "utf-8").includes(join(prefix, "bin")))
      fail(`${rc} still names ${join(prefix, "bin")}`);
  }
}
// What is left is listed for the log. The npm cache, PowerShell's startup data
// and the shell files the runner itself wrote are not ours; data fern keeps by
// design (.fern/ in the project and in FERN_HOME) is reported by uninstall and
// is not an install file.
const notOurs = (f: string) =>
  f.startsWith(join(userHome, "AppData", "Local", "npm-cache")) ||
  f.startsWith(join(userHome, ".npm")) ||
  f.startsWith(join(userHome, "AppData", "Local", "Microsoft")) ||
  f.startsWith(join(fernHome, ".fern")) ||
  f === settings ||
  f.includes(
    `${join(fernHome, ".claude")}${SEP}settings.json.context-fern-uninstall-`,
  ) ||
  f.startsWith(join(userHome, ".claude"));
const left = [...files(userHome), ...files(fernHome)].filter(
  (f) => !notOurs(f),
);
console.log(
  `files left under the scratch profile after uninstall: ${left.length}`,
);
for (const f of left.slice(0, 40))
  console.log(`  ${f} (${statSync(f).size} bytes)`);
if (left.length > 0)
  fail("uninstall left files in the scratch profile (listed above)");

summary();
