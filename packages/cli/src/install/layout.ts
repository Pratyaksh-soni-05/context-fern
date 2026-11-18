// Where `context-fern init` puts the installed binary, and where the
// things it needs sit relative to it. One layout on every OS, the same
// shape a pip install has: <prefix>/bin holds the executables, and
// <prefix>/share/context-fern holds the native sidecar and the install
// manifest. The binary's patched onnxruntime lookup finds the sidecar at
// <exe-dir>/../share/context-fern (docs/decisions.md), so no symlinks and
// no dependence on how the OS reports process.execPath.
//
// Pure: callers pass the platform, environment and home directory in.

import { join, resolve } from "node:path";
import { CLI_BINARY_NAME, CLI_NAME, ENV_PREFIX } from "@context-fern/core";

export interface InstallLayout {
  prefix: string;
  /** Holds `context-fern` and `fern`. This is the directory that must be on PATH. */
  binDir: string;
  /** Holds `onnxruntime-native/` and `install-manifest.json`. */
  shareDir: string;
  manifestPath: string;
  exeSuffix: string;
}

export interface LayoutInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function installLayout({
  platform,
  env,
  home,
}: LayoutInput): InstallLayout {
  const override = env[`${ENV_PREFIX}INSTALL_PREFIX`];
  const prefix =
    override && override.length > 0
      ? resolve(override) // an absolute path: it ends up on PATH and in a startup file
      : platform === "win32"
        ? join(
            env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
            CLI_BINARY_NAME,
          )
        : join(home, ".local");
  const shareDir = join(prefix, "share", CLI_BINARY_NAME);
  return {
    prefix,
    binDir: join(prefix, "bin"),
    shareDir,
    manifestPath: join(shareDir, "install-manifest.json"),
    exeSuffix: platform === "win32" ? ".exe" : "",
  };
}

/** The two executable names every install path ships together. */
export function executableNames(layout: InstallLayout): string[] {
  return [CLI_BINARY_NAME, CLI_NAME].map((n) => `${n}${layout.exeSuffix}`);
}
