// One test per finding of the scoped reviewer pass on the final head of #23
// (docs/decisions.md, 2026-11-17).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBinary, locateBinarySource } from "../../src/install/binary";
import {
  confineToInstallDirs,
  type GlobalInitDeps,
  runGlobalInit,
} from "../../src/install/global-init";
import { installLayout } from "../../src/install/layout";
import {
  type InstallManifest,
  readManifest,
  writeManifest,
} from "../../src/install/manifest";
import { addToWindowsUserPath } from "../../src/install/path-setup";
import type { CommandRunner } from "../../src/install/plugin-setup";

const EXE = process.platform === "win32" ? ".exe" : "";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-harden-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function shipped(version = "one"): Promise<string> {
  const dir = join(root, `src-${version}`);
  await mkdir(join(dir, "onnxruntime-native", "linux-x64"), {
    recursive: true,
  });
  await writeFile(join(dir, `context-fern${EXE}`), `exe-${version}`);
  await writeFile(
    join(dir, "onnxruntime-native", "linux-x64", "onnxruntime_binding.node"),
    `binding-${version}`,
  );
  return join(dir, `context-fern${EXE}`);
}
const src = (exe: string) =>
  locateBinarySource(exe) as NonNullable<ReturnType<typeof locateBinarySource>>;

test("a relative FERN_INSTALL_PREFIX becomes an absolute directory before it can reach PATH or a startup file", () => {
  const l = installLayout({
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: "relative/prefix" },
    home: root,
  });
  expect(l.binDir.startsWith(process.cwd())).toBe(true);
});

test("a PATH directory containing ';' or '%' is refused before PowerShell is started", async () => {
  await expect(addToWindowsUserPath("C:a;b\bin")).rejects.toThrow(
    /cannot be added to PATH safely/,
  );
  await expect(addToWindowsUserPath("C:%USERNAME%\bin")).rejects.toThrow(
    /cannot be added to PATH safely/,
  );
});

test("the same install directory spelled two ways is one location: an upgrade through a different spelling does not delete the sidecar it just installed", async () => {
  const real = join(root, "real-prefix");
  await mkdir(real, { recursive: true });
  const alias = join(root, "alias-prefix");
  try {
    await symlink(real, alias, "junction");
  } catch {
    return; // no privilege to create links here
  }
  const layoutVia = (prefix: string) =>
    installLayout({
      platform: process.platform,
      env: { FERN_INSTALL_PREFIX: prefix },
      home: root,
    });
  // The first install is recorded under one spelling, the second runs under the other, with a sidecar file dropped.
  const first = await installBinary(
    src(await shipped("one")),
    layoutVia(alias),
  );
  const second = await installBinary(
    src(await shipped("one")),
    layoutVia(real),
    first.entries,
  );
  expect(second.leftAlone).toEqual([]);
  for (const e of second.entries) expect(existsSync(e.path)).toBe(true);
  expect(
    existsSync(
      join(
        real,
        "share",
        "context-fern",
        "onnxruntime-native",
        "linux-x64",
        "onnxruntime_binding.node",
      ),
    ),
  ).toBe(true);
});

function manifestWith(
  files: string[],
  pending: string[] = [],
): InstallManifest {
  return {
    schema: 1,
    version: "x",
    installedAt: "x",
    platform: "x",
    prefix: join(root, "p"),
    binDir: join(root, "p", "bin"),
    shareDir: join(root, "p", "share"),
    files: files.map((path) => ({
      path,
      sha256: "a",
      bytes: 1,
      role: "binary" as const,
    })),
    pendingDeletes: pending.map((path) => ({ path, sha256: "c" })),
    pathEdit: null,
    plugin: null,
  };
}

test("manifest entries outside the install directories are not acted on, are reported, and are kept", () => {
  const bin = join(root, "p", "bin");
  const logs: string[] = [];
  const c = confineToInstallDirs(
    manifestWith(
      [
        join(bin, "context-fern"),
        join(root, "elsewhere", "precious.txt"),
        join(root, "p", "binx", "sibling-prefix.txt"), // /p/binx is not inside /p/bin
        join(bin, "..", "..", "escaped.txt"), // .. segments must not escape
      ],
      [join(root, "elsewhere", "also.txt")],
    ),
    [bin, join(root, "p", "share")],
    (l) => logs.push(l),
  );
  expect(c.manifest?.files.map((f) => f.path)).toEqual([
    join(bin, "context-fern"),
  ]);
  expect(c.manifest?.pendingDeletes).toEqual([]);
  expect(c.ignoredFiles.length).toBe(3);
  expect(c.ignoredPending.length).toBe(1);
  expect(logs.length).toBe(4);
});

