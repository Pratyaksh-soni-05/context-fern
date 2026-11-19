// `fern doctor` — one line per check, each `ok` or a problem with the one thing
// to do about it. Exit code 0 when nothing is wrong, 1 on any problem; `--json`
// prints the same results as data.
//
// A check is a problem only when something the user relies on is broken: a
// daemon that is simply not running is not (it starts on the next prompt), but
// a missing model, a file that no longer matches the install manifest, a
// native library that fails its pinned checksum, a plugin that disagrees with
// the binary, or a `context-fern` that is not on PATH is.
//
// The Claude Code plugin is checked through the user's own `claude plugin list
// --json`; nothing here edits any file.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_VERSION,
  CONFIG_DIR,
  ENV_PREFIX,
} from "@context-fern/core";
import { type DaemonInfo, readDaemonInfo } from "@context-fern/daemon";
import { buildId } from "@context-fern/daemon/build-id";
import { isAlive } from "@context-fern/daemon/client";
import { modelCacheDir } from "@context-fern/embed/cache-dir";
import {
  checkModelFiles,
  type ModelProblem,
} from "@context-fern/embed/model-integrity";
import { nativePinsFor } from "@context-fern/embed/native-pins";
import { ownedKey } from "../install/binary";
import { sha256File } from "../install/hash";
import { installLayout } from "../install/layout";
import { type InstallManifest, readManifest } from "../install/manifest";
import {
  type CommandRunner,
  MARKETPLACE_NAME,
  makeRunner,
  PLUGIN_NAME,
} from "../install/plugin-setup";
import { classifyStatuslineCommand, settingsPath } from "./statusline";

export type CheckStatus = "ok" | "problem" | "info";

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  /** The one thing to do about a problem: a command, or a short instruction. */
  fix?: string;
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  cwd: string;
  execPath: string;
  /** Looks a command up on this process's PATH (explicit PATH: Bun.which otherwise answers from a snapshot). */
  which: (command: string) => string | null;
  runner: CommandRunner;
  readDaemon: () => Promise<DaemonInfo | null>;
  daemonAlive: (info: DaemonInfo) => Promise<boolean>;
  thisBuildId: () => string;
  checkModel: () => Promise<ModelProblem | null>;
  modelCacheDir: string;
  ollamaUrl: () => Promise<string | null>;
  pingOllama: (url: string) => Promise<boolean>;
}

async function readStage2OllamaUrl(cwd: string): Promise<string | null> {
  try {
    const text = await Bun.file(join(cwd, CONFIG_DIR, "config.toml")).text();
    const parsed = Bun.TOML.parse(text) as { stage2?: { ollama_url?: string } };
    if (!parsed.stage2) return null;
    return parsed.stage2.ollama_url ?? "http://localhost:11434";
  } catch {
    return null;
  }
}

async function pingOllama(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function realDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    cwd: process.cwd(),
    execPath: process.execPath,
    which: (c) => Bun.which(c, { PATH: process.env.PATH ?? "" }),
    // `claude plugin list` must never hold the doctor for long.
    runner: makeRunner(10_000),
    readDaemon: () => readDaemonInfo(),
    // Bounded: an unbounded fetch can hang well past any reasonable wait when
    // daemon.json names a port nothing valid listens on (docs/decisions.md).
    daemonAlive: (info) => isAlive(info, AbortSignal.timeout(2000)),
    thisBuildId: buildId,
    checkModel: () => checkModelFiles(),
    modelCacheDir: modelCacheDir(),
    ollamaUrl: () => readStage2OllamaUrl(process.cwd()),
    pingOllama,
  };
}

const ok = (id: string, message: string): Check => ({
  id,
  status: "ok",
  message,
});
const info = (id: string, message: string): Check => ({
  id,
  status: "info",
  message,
});
const problem = (id: string, message: string, fix: string): Check => ({
  id,
  status: "problem",
  message,
  fix,
});

// ---- the checks

async function daemonChecks(deps: DoctorDeps): Promise<Check[]> {
  const found = await deps.readDaemon();
  const alive = found ? await deps.daemonAlive(found) : false;
  if (!found || !alive) {
    return [
      info(
        "daemon",
        `not running — it starts on the next prompt, or run "${CLI_NAME} daemon start"`,
      ),
    ];
  }
  const checks: Check[] = [ok("daemon", "ok")];
  const mine = deps.thisBuildId();
  if (found.buildId !== mine) {
    checks.push(
      problem(
        "daemon build",
        `the running daemon is from a different build (${found.buildId}, this binary is ${mine})`,
        `${CLI_NAME} daemon stop`,
      ),
    );
  } else {
    checks.push(ok("daemon build", `matches this binary (${mine})`));
  }
  return checks;
}

async function modelCheck(deps: DoctorDeps): Promise<Check> {
  const p = await deps.checkModel();
  if (!p) return ok("model", "ok");
  const what = p.kind === "missing" ? "missing" : "failed its checksum";
  return problem(
    "model",
    `${what} (${p.path}) — suggestions are limited to cue phrases`,
    isShippedInstall(deps)
      ? `${CLI_BINARY_NAME} init`
      : 'from a source checkout run "bun run scripts/fetch-model.ts"',
  );
}

