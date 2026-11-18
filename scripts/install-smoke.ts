// Installs the packed release files the way a user would, from LOCAL files
// only (nothing is fetched, nothing published), then runs `context-fern
// init` and the compiled-binary smoke test against the copy init installed.
//
//   bun scripts/install-smoke.ts --kind npm|pip|uvx --packages <dir>
//   (<dir> holds npm/*.tgz and pypi/*.whl, as the release workflow lays them out)
//
// Everything is redirected into a temporary directory (install prefix,
// FERN_HOME, the model cache), so a developer can run it without touching
// their real install, PATH or Claude settings. `--no-plugin` and explicit
// `--statusline no --project-command no` keep init from reaching outside.
//
// Prints a timing table. It excludes registry download time (the files
// are already on disk) and CI runners are not clean user machines, so it
// bounds the 2-minute launch gate (docs/spec.md §16) from below only.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const kind = arg("kind");
const packages = resolve(arg("packages"));
if (!["npm", "pip", "uvx"].includes(kind))
  throw new Error(`unknown --kind ${kind}`);

const scratch = mkdtempSync(join(tmpdir(), "fern-install-smoke-"));
const prefix = join(scratch, "prefix");
const home = join(scratch, "home");
const project = join(scratch, "project");
const userHome = join(scratch, "userhome");
for (const d of [home, project, userHome]) mkdirSync(d, { recursive: true });

// The model cache follows the OS conventions (packages/embed/src/cache-dir.ts):
// point each variable it reads at the scratch directory.
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  FERN_INSTALL_PREFIX: prefix,
  FERN_HOME: home,
  HOME: userHome,
  USERPROFILE: userHome,
  LOCALAPPDATA: join(userHome, "AppData", "Local"),
  XDG_CACHE_HOME: join(userHome, ".cache"),
};

function run(
  label: string,
  cmd: string,
  args: string[],
  cwd = scratch,
): string {
  const shell = WIN && /\.cmd$|^npm$/i.test(cmd);
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf-8",
    shell,
    timeout: 300_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    console.error(
      `FAIL ${label}: exit ${r.status}${r.error ? ` (${r.error.message})` : ""}\n${out}`,
    );
    process.exit(1);
  }
  return out;
}

const timings: [string, number][] = [];
function timed<T>(label: string, fn: () => T): T {
  const t = performance.now();
  const v = fn();
  timings.push([label, (performance.now() - t) / 1000]);
  return v;
}

const npmDir = join(packages, "npm");
const pypiDir = join(packages, "pypi");
const find = (re: RegExp) => {
  const f = readdirSync(npmDir).filter((n) => re.test(n));
  if (f.length === 0) throw new Error(`no file matching ${re} in ${npmDir}`);
  return f.map((n) => join(npmDir, n));
};

const INIT_ARGS = [
  "init",
  "--yes",
  "--no-plugin",
  "--statusline",
  "no",
  "--project-command",
  "no",
];
let initCmd: [string, string[]];

timed("install from local files", () => {
  if (kind === "npm") {
    const osName: Record<string, string> = {
      win32: "win",
      linux: "linux",
      darwin: "darwin",
    };
    const platform = `${osName[process.platform]}-${process.arch}`;
    const dir = join(scratch, "npm");
    mkdirSync(dir, { recursive: true });
    run("npm init", "npm", ["init", "-y"], dir);
    run(
      "npm install",
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--offline",
        ...find(/^context-fern-model-.*\.tgz$/),
        ...find(new RegExp(`^context-fern-${platform}-.*\\.tgz$`)),
        ...find(/^context-fern-\d.*\.tgz$/),
      ],
      dir,
    );
    initCmd = [
      join(
        dir,
        "node_modules",
        ".bin",
        WIN ? "context-fern.cmd" : "context-fern",
      ),
      INIT_ARGS,
    ];
  } else if (kind === "pip") {
    const venv = join(scratch, "venv");
    run("venv", "python", ["-m", "venv", venv]);
    const py = join(venv, WIN ? "Scripts/python.exe" : "bin/python");
    run("pip install", py, [
      "-m",
      "pip",
      "install",
      "--no-index",
      "--find-links",
      pypiDir,
      "context-fern",
    ]);
    initCmd = [
      join(venv, WIN ? "Scripts" : "bin", `context-fern${EXE}`),
      INIT_ARGS,
    ];
  } else {
    initCmd = [
      "uvx",
      [
        "--no-cache",
        "--no-index",
        "--find-links",
        pypiDir,
        "--from",
        "context-fern",
        "context-fern",
        ...INIT_ARGS,
      ],
    ];
  }
});