test("an entry recorded under a different spelling of the install directory is still inside it", async () => {
  const real = join(root, "real");
  await mkdir(join(real, "bin"), { recursive: true });
  const alias = join(root, "alias");
  try {
    await symlink(real, alias, "junction");
  } catch {
    return; // no privilege to create links here
  }
  const c = confineToInstallDirs(
    manifestWith([join(alias, "bin", "context-fern")]),
    [join(real, "bin")],
    () => {},
  );
  expect(c.ignoredFiles).toEqual([]);
  expect(c.manifest?.files.length).toBe(1);
});

test("a manifest entry that init will not act on stays in the manifest init writes back", async () => {
  const exe = await shipped();
  const prefix = join(root, "prefix");
  const manifestPath = join(
    prefix,
    "share",
    "context-fern",
    "install-manifest.json",
  );
  const foreign = join(root, "elsewhere", "kept.txt");
  await mkdir(join(prefix, "share", "context-fern"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(manifestWith([foreign], [foreign])),
  );
  await runGlobalInit(
    { "no-plugin": "true" },
    {
      platform: "linux",
      env: { FERN_INSTALL_PREFIX: prefix, PATH: "" },
      home: join(root, "home"),
      execPath: exe,
      interactive: false,
      ask: async () => false,
      log: () => {},
      which: () => null,
      now: () => new Date("2026-01-01T00:00:00Z"),
      modelCacheDir: join(root, "cache"),
      addToWindowsPath: async () => {
        throw new Error("not here");
      },
    },
  );
  const after = await readManifest(manifestPath);
  expect(after?.files.some((f) => f.path === foreign)).toBe(true);
  expect(after?.pendingDeletes?.some((f) => f.path === foreign)).toBe(true);
});

test("writeManifest leaves no temporary file behind and replaces the manifest atomically", async () => {
  const path = join(root, "share", "install-manifest.json");
  const m = {
    schema: 1,
    version: "1",
    installedAt: "t",
    platform: "p",
    prefix: "x",
    binDir: "x",
    shareDir: "x",
    files: [],
    pathEdit: null,
    plugin: null,
  } as InstallManifest;
  await writeManifest(path, m);
  await writeManifest(path, { ...m, version: "2" });
  expect((await readManifest(path))?.version).toBe("2");
  expect(await readdir(join(root, "share"))).toEqual(["install-manifest.json"]);
});

test("a plugin registered with no file installed is still recorded in the manifest", async () => {
  const exe = await shipped();
  const logs: string[] = [];
  const runner: CommandRunner = async () => ({ ok: true, output: "" });
  const deps: GlobalInitDeps = {
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: join(root, "prefix"), PATH: "" },
    home: join(root, "home"),
    execPath: exe,
    interactive: false,
    ask: async () => false,
    log: (l) => logs.push(l),
    which: () => "/usr/bin/claude",
    runner,
    now: () => new Date("2026-01-01T00:00:00Z"),
    modelCacheDir: join(root, "cache"),
    addToWindowsPath: async () => {
      throw new Error("not here");
    },
  };
  await runGlobalInit({ "no-install": "true", yes: "true" }, deps);
  const m = await readManifest(
    join(root, "prefix", "share", "context-fern", "install-manifest.json"),
  );
  expect(m?.plugin?.method).toBe("claude-cli");
  expect(logs.join("\n")).toContain("running /usr/bin/claude");
});

// The whole-code rule, not only the delete calls: every way install code can
// destroy a file is confined to a small, named set of call sites.
test("source scan: every copy is exclusive, every write is exclusive, and only the known files rename or append", () => {
  const dir = join(import.meta.dir, "../../src/install");
  const strip = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const text = strip(readFileSync(join(dir, f), "utf-8"));
    // A fixed window after each call, not "up to the first )": the arguments
    // contain calls of their own (JSON.stringify(...)).
    for (const m of text.matchAll(/\bcopyFile\(([\s\S]{0,200})/g)) {
      expect({ f, exclusive: /COPYFILE_EXCL/.test(m[1] ?? "") }).toEqual({
        f,
        exclusive: true,
      });
    }
    for (const m of text.matchAll(/\bwriteFile\(([\s\S]{0,240})/g)) {
      expect({ f, wx: /"wx"/.test(m[1] ?? "") }).toEqual({ f, wx: true });
    }
    if (/\brename\(/.test(text))
      expect([
        "binary.ts",
        "manifest.ts",
        "uninstall.ts",
        "uninstall-path.ts",
      ]).toContain(f);
    if (/\bappendFile\(/.test(text)) expect(f).toBe("path-setup.ts");
    expect(/\b(truncate|ftruncate|createWriteStream)\(/.test(text)).toBe(false);
  }
});
