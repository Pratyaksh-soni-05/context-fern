// `context-fern uninstall`: removes exactly what `context-fern init` recorded in
// the install manifest, and nothing else.
//
// The rule is the one every delete in install code follows (safe-remove.ts):
// a file goes only if it is a regular file whose SHA-256 still equals the one
// recorded; anything modified, replaced, unlisted or not a regular file is
// left alone and reported; directories go only by `rmdir` while empty. It
// never touches a project's `.fern/` folder or fern.db, or `~/.fern`: it
// prints where that data lives and the one command that deletes it, and the
// user runs it (docs/decisions.md, 2026-11-18). Running it twice is safe: the
// second run finds no manifest and says so.
//
// Order: plugin, statusline, PATH, daemon, files, manifest, directories, then
// (Windows only) a hash-checked helper for our own running exe.

import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CONFIG_DIR,
  ENV_PREFIX,
  NPM_PACKAGE,
  PYPI_PACKAGE,
} from "@context-fern/core";
import {
  type StopResult,
  stopRunningDaemon,
} from "@context-fern/daemon/client";
import { modelCacheDir } from "@context-fern/embed/cache-dir";
import { isAlreadyInstalled, ownedKey, sweepPending } from "./binary";
import { confineToInstallDirs } from "./global-init";
import { sha256File } from "./hash";
import { type InstallLayout, installLayout } from "./layout";
import {
  type InstallManifest,
  type ManifestFile,
  type PendingDelete,
  writeManifest,
} from "./manifest";
import { type CommandRunner, defaultRunner, PLUGIN_NAME } from "./plugin-setup";
import { removeEmptyDir, removeIfHash } from "./safe-remove";
import {
  removeFromWindowsUserPath,
  removeShellRcBlock,
  removeStatuslineEntry,
} from "./uninstall-path";
import { manualRemoveCommand, startDeleteHelper } from "./windows-self-delete";

export interface UninstallDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  execPath: string;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  log: (line: string) => void;
  which: (command: string) => string | null;
  runner?: CommandRunner;
  stopDaemon: () => Promise<StopResult>;
  removeWindowsPath: typeof removeFromWindowsUserPath;
  startHelper: typeof startDeleteHelper;
  modelCacheDir: string;
}

export interface UninstallReport {
  state: "nothing-to-do" | "refused" | "dry-run" | "done";
  removed: string[];
  alreadyGone: string[];
  leftAlone: { path: string; reason: string }[];
  failed: { what: string; error: string }[];
  /** Removed by a helper after this process exits (Windows, our own running exe). */
  scheduled: string[];
  /** Commands the user may need to run by hand. */
  manual: string[];
  /** Where user data lives; never touched. */
  dataLocations: string[];
  exitCode: number;
}

const say = (line: string) => `${CLI_NAME} ▸ ${line}`;

const quotePosix = (p: string) => `'${p.replaceAll("'", `'\\''`)}'`;
// PowerShell treats U+2018, U+2019, U+201A and U+201B as single quotes too.
const quotePs = (p: string) => `'${p.replace(/['‘’‚‛]/g, (c) => c + c)}'`;

/** Per-project `.fern/` folders (from the recent-projects list) and the user-level `~/.fern`. Read only. */
export async function dataLocations(
  env: Record<string, string | undefined>,
  home: string,
): Promise<string[]> {
  const fernHome = join(env[`${ENV_PREFIX}HOME`] || home, CONFIG_DIR);
  const out: string[] = [];
  try {
    const parsed = JSON.parse(
      await readFile(join(fernHome, "projects.json"), "utf-8"),
    ) as { projects?: { path?: unknown }[] };
    for (const p of parsed.projects ?? []) {
      if (typeof p.path !== "string") continue;
      const dir = join(p.path, CONFIG_DIR);
      if (existsSync(dir) && !out.includes(dir)) out.push(dir);
    }
  } catch {
    // no recent-projects list: nothing more to list
  }
  if (existsSync(fernHome)) out.push(fernHome);
  return out;
}