function isShippedInstall(deps: DoctorDeps): boolean {
  const name = deps.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /^(context-fern|fern)(\.exe)?$/.test(name);
}

async function manifestCheck(manifest: InstallManifest | null): Promise<Check> {
  if (manifest === null) {
    return info(
      "install",
      `no install manifest (not installed with "${CLI_BINARY_NAME} init", or a source checkout), so the installed files are not checked`,
    );
  }
  const missing: string[] = [];
  const changed: string[] = [];
  for (const f of manifest.files) {
    if (!existsSync(f.path)) {
      missing.push(f.path);
      continue;
    }
    try {
      if ((await sha256File(f.path)) !== f.sha256) changed.push(f.path);
    } catch {
      changed.push(f.path);
    }
  }
  if (missing.length + changed.length === 0) {
    return ok(
      "install",
      `${manifest.files.length} files match the install manifest`,
    );
  }
  const parts: string[] = [];
  if (missing.length)
    parts.push(
      `missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`,
    );
  if (changed.length)
    parts.push(
      `changed since install: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""}`,
    );
  return problem("install", parts.join(" · "), `${CLI_BINARY_NAME} init`);
}

function pathCheck(deps: DoctorDeps, manifest: InstallManifest | null): Check {
  const found = deps.which(CLI_BINARY_NAME);
  const label = CLI_BINARY_NAME;
  if (manifest === null) {
    // No install manifest: a source checkout, or an install made some other way.
    return found
      ? ok(label, `on PATH (${found})`)
      : problem(
          label,
          "not on PATH — the plugin's hooks and MCP server cannot start",
          'from a source checkout run "bun link --global" in packages/cli',
        );
  }
  const installed = join(
    manifest.binDir,
    `${CLI_BINARY_NAME}${deps.platform === "win32" ? ".exe" : ""}`,
  );
  if (found && ownedKey(found) === ownedKey(installed)) {
    return ok(label, `on PATH (${found})`);
  }
  if (found) {
    return problem(
      label,
      `on PATH, but it is another copy (${found}), not the one init installed (${installed})`,
      `put ${manifest.binDir} before ${dirname(found)} on PATH, or remove the other copy`,
    );
  }
  if (manifest.pathEdit) {
    return problem(
      label,
      `${manifest.binDir} was added to PATH by init, but this terminal does not have it yet`,
      "open a new terminal",
    );
  }
  return problem(
    label,
    `${manifest.binDir} is not on PATH — the plugin's hooks and MCP server cannot start (prompts pass through untouched)`,
    `${CLI_BINARY_NAME} init --add-to-path`,
  );
}

async function pluginCheck(deps: DoctorDeps): Promise<Check> {
  const claude = deps.which("claude");
  if (claude === null) {
    return info(
      "plugin",
      "the claude command was not found, so the Claude Code plugin was not checked",
    );
  }
  const r = await deps.runner(claude, ["plugin", "list", "--json"]);
  if (!r.ok) {
    return info(
      "plugin",
      "could not read `claude plugin list`, so the plugin was not checked",
    );
  }
  let list: { id?: unknown; version?: unknown; enabled?: unknown }[];
  try {
    list = JSON.parse(r.output.slice(r.output.indexOf("["))) as typeof list;
  } catch {
    return info(
      "plugin",
      "could not read `claude plugin list`, so the plugin was not checked",
    );
  }
  const mine = Array.isArray(list)
    ? list.find((p) => p.id === `${PLUGIN_NAME}@${MARKETPLACE_NAME}`)
    : undefined;
  if (!mine) {
    return info(
      "plugin",
      `not installed in Claude Code · to add it: ${CLI_BINARY_NAME} init --yes`,
    );
  }
  const id = String(mine.id);
  if (mine.enabled === false) {
    return problem(
      "plugin",
      `${id} is installed but disabled`,
      `claude plugin enable ${id}`,
    );
  }
  if (mine.version !== CLI_VERSION) {
    return problem(
      "plugin",
      `${id} is version ${String(mine.version)} but this binary is ${CLI_VERSION}`,
      `claude plugin update ${id}  (then restart Claude Code)`,
    );
  }
  return ok("plugin", `${id} ${CLI_VERSION} matches this binary`);
}

/** The same two places the patched onnxruntime lookup tries, in the same order. */
function sidecarDirs(deps: DoctorDeps): string[] {
  const exeDir = dirname(deps.execPath);
  const rel = join("onnxruntime-native", `${deps.platform}-${deps.arch}`);
  return [join(exeDir, rel), join(exeDir, "..", "share", CLI_BINARY_NAME, rel)];
}

