// The machine-wide half of `context-fern init`: put the binary and its
// sidecar in a stable per-user directory, put the model in the OS cache,
// get that directory on PATH (only with the user's say-so), register the
// Claude Code plugin (also with their say-so), and write an install
// manifest so `fern uninstall` can later remove exactly this.
//
// Idempotent: a second run finds everything in place and says so. Run
// from a source checkout (`bun run`) it installs nothing. The project
// half (`.fern/`, .gitignore, statusline) stays in commands/init.ts.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME, CLI_VERSION } from "@context-fern/core";
import { modelCacheDir } from "@context-fern/embed/cache-dir";
import { DEFAULT_MODEL_ID } from "@context-fern/embed/model-integrity";
import { promptYesNo } from "../prompt-yes-no";
import {
  canonicalKey,
  installBinary,
  isAlreadyInstalled,
  locateBinarySource,
  sweepPending,
} from "./binary";
import { type InstallLayout, installLayout } from "./layout";
import {
  type InstallManifest,
  type ManifestFile,
  type PendingDelete,
  readManifest,
  sha256File,
  writeManifest,
} from "./manifest";
import { findModelPayload, installModel } from "./model";
import {
  addToShellRc,
  addToWindowsUserPath,
  isOnPath,
  PATH_NOTIFICATION_NOTE,
  pathFixCommand,
  RC_BEGIN,
  RC_END,
  shellRcFile,
} from "./path-setup";
import { type CommandRunner, setUpPlugin } from "./plugin-setup";
import type { LeftAlone } from "./safe-remove";

export interface GlobalInitDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  execPath: string;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  log: (line: string) => void;
  which: (command: string) => string | null;
  runner?: CommandRunner;
  now: () => Date;
  modelCacheDir: string;
  addToWindowsPath: typeof addToWindowsUserPath;
}

export function realDeps(): GlobalInitDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: promptYesNo,
    log: (line) => console.log(line),
    which: (c) => Bun.which(c),
    now: () => new Date(),
    modelCacheDir: modelCacheDir(),
    addToWindowsPath: addToWindowsUserPath,
  };
}

const say = (line: string) => `${CLI_NAME} ▸ ${line}`;

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

export interface GlobalInitResult {
  layout: InstallLayout;
  installedBinary: boolean;
  onPath: boolean;
}