/** The single command, for this OS, that deletes the data. Printed, never run. */
export function dataDeleteCommand(
  platform: NodeJS.Platform,
  paths: readonly string[],
): string {
  return platform === "win32"
    ? `Remove-Item -Recurse -Force -LiteralPath ${paths.map(quotePs).join(", ")}   # in PowerShell`
    : `rm -rf -- ${paths.map(quotePosix).join(" ")}`;
}

function packageCommands(): string[] {
  return [
    `npm rm -g ${NPM_PACKAGE}   # if you installed with npm`,
    `pip uninstall ${PYPI_PACKAGE} ${PYPI_PACKAGE}-model   # if you installed with pip`,
  ];
}

type ManifestRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "newer"; schema: number }
  | { kind: "ok"; manifest: InstallManifest; sha256: string };

async function readForUninstall(path: string): Promise<ManifestRead> {
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: Partial<InstallManifest>;
  try {
    parsed = JSON.parse(
      await readFile(path, "utf-8"),
    ) as Partial<InstallManifest>;
  } catch {
    return { kind: "unreadable", reason: "it is not valid JSON" };
  }
  if (typeof parsed.schema === "number" && parsed.schema !== 1) {
    return { kind: "newer", schema: parsed.schema };
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.files)) {
    return { kind: "unreadable", reason: "it is not an install manifest" };
  }
  return {
    kind: "ok",
    manifest: parsed as InstallManifest,
    sha256: await sha256File(path),
  };
}

