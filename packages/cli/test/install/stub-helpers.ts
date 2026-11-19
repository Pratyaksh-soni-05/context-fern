// Helpers shared by the uninstall tests: a real compiled stub `claude`, a fake
// shipped binary that init can install, and dependency objects for init and
// uninstall that point entirely at a temporary directory.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GlobalInitDeps,
  runGlobalInit,
} from "../../src/install/global-init";
import { installLayout } from "../../src/install/layout";
import type { UninstallDeps } from "../../src/install/uninstall";

export const EXE = process.platform === "win32" ? ".exe" : "";

/** Compiles fixtures/stub-claude.ts into `<dir>/claude(.exe)` and returns its path. */
export async function buildStubClaude(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const out = join(dir, `claude${EXE}`);
  const src = join(import.meta.dir, "fixtures", "stub-claude.ts");
  const proc = Bun.spawn({
    cmd: ["bun", "build", src, "--compile", "--outfile", out],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(out)) {
    throw new Error(
      `could not compile the stub claude: ${await new Response(proc.stderr).text()}`,
    );
  }
  return out;
}

/** The calls the stub recorded, each as its argument list. */
export async function stubCalls(logPath: string): Promise<string[][]> {
  if (!existsSync(logPath)) return [];
  return (await readFile(logPath, "utf-8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

/** A stand-in for a shipped binary: an exe with a sidecar tree beside it (the tarball layout). */
export async function fakeShipped(root: string): Promise<string> {
  const dir = join(root, "pkg");
  await mkdir(join(dir, "onnxruntime-native", "linux-x64"), {
    recursive: true,
  });
  await writeFile(join(dir, `context-fern${EXE}`), "exe-bytes");
  await writeFile(
    join(dir, "onnxruntime-native", "linux-x64", "onnxruntime_binding.node"),
    "binding-bytes",
  );
  return join(dir, `context-fern${EXE}`);
}

export interface Fixture {
  root: string;
  prefix: string;
  home: string;
  cache: string;
  manifestPath: string;
  logs: string[];
}

export function fixture(root: string): Fixture {
  const prefix = join(root, "prefix");
  return {
    root,
    prefix,
    home: join(root, "home"),
    cache: join(root, "cache"),
    manifestPath: join(
      prefix,
      "share",
      "context-fern",
      "install-manifest.json",
    ),
    logs: [],
  };
}

export function initDeps(
  f: Fixture,
  execPath: string,
  over: Partial<GlobalInitDeps> = {},
): GlobalInitDeps {
  return {
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: f.prefix, PATH: "", SHELL: "/bin/zsh" },
    home: f.home,
    execPath,
    interactive: false,
    ask: async () => false,
    log: (l) => f.logs.push(l),
    which: () => null,
    now: () => new Date("2026-01-01T00:00:00Z"),
    modelCacheDir: f.cache,
    addToWindowsPath: async () => {
      throw new Error("not on Windows here");
    },
    ...over,
  };
}

/** Installs the fake binary exactly as `context-fern init` would, and returns the install's layout. */
export async function installFake(
  f: Fixture,
  over: Partial<GlobalInitDeps> = {},
  flags: Record<string, string> = { "no-plugin": "true" },
) {
  await mkdir(f.home, { recursive: true });
  const exe = await fakeShipped(f.root);
  await runGlobalInit(flags, initDeps(f, exe, over));
  return installLayout({
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: f.prefix },
    home: f.home,
  });
}

export function uninstallDeps(
  f: Fixture,
  over: Partial<UninstallDeps> = {},
): UninstallDeps {
  return {
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: f.prefix, FERN_HOME: f.home, PATH: "" },
    home: f.home,
    execPath: join(f.root, `bun-not-installed${EXE}`),
    interactive: false,
    ask: async () => {
      throw new Error("must not prompt");
    },
    log: (l) => f.logs.push(l),
    which: () => null,
    stopDaemon: async () => ({ state: "not-running" }),
    removeWindowsPath: async () => {
      throw new Error("not on Windows here");
    },
    startHelper: () => {
      throw new Error("no helper expected here");
    },
    modelCacheDir: f.cache,
    ...over,
  };
}