export async function runGlobalInit(
  flags: Record<string, string>,
  deps: GlobalInitDeps = realDeps(),
): Promise<GlobalInitResult> {
  const { log, env, platform } = deps;
  const layout = installLayout({ platform, env, home: deps.home });
  const noInstall = flags["no-install"] === "true";
  const confined = confineToInstallDirs(
    await readManifest(layout.manifestPath),
    [layout.binDir, layout.shareDir, deps.modelCacheDir],
    log,
  );
  const previous = confined.manifest;
  const files: ManifestFile[] = [];
  let installedBinary = false;
  let pathEdit = previous?.pathEdit ?? null;
  let plugin = previous?.plugin ?? null;
  let pending: PendingDelete[] = [];
  const createdDirs: string[] = [...(previous?.createdDirs ?? [])];
  const addDirs = (dirs: readonly string[]) => {
    for (const d of dirs) if (!createdDirs.includes(d)) createdDirs.push(d);
  };
  const reportLeftAlone = (items: readonly LeftAlone[]) => {
    for (const l of items) {
      log(
        say(
          `left ${l.path} alone (${l.reason.replaceAll("-", " ")}) · it is never deleted unless it still matches what init recorded`,
        ),
      );
    }
  };

  // 1. The binary and its native sidecar.
  let source = null as ReturnType<typeof locateBinarySource>;
  try {
    source = locateBinarySource(deps.execPath);
  } catch (err) {
    log(say(`could not install: ${(err as Error).message}`));
    throw err;
  }
  if (source === null) {
    // A source checkout (or a test) is not a shipped install: touch
    // nothing outside the project — no files, no PATH, no plugin.
    log(
      say(
        `running from a source checkout, so no machine-wide install · link it with "bun link --global" in packages/cli`,
      ),
    );
    return { layout, installedBinary: false, onPath: false };
  }
  // Files an earlier run moved aside and could not delete: each goes only if it still has its recorded hash.
  const swept = await sweepPending(previous?.pendingDeletes ?? []);
  pending = swept.remaining;
  reportLeftAlone(swept.leftAlone);
  const carried = (previous?.files ?? []).filter((f) => f.role !== "model");
  const save = async () => {
    const manifest: InstallManifest = {
      schema: 1,
      version: CLI_VERSION,
      installedAt: previous?.installedAt ?? deps.now().toISOString(),
      platform: `${platform}-${process.arch}`,
      prefix: layout.prefix,
      binDir: layout.binDir,
      shareDir: layout.shareDir,
      // Entries outside the install directories are never acted on, but they
      // stay in the manifest, so an uninstall can still see them.
      files: [...files, ...confined.ignoredFiles],
      ...(pending.length + confined.ignoredPending.length > 0
        ? { pendingDeletes: [...pending, ...confined.ignoredPending] }
        : {}),
      ...(createdDirs.length > 0 ? { createdDirs } : {}),
      ...(previous?.statusline ? { statusline: previous.statusline } : {}),
      pathEdit,
      plugin,
    };
    await writeManifest(layout.manifestPath, manifest);
  };
  if (noInstall) {
    files.push(...carried);
    log(say("skipped installing the binary (--no-install)"));
  } else if (isAlreadyInstalled(deps.execPath, layout)) {
    log(say(`${CLI_BINARY_NAME} is already installed in ${layout.binDir}`));
    files.push(...carried);
  } else {
    try {
      const r = await installBinary(source, layout, carried);
      files.push(...r.entries);
      pending.push(...r.pending);
      addDirs(r.createdDirs);
      reportLeftAlone(r.leftAlone);
    } catch (err) {
      log(say(`could not install: ${(err as Error).message}`));
      throw err;
    }
    installedBinary = true;
    await save();
    log(
      say(
        `installed ${CLI_BINARY_NAME} and ${CLI_NAME} to ${layout.binDir} (${CLI_VERSION})`,
      ),
    );
  }

  // 2. The embedding model, from the model package into the OS cache.
  const payload = findModelPayload(env, deps.execPath);
  const model = await installModel(payload, deps.modelCacheDir);
  if (model.state === "already-installed") {
    // Not ours to remove unless an earlier init put it there.
    files.push(...(previous?.files ?? []).filter((f) => f.role === "model"));
  }
  if (model.state === "installed") {
    addDirs(model.createdDirs);
    const dir = join(deps.modelCacheDir, DEFAULT_MODEL_ID);
    for (const p of (await listFiles(dir)).sort()) {
      files.push({
        path: p,
        sha256: await sha256File(p),
        bytes: Bun.file(p).size,
        role: "model",
      });
    }
    log(say(`installed the embedding model in ${deps.modelCacheDir}`));
  } else if (model.state === "already-installed") {
    log(say(`the embedding model is already in ${deps.modelCacheDir}`));
  } else if (model.state === "no-payload") {
    log(
      say(
        `no embedding model found · suggestions are limited to cue phrases · reinstall ${CLI_BINARY_NAME} with the same command to get it`,
      ),
    );
  } else {
    log(say(`the embedding model could not be installed: ${model.reason}`));
  }

  await save();

  // 3. PATH — never silently, and --yes alone does not edit it.
  const haveBinary = installedBinary || !noInstall;
  const onPath = isOnPath(layout.binDir, env, platform);
  if (haveBinary || pathEdit !== null) {
    if (onPath) {
      log(say(`${layout.binDir} is on your PATH`));
    } else {
      const wantsEdit =
        flags["add-to-path"] === "true" ||
        (deps.interactive &&
          flags.no !== "true" &&
          flags["no-path"] !== "true" &&
          flags.yes !== "true" &&
          (await deps.ask(`Add ${layout.binDir} to your PATH?`)));
      if (wantsEdit && pathEdit === null) {
        try {
          if (platform === "win32") {
            let notificationFailed = false;
            const r = await deps.addToWindowsPath(layout.binDir, {
              onNotificationFailed: () => {
                notificationFailed = true;
              },
            });
            if (r === "already") {
              log(
                say(
                  `${layout.binDir} was already in your user PATH, so nothing was changed`,
                ),
              );
            } else {
              pathEdit = r;
              log(say(`added ${layout.binDir} to your user PATH`));
              if (notificationFailed) log(say(PATH_NOTIFICATION_NOTE));
            }
          } else {
            const rc = shellRcFile(env, deps.home, platform);
            if (rc === null) {
              log(
                say(
                  `could not tell which shell you use · add it yourself: ${pathFixCommand(layout.binDir, platform, env)}`,
                ),
              );
            } else {
              const r = await addToShellRc(rc.file, layout.binDir);
              if (r === "already") {
                // Our own marked block: ours to remove later, even if an earlier manifest was lost.
                pathEdit = {
                  kind: "shell-rc",
                  file: rc.file,
                  beginMarker: RC_BEGIN,
                  endMarker: RC_END,
                };
                log(
                  say(
                    `${rc.file} already has the PATH block, so nothing was changed`,
                  ),
                );
              } else {
                pathEdit = r;
                log(say(`added ${layout.binDir} to PATH in ${rc.file}`));
              }
            }
          }
          await save();
          log(say("open a new terminal for the PATH change to take effect"));
        } catch (err) {
          log(
            say(
              `could not change PATH (${(err as Error).message}) · ${pathFixCommand(layout.binDir, platform, env)}`,
            ),
          );
        }
      } else if (pathEdit !== null) {
        log(
          say(
            "PATH is set up, but this terminal predates it · open a new terminal",
          ),
        );
      } else {
        log(
          say(
            `${layout.binDir} is not on your PATH · until it is, ${CLI_NAME} hooks do not run and your prompts pass through untouched · to fix it: ${pathFixCommand(layout.binDir, platform, env)} · or run init again with --add-to-path`,
          ),
        );
      }
    }
  }

  // 4. The Claude Code plugin, through the user's own `claude` CLI.
  if (flags["no-plugin"] === "true" || flags.no === "true") {
    log(say("skipped the Claude Code plugin"));
  } else if (plugin?.method === "claude-cli") {
    log(say("the Claude Code plugin is already installed"));
  } else {
    const consent =
      flags.yes === "true" ||
      (deps.interactive &&
        (await deps.ask(
          "Register the Claude Code plugin with your claude command?",
        )));
    if (!consent) {
      log(
        say("skipped the Claude Code plugin (run init with --yes to add it)"),
      );
    } else {
      const claude = deps.which("claude");
      if (claude !== null) log(say(`running ${claude}`));
      const result = await setUpPlugin(claude, deps.runner);
      plugin = result.record;
      if (result.state === "installed") {
        log(say("installed the Claude Code plugin · restart Claude Code"));
      } else {
        log(say(`Claude Code plugin not installed: ${result.reason}`));
        for (const step of result.steps) log(`        ${step}`);
      }
    }
  }

  // 5. The manifest, so uninstall can be exact (also written after each side effect above).
  // Always: the plugin step may have registered something even when no file was installed.
  await save();
  return { layout, installedBinary, onPath };
}