/** Directories an uninstall may try to remove (each only while empty), deepest first. */
export function directoriesToTry(
  manifest: InstallManifest,
  layout: InstallLayout,
  platform: NodeJS.Platform,
  modelCache: string,
): string[] {
  // `createdDirs` comes from a file on disk, so it is only honoured for
  // absolute paths that are inside, or are an ancestor of, a directory init
  // installs into (a fresh `~/.cache` is an ancestor of the model cache). An
  // empty directory of the user's that has nothing to do with the install is
  // never touched, whatever the manifest says. Each is still only `rmdir`ed.
  const roots = [layout.binDir, layout.shareDir, modelCache].map(ownedKey);
  const related = (dir: string) => {
    if (!isAbsolute(dir)) return false;
    const d = ownedKey(dir);
    return roots.some(
      (r) =>
        r === d || r.startsWith(`${d}${sep}`) || d.startsWith(`${r}${sep}`),
    );
  };
  const set = new Set<string>((manifest.createdDirs ?? []).filter(related));
  if (manifest.createdDirs === undefined) {
    // An older manifest does not say what init created: only what is plainly ours.
    const under = (p: string, root: string) =>
      ownedKey(p).startsWith(`${ownedKey(root)}${sep}`);
    for (const f of manifest.files) {
      for (let d = dirname(f.path); under(d, layout.shareDir); d = dirname(d)) {
        set.add(d);
      }
    }
    set.add(layout.shareDir);
    if (platform === "win32") {
      // The Windows prefix is %LOCALAPPDATA%\context-fern: all ours.
      set.add(layout.binDir);
      set.add(layout.prefix);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * The manifest is a file on disk, so a directory it lists is removed only if
 * all of these hold, each cheap to check: it is an install directory itself
 * (bin, share, the sidecar) or an ancestor of a file the manifest lists, so a
 * user's own empty folder inside `bin/` or `share/` that no file of ours sits
 * under is never a candidate; it is a real directory and not a link; and its
 * real path (symlinks and short names resolved) is inside or above a real
 * install directory. Each survivor is still only ever `rmdir`ed, so it must
 * also be empty.
 */
export async function vetDirectories(
  candidates: readonly string[],
  manifest: InstallManifest,
  layout: InstallLayout,
  modelCache: string,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  // Files init installed: the listed ones, any renamed-aside file still waiting
  // to be deleted, and the manifest itself (a re-run after a partial uninstall
  // sees a manifest whose file list is already empty).
  const installed = [
    ...manifest.files.map((f) => f.path),
    ...(manifest.pendingDeletes ?? []).map((p) => p.path),
    layout.manifestPath,
  ];
  const ancestorsOfFiles = new Set<string>();
  for (const file of installed) {
    for (let d = dirname(file); ; d = dirname(d)) {
      ancestorsOfFiles.add(ownedKey(d));
      if (dirname(d) === d) break;
    }
  }
  const installDirs = new Set(
    [
      layout.binDir,
      layout.shareDir,
      join(layout.shareDir, "onnxruntime-native"),
    ].map(ownedKey),
  );
  const realRoots: string[] = [];
  for (const r of [layout.binDir, layout.shareDir, modelCache]) {
    try {
      realRoots.push(ownedKey(realpathSync.native(r)));
    } catch {
      // a root that does not exist cannot anchor anything
    }
  }
  const accepted: string[] = [];
  for (const d of candidates) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(d);
    } catch {
      continue; // not there: nothing to remove
    }
    const key = ownedKey(d);
    let why: string | null = null;
    if (!ancestorsOfFiles.has(key) && !installDirs.has(key)) {
      why = "it is not an install directory or above a file init installed";
    } else if (!info.isDirectory() || info.isSymbolicLink()) {
      why = "it is not a plain directory";
    } else {
      let real: string | null = null;
      try {
        real = ownedKey(realpathSync.native(d));
      } catch {
        why = "its real path could not be resolved";
      }
      if (
        real !== null &&
        !realRoots.some(
          (r) =>
            r === real ||
            r.startsWith(`${real}${sep}`) ||
            real.startsWith(`${r}${sep}`),
        )
      ) {
        why = "its real path is outside the install directories";
      }
    }
    if (why) log(say(`left ${d} (${why})`));
    else accepted.push(d);
  }
  return accepted;
}

export async function runUninstall(
  flags: Record<string, string>,
  deps: UninstallDeps,
): Promise<UninstallReport> {
  const json = flags.json === "true";
  const log = json ? () => {} : deps.log;
  const run = deps.runner ?? defaultRunner;
  const layout = installLayout({
    platform: deps.platform,
    env: deps.env,
    home: deps.home,
  });
  const report: UninstallReport = {
    state: "done",
    removed: [],
    alreadyGone: [],
    leftAlone: [],
    failed: [],
    scheduled: [],
    manual: [],
    dataLocations: await dataLocations(deps.env, deps.home),
    exitCode: 0,
  };
  const finish = (state: UninstallReport["state"], exitCode: number) => {
    report.state = state;
    report.exitCode = exitCode;
    if (report.dataLocations.length > 0) {
      log(
        say(
          "your data was not touched. It lives in:" +
            report.dataLocations.map((p) => `\n        ${p}`).join(""),
        ),
      );
      log(
        say(
          `to delete it yourself: ${dataDeleteCommand(deps.platform, report.dataLocations)}`,
        ),
      );
    }
    for (const c of packageCommands()) log(say(`to remove the package: ${c}`));
    return report;
  };

  // 1. The manifest.
  const read = await readForUninstall(layout.manifestPath);
  if (read.kind === "absent") {
    log(
      say(
        `no install manifest at ${layout.manifestPath}, so nothing was removed (it is written by "${CLI_BINARY_NAME} init"; already uninstalled, or installed another way)`,
      ),
    );
    return finish("nothing-to-do", 0);
  }
  if (read.kind === "newer") {
    log(
      say(
        `${layout.manifestPath} was written by a newer ${CLI_BINARY_NAME} (manifest version ${read.schema}), so nothing was removed · update ${CLI_BINARY_NAME} and run uninstall again`,
      ),
    );
    return finish("refused", 1);
  }
  if (read.kind === "unreadable") {
    log(
      say(
        `${layout.manifestPath} could not be used (${read.reason}), so nothing was removed · delete it yourself if it is stale`,
      ),
    );
    return finish("refused", 1);
  }

  const confined = confineToInstallDirs(
    read.manifest,
    [layout.binDir, layout.shareDir, deps.modelCacheDir],
    log,
  );
  const m = confined.manifest as InstallManifest;
  const ownDir =
    deps.platform === "win32" && isAlreadyInstalled(deps.execPath, layout);
  const ownKey = ownDir ? ownedKey(deps.execPath) : null;
  // The settings file is always Claude Code's own, never a path read from the
  // manifest: an edited manifest cannot point this edit at another file.
  const settingsFile = join(
    deps.env[`${ENV_PREFIX}HOME`] || deps.home,
    ".claude",
    "settings.json",
  );
  const recordedStatuslineFile = m.statusline?.file;
  const trustedStatusline =
    recordedStatuslineFile === undefined ||
    resolve(recordedStatuslineFile).toLowerCase() ===
      resolve(settingsFile).toLowerCase();
  if (!trustedStatusline) {
    log(
      say(
        `the manifest names ${recordedStatuslineFile} for the statusLine, which is not ${settingsFile}; it was ignored. Edit the statusLine by hand if it is yours`,
      ),
    );
  }
  // Names read from the manifest go to `claude`; only a plain name is passed.
  const pluginNameOk = (n: string) =>
    /^[A-Za-z0-9@._][A-Za-z0-9@._-]*$/.test(n);
  let marketplaceName = m.plugin?.marketplace;
  let pluginId = m.plugin?.plugin;
  for (const [what, v] of [
    ["marketplace", marketplaceName],
    ["plugin", pluginId],
  ] as const) {
    if (v !== undefined && !pluginNameOk(v)) {
      log(
        say(
          `the manifest has a ${what} name that is not a plain name (${JSON.stringify(v)}), so it was ignored. Remove it by hand with the claude command if it is yours`,
        ),
      );
      if (what === "marketplace") marketplaceName = undefined;
      else pluginId = undefined;
    }
  }
  const removePlugin =
    flags["keep-plugin"] !== "true" && m.plugin?.method === "claude-cli";
  const keepPath = flags["keep-path"] === "true";

  // 2. The plan, shown before anything changes.
  log(say(`this will remove what ${CLI_BINARY_NAME} init installed:`));
  if (removePlugin)
    log(`        the Claude Code plugin ${m.plugin?.plugin ?? PLUGIN_NAME}`);
  if (marketplaceName && flags["keep-plugin"] !== "true") {
    log(
      `        the ${marketplaceName} marketplace: ${
        m.plugin?.marketplaceAddedByInit === true
          ? "yes (init added it)"
          : m.plugin?.marketplaceAddedByInit === false
            ? "no (it was configured before init)"
            : "will ask (the manifest does not say who added it)"
      }`,
    );
  }
  log(`        the statusLine entry in ${settingsFile}, if it is fern's`);
  if (!keepPath && m.pathEdit) {
    log(
      m.pathEdit.kind === "windows-user-path"
        ? `        ${m.pathEdit.added} from your user PATH`
        : `        the PATH block init added to ${m.pathEdit.file}`,
    );
  }
  log("        the daemon, if it is running");
  for (const f of m.files) log(`        ${f.path}`);
  for (const p of m.pendingDeletes ?? [])
    log(`        ${p.path} (left over from an earlier run)`);
  log(
    "        each file only if it is unchanged since init wrote it; anything else is left and listed",
  );

  if (flags["dry-run"] === "true") {
    log(say("dry run: nothing was changed"));
    return finish("dry-run", 0);
  }
  if (flags.yes !== "true") {
    if (!deps.interactive) {
      log(
        say(
          `not removing anything without --yes (this is not an interactive terminal) · run: ${CLI_BINARY_NAME} uninstall --yes`,
        ),
      );
      return finish("refused", 2);
    }
    if (!(await deps.ask("Remove these?"))) {
      log(say("nothing was removed"));
      return finish("refused", 2);
    }
  }

  // 3. The plugin and its marketplace, through the user's own claude command.
  if (flags["keep-plugin"] !== "true" && m.plugin) {
    const claude = deps.which("claude");
    const manual = (cmd: string, why: string) => {
      report.manual.push(cmd);
      log(say(`${why} · run: ${cmd}`));
    };
    if (removePlugin) {
      const id = pluginId ?? `fern@${marketplaceName ?? "context-fern"}`;
      const cmd = `claude plugin uninstall ${id}`;
      if (claude === null)
        manual(
          cmd,
          "the claude command is not on PATH, so the plugin was not removed",
        );
      else {
        const r = await run(claude, ["plugin", "uninstall", "--", id]);
        if (r.ok) {
          report.removed.push(`plugin ${id}`);
          log(say(`removed the Claude Code plugin ${id}`));
        } else {
          report.failed.push({
            what: `plugin ${id}`,
            error: r.output.split("\n")[0] ?? "",
          });
          manual(cmd, "claude could not remove the plugin");
        }
      }
    }
    if (marketplaceName) {
      const cmd = `claude plugin marketplace remove ${marketplaceName}`;
      const added = m.plugin.marketplaceAddedByInit;
      let doIt = added === true;
      if (added === undefined) {
        // The manifest cannot say whether the user already had it: ask, or leave it.
        if (deps.interactive) {
          doIt = await deps.ask(
            `The ${marketplaceName} marketplace may have been yours before init. Remove it?`,
          );
        } else {
          manual(
            cmd,
            `left the ${marketplaceName} marketplace (the manifest does not say whether init added it)`,
          );
        }
      }
      if (doIt) {
        if (claude === null)
          manual(
            cmd,
            "the claude command is not on PATH, so the marketplace was not removed",
          );
        else {
          const r = await run(claude, [
            "plugin",
            "marketplace",
            "remove",
            "--",
            marketplaceName,
          ]);
          if (r.ok) {
            report.removed.push(`marketplace ${marketplaceName}`);
            log(say(`removed the ${marketplaceName} marketplace`));
          } else {
            report.failed.push({
              what: `marketplace ${marketplaceName}`,
              error: r.output.split("\n")[0] ?? "",
            });
            manual(cmd, "claude could not remove the marketplace");
          }
        }
      }
    }
  }

  // 4. The statusLine entry.
  try {
    const r = await removeStatuslineEntry(
      settingsFile,
      trustedStatusline ? m.statusline?.command : undefined,
    );
    if (r.state === "removed") {
      report.removed.push(`statusLine in ${settingsFile}`);
      log(
        say(
          `removed the statusLine from ${settingsFile} (a copy is at ${r.backupPath})`,
        ),
      );
    } else if (r.state === "left-alone") {
      report.leftAlone.push({ path: settingsFile, reason: r.reason });
      log(say(r.reason));
    }
  } catch (err) {
    report.failed.push({
      what: `statusLine in ${settingsFile}`,
      error: (err as Error).message,
    });
  }

  // 5. The PATH entry.
  if (!keepPath && m.pathEdit) {
    try {
      if (m.pathEdit.kind === "windows-user-path") {
        const r = await deps.removeWindowsPath(m.pathEdit.added);
        if (r === "removed") {
          report.removed.push(`${m.pathEdit.added} from the user PATH`);
          log(
            say(
              `removed ${m.pathEdit.added} from your user PATH · open a new terminal`,
            ),
          );
        } else {
          report.alreadyGone.push(`${m.pathEdit.added} in the user PATH`);
        }
      } else {
        const r = await removeShellRcBlock(m.pathEdit.file, layout.binDir);
        if (r.state === "removed") {
          report.removed.push(`PATH block in ${m.pathEdit.file}`);
          log(
            say(
              `removed the PATH block from ${m.pathEdit.file} (a copy is at ${r.backupPath}) · open a new terminal`,
            ),
          );
        } else if (r.state === "left-alone") {
          report.leftAlone.push({ path: m.pathEdit.file, reason: r.reason });
          log(say(r.reason));
        } else {
          report.alreadyGone.push(`PATH block in ${m.pathEdit.file}`);
        }
      }
    } catch (err) {
      report.failed.push({ what: "PATH entry", error: (err as Error).message });
      log(say(`could not remove the PATH entry (${(err as Error).message})`));
    }
  }

  // 6. The daemon: stopped, and waited for, before any file is touched.
  const stop = await deps.stopDaemon();
  if (stop.state === "stopped") log(say("stopped the daemon"));
  else if (stop.state === "timeout") {
    log(
      say(
        `the daemon (pid ${stop.pid}) did not exit within 5 s; files it holds may be left, and uninstall can be run again`,
      ),
    );
  } else if (stop.state === "unresponsive-left") {
    log(
      say(
        `the daemon (pid ${stop.pid}) is still running and does not answer (${stop.why}) · its program files are not removed while it runs · stop it with "${CLI_NAME} daemon stop" (or end pid ${stop.pid} yourself), then run uninstall again`,
      ),
    );
  }
  // The daemon is running from the installed binary and loading the sidecar: neither is deleted
  // (or, on Windows, renamed for the helper to delete) from under it. Everything else goes, and
  // the manifest keeps these two kinds so the next run finishes the job.
  const daemonRunning = stop.state === "unresponsive-left" ? stop : null;

  // 7. The files. Entries that could not be removed stay in the manifest.
  const remainingFiles: ManifestFile[] = [];
  const remainingPending: PendingDelete[] = [];
  const swept = await sweepPending(m.pendingDeletes ?? []);
  remainingPending.push(...swept.remaining);
  for (const l of swept.leftAlone) {
    report.leftAlone.push({
      path: l.path,
      reason: l.reason.replaceAll("-", " "),
    });
  }
  // Our own running exe last, so everything else is gone first.
  const ordered = [...m.files].sort(
    (a, b) =>
      Number(ownedKey(a.path) === ownKey) - Number(ownedKey(b.path) === ownKey),
  );
  const scheduledJobs: PendingDelete[] = [];
  for (const f of ordered) {
    if (daemonRunning && (f.role === "binary" || f.role === "sidecar")) {
      remainingFiles.push(f);
      report.leftAlone.push({
        path: f.path,
        reason: `the daemon (pid ${daemonRunning.pid}) is still running`,
      });
      log(
        say(
          `left ${f.path} (the daemon, pid ${daemonRunning.pid}, is still running)`,
        ),
      );
      continue;
    }
    if (ownKey !== null && ownedKey(f.path) === ownKey) {
      const aside = await moveRunningExeAside(f);
      if (aside.state === "scheduled") {
        scheduledJobs.push({ path: aside.path, sha256: f.sha256 });
        report.scheduled.push(f.path);
        continue;
      }
      if (aside.state === "left-alone") {
        report.leftAlone.push({ path: f.path, reason: aside.reason });
        log(say(`left ${f.path} alone (${aside.reason})`));
        continue;
      }
      if (aside.state === "gone") {
        report.alreadyGone.push(f.path);
        continue;
      }
      report.failed.push({ what: f.path, error: aside.error });
      remainingFiles.push(f);
      continue;
    }
    const r = await removeIfHash(f.path, f.sha256);
    if (r.state === "removed") {
      report.removed.push(f.path);
      log(say(`removed ${f.path}`));
    } else if (r.state === "missing") {
      report.alreadyGone.push(f.path);
    } else if (r.state === "left-alone") {
      const reason = r.reason.replaceAll("-", " ");
      report.leftAlone.push({ path: f.path, reason });
      log(
        say(
          `left ${f.path} alone (${reason}) · it is only removed if it still matches what init wrote`,
        ),
      );
    } else {
      report.failed.push({ what: f.path, error: r.error });
      remainingFiles.push(f);
      log(
        say(
          `could not remove ${f.path} (${r.error}) · is something still using it? run uninstall again`,
        ),
      );
    }
  }

  // 8. The manifest: gone when nothing still needs it; otherwise rewritten to
  // say what is left (files that could not be removed, and any renamed exe a
  // helper has yet to delete), so running uninstall again finishes the job.
  const incomplete = remainingFiles.length + remainingPending.length > 0;
  const helperJobs: PendingDelete[] = [...scheduledJobs];
  if (incomplete || scheduledJobs.length > 0) {
    await writeManifest(layout.manifestPath, {
      ...m,
      files: [...remainingFiles, ...confined.ignoredFiles],
      pendingDeletes: [
        ...remainingPending,
        ...scheduledJobs,
        ...confined.ignoredPending,
      ],
    });
    if (incomplete) {
      log(
        say(
          "some files could not be removed; the install manifest keeps them, so run uninstall again",
        ),
      );
    } else {
      // Nothing failed: the helper removes the manifest too, after the exe, so
      // if the helper never runs the manifest still lists what is left.
      helperJobs.push({
        path: layout.manifestPath,
        sha256: await sha256File(layout.manifestPath),
      });
    }
  } else {
    const r = await removeIfHash(layout.manifestPath, read.sha256);
    if (r.state === "left-alone") {
      report.leftAlone.push({
        path: layout.manifestPath,
        reason: "it changed while uninstall ran",
      });
    }
  }

  // 9. Directories, only while empty, deepest first.
  const tryDirs = await vetDirectories(
    directoriesToTry(m, layout, deps.platform, deps.modelCacheDir),
    m,
    layout,
    deps.modelCacheDir,
    log,
  );
  const stillThere: string[] = [];
  for (const d of tryDirs) {
    const r = await removeEmptyDir(d);
    if (r.state === "removed") report.removed.push(d);
    else if (r.state === "left-alone") {
      stillThere.push(d);
      log(say(`left ${d} (not empty)`));
    } else if (r.state === "failed") {
      stillThere.push(d);
      log(say(`could not remove ${d} (${r.error})`));
    }
  }

  // 10. Windows: our own renamed exe (and then the manifest) goes after this process exits.
  if (scheduledJobs.length > 0) {
    try {
      deps.startHelper(helperJobs, stillThere, process.pid);
      for (const j of scheduledJobs) {
        report.manual.push(manualRemoveCommand(j.path));
        log(
          say(
            `${j.path} is removed a moment after this command exits (it is running now) · if it is still there in a minute: ${manualRemoveCommand(j.path)}`,
          ),
        );
      }
    } catch (err) {
      for (const j of scheduledJobs) {
        report.manual.push(manualRemoveCommand(j.path));
        report.failed.push({ what: j.path, error: (err as Error).message });
        log(
          say(
            `could not start the cleanup helper · remove it yourself: ${manualRemoveCommand(j.path)}`,
          ),
        );
      }
    }
  }

  const clean =
    report.failed.length === 0 && report.leftAlone.length === 0 && !incomplete;
  log(say(clean ? "uninstalled" : "uninstalled what could be, see above"));
  return finish("done", clean ? 0 : 1);
}

type AsideOutcome =
  | { state: "scheduled"; path: string }
  | { state: "gone" }
  | { state: "left-alone"; reason: string }
  | { state: "failed"; error: string };

/**
 * A running exe cannot be deleted on Windows but can be renamed. The rename
 * happens only if the file is still a regular file with the recorded hash.
 * The renamed file is then retried once (it succeeds if nothing is running
 * it) and otherwise handed to the helper.
 */
async function moveRunningExeAside(f: ManifestFile): Promise<AsideOutcome> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(f.path);
  } catch {
    return { state: "gone" };
  }
  if (!info.isFile())
    return { state: "left-alone", reason: "not a regular file" };
  let sha: string;
  try {
    sha = await sha256File(f.path);
  } catch (err) {
    return { state: "failed", error: (err as Error).message };
  }
  if (sha !== f.sha256)
    return { state: "left-alone", reason: "changed since install" };
  const aside = `${f.path}.old-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(f.path, aside);
  } catch (err) {
    return { state: "failed", error: (err as Error).message };
  }
  const r = await removeIfHash(aside, f.sha256);
  if (r.state === "removed" || r.state === "missing") return { state: "gone" };
  if (r.state === "left-alone") {
    // Swapped between the hash check and the rename: it is not ours to delete,
    // and it now sits under the aside name.
    return {
      state: "left-alone",
      reason: `it changed while uninstall ran, and was left at ${aside}`,
    };
  }
  return { state: "scheduled", path: aside };
}

export function realUninstallDeps(): UninstallDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (q) => (await import("../prompt-yes-no")).promptYesNo(q),
    log: (l) => console.log(l),
    which: (c) => Bun.which(c),
    stopDaemon: () => stopRunningDaemon(),
    removeWindowsPath: removeFromWindowsUserPath,
    startHelper: startDeleteHelper,
    modelCacheDir: modelCacheDir(),
  };
}