async function nativeCheck(deps: DoctorDeps): Promise<Check> {
  if (!isShippedInstall(deps)) {
    return info(
      "native library",
      "running from a source checkout, which uses the package's own binding; not checked",
    );
  }
  const pins = nativePinsFor(deps.platform, deps.arch);
  if (!pins) {
    return info(
      "native library",
      `${deps.platform}-${deps.arch} is not a shipped platform; not checked`,
    );
  }
  const dir = sidecarDirs(deps).find((d) =>
    existsSync(join(d, "onnxruntime_binding.node")),
  );
  if (!dir) {
    return problem(
      "native library",
      `the native runtime files were not found next to ${deps.execPath}`,
      `${CLI_BINARY_NAME} init`,
    );
  }
  const bad: string[] = [];
  for (const [file, pinned] of Object.entries(pins)) {
    const p = join(dir, file);
    try {
      if ((await sha256File(p)) !== pinned) bad.push(file);
    } catch {
      bad.push(`${file} (unreadable)`);
    }
  }
  return bad.length === 0
    ? ok(
        "native library",
        `${Object.keys(pins).length} files match their pinned checksums (${dir})`,
      )
    : problem(
        "native library",
        `${bad.join(", ")} in ${dir} do not match their pinned checksums, so the model will not load`,
        `${CLI_BINARY_NAME} init`,
      );
}

async function statuslineCheck(deps: DoctorDeps): Promise<Check> {
  const file = settingsPath(deps.env[`${ENV_PREFIX}HOME`] || deps.home);
  let command: unknown;
  try {
    const settings = JSON.parse(await Bun.file(file).text()) as {
      statusLine?: { command?: unknown };
    };
    if (!settings.statusLine) return info("statusline", "not set up");
    command = settings.statusLine.command;
  } catch {
    return info("statusline", "not set up");
  }
  const kind = classifyStatuslineCommand(command);
  if (kind === "current") return ok("statusline", `ok (${String(command)})`);
  if (kind === "legacy-bun") {
    return problem(
      "statusline",
      "the statusLine in your Claude Code settings is the old form that runs `bun` from a repository path, which an installed binary cannot run",
      `in ${file} set statusLine.command to "${CLI_BINARY_NAME} statusline"`,
    );
  }
  return info(
    "statusline",
    "the statusLine in your Claude Code settings is not fern's; left alone",
  );
}

async function ollamaCheck(deps: DoctorDeps): Promise<Check> {
  const url = await deps.ollamaUrl();
  if (!url) return info("stage2 (Ollama)", "not configured, skipping");
  const reachable = await deps.pingOllama(url);
  return reachable
    ? ok(`stage2 (Ollama at ${url})`, "ok")
    : problem(
        `stage2 (Ollama at ${url})`,
        "unreachable",
        "start Ollama, or remove [stage2] from .fern/config.toml",
      );
}

/** A check that throws is reported as a problem of its own, never allowed to abort the whole report. */
async function guarded(
  id: string,
  run: () => Promise<Check | Check[]>,
): Promise<Check[]> {
  try {
    const r = await run();
    return Array.isArray(r) ? r : [r];
  } catch (err) {
    return [
      problem(
        id,
        `could not be checked (${err instanceof Error ? err.message : String(err)})`,
        `${CLI_BINARY_NAME} init`,
      ),
    ];
  }
}

export async function collectChecks(deps: DoctorDeps): Promise<Check[]> {
  const layout = installLayout({
    platform: deps.platform,
    env: deps.env,
    home: deps.home,
  });
  let manifest: InstallManifest | null = null;
  try {
    manifest = await readManifest(layout.manifestPath);
  } catch {
    manifest = null;
  }
  return [
    ...(await guarded("daemon", () => daemonChecks(deps))),
    ...(await guarded("model", () => modelCheck(deps))),
    ...(await guarded("install", () => manifestCheck(manifest))),
    ...(await guarded(CLI_BINARY_NAME, async () => pathCheck(deps, manifest))),
    ...(await guarded("native library", () => nativeCheck(deps))),
    ...(await guarded("plugin", () => pluginCheck(deps))),
    ...(await guarded("statusline", () => statuslineCheck(deps))),
    ...(await guarded("stage2 (Ollama)", () => ollamaCheck(deps))),
  ];
}

export async function runDoctor(
  flags: Record<string, string> = {},
  deps: DoctorDeps = realDoctorDeps(),
): Promise<number> {
  const checks = await collectChecks(deps);
  const problems = checks.filter((c) => c.status === "problem");
  if (flags.json === "true") {
    console.log(JSON.stringify({ ok: problems.length === 0, checks }));
    return problems.length === 0 ? 0 : 1;
  }
  const lines = checks.map(
    (c) => `${c.id}: ${c.message}${c.fix ? ` · fix: ${c.fix}` : ""}`,
  );
  lines.push(
    problems.length === 0
      ? "all checks passed"
      : `${problems.length} problem${problems.length === 1 ? "" : "s"} found`,
  );
  console.log(lines.map((l) => `${CLI_NAME} ▸ ${l}`).join("\n"));
  return problems.length === 0 ? 0 : 1;
}