const initOut = timed("context-fern init", () =>
  run("init", initCmd[0], initCmd[1], project),
);
console.log(initOut);
if (!initOut.includes("installed context-fern and fern to")) {
  console.error("FAIL: init did not report installing the binary");
  process.exit(1);
}

const installed = join(prefix, "bin", `context-fern${EXE}`);
for (const p of [
  installed,
  join(prefix, "bin", `fern${EXE}`),
  join(prefix, "share", "context-fern", "install-manifest.json"),
]) {
  if (!existsSync(p)) {
    console.error(`FAIL: init did not leave ${p}`);
    process.exit(1);
  }
}
const manifest = JSON.parse(
  readFileSync(
    join(prefix, "share", "context-fern", "install-manifest.json"),
    "utf-8",
  ),
) as {
  files: { role: string }[];
  pathEdit: unknown;
};
const roles = new Set(manifest.files.map((f) => f.role));
if (
  !(roles.has("binary") && roles.has("sidecar") && roles.has("model")) ||
  manifest.pathEdit !== null
) {
  console.error(
    `FAIL: unexpected manifest: roles=${[...roles]} pathEdit=${JSON.stringify(manifest.pathEdit)}`,
  );
  process.exit(1);
}
console.log(`version: ${run("version", installed, ["--version"]).trim()}`);

// Re-running init from the installed copy finds everything in place.
const again = run("init again", installed, INIT_ARGS, project);
if (!again.includes("already installed")) {
  console.error(
    `FAIL: a second init did not say "already installed":\n${again}`,
  );
  process.exit(1);
}

// A hook with no daemon running passes the prompt through: exit 0, no block.
const hook = spawnSync(installed, ["hook", "UserPromptSubmit"], {
  cwd: project,
  env,
  input: JSON.stringify({ prompt: "hello", cwd: project, session_id: "smoke" }),
  encoding: "utf-8",
  timeout: 30_000,
});
if (hook.status !== 0 || /"decision"\s*:\s*"block"/.test(hook.stdout ?? "")) {
  console.error(`FAIL: hook exit ${hook.status}: ${hook.stdout}${hook.stderr}`);
  process.exit(1);
}

let coldMs = Number.NaN;
let warmMs = Number.NaN;
timed("first frond (smoke-test: sqlite, embedding, daemon, ui)", () => {
  const r = spawnSync(
    "bun",
    ["run", join(import.meta.dir, "smoke-test.ts"), installed],
    { env, encoding: "utf-8", timeout: 300_000 },
  );
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status !== 0) {
    console.error("FAIL: smoke test against the installed binary");
    process.exit(1);
  }
  coldMs = Number(/DAEMON_COLD_START_MS: (\d+)/.exec(r.stdout ?? "")?.[1]);
  warmMs = Number(/WARM_CALL_MS: (\d+)/.exec(r.stdout ?? "")?.[1]);
});

console.log(`\n${kind} install smoke: PASS`);
for (const [label, s] of timings)
  console.log(`  ${s.toFixed(1).padStart(6)} s  ${label}`);
console.log(
  `  ${String(coldMs).padStart(6)} ms daemon cold start (fern new spawns it; the CLI gives up at about 5000 ms)`,
);
console.log(
  `  ${String(warmMs).padStart(6)} ms a warm call to that daemon (fern status)`,
);
rmSync(scratch, { recursive: true, force: true });