/**
 * The manifest is a file on disk the user could have edited, and deletion
 * is driven by it, so an entry that points outside the directories init
 * installs into (the bin dir, the share dir, the model cache) is ignored
 * and reported rather than ever being acted on.
 */
/** What init may act on, plus the entries it must not act on but must not forget either. */
export interface ConfinedManifest {
  manifest: InstallManifest | null;
  ignoredFiles: ManifestFile[];
  ignoredPending: PendingDelete[];
}

export function confineToInstallDirs(
  manifest: InstallManifest | null,
  roots: readonly string[],
  log: (line: string) => void,
): ConfinedManifest {
  if (manifest === null) {
    return {
      manifest: null,
      ignoredFiles: [],
      ignoredPending: [],
    };
  }
  // A path is inside if it is inside lexically OR once its directory is
  // resolved through symlinks and short names: the same location spelled
  // differently (8.3 name, /var vs /private/var, a symlinked prefix) must
  // not be dropped. `..` segments are removed by resolve() first.
  const lexical = (p: string) =>
    (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p)) +
    sep;
  const inside = (p: string) =>
    roots.some(
      (r) =>
        lexical(p).startsWith(lexical(r)) ||
        canonicalKey(p).startsWith(canonicalKey(r) + sep),
    );
  const split = <T extends { path: string }>(
    items: readonly T[] | undefined,
  ) => {
    const keep: T[] = [];
    const ignored: T[] = [];
    for (const it of items ?? []) {
      if (inside(it.path)) keep.push(it);
      else {
        ignored.push(it);
        log(
          say(
            `ignored a manifest entry outside the install directories (${it.path}) · nothing there is touched, and the entry is kept`,
          ),
        );
      }
    }
    return { keep, ignored };
  };
  const files = split(manifest.files);
  const pending = split(manifest.pendingDeletes);
  // `createdDirs` is deliberately not confined: directories init made can sit
  // above the install roots (a fresh ~/.cache, the share directory's parent),
  // and an uninstall only ever `rmdir`s them while empty.
  return {
    manifest: { ...manifest, files: files.keep, pendingDeletes: pending.keep },
    ignoredFiles: files.ignored,
    ignoredPending: pending.ignored,
  };
}

/** `context-fern init` from the home directory (or a filesystem root) must not create a project `.fern/` there: `~/.fern` is where the daemon keeps its own state. */
export function shouldRunProjectInit(
  cwd: string,
  home: string,
  flags: Record<string, string>,
): boolean {
  if (flags["no-project"] === "true") return false;
  const norm = (p: string) =>
    resolve(p)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  if (norm(cwd) === norm(home)) return false;
  return resolve(cwd, "..") !== resolve(cwd);
}
