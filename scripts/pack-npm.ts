// Builds the npm tarballs from the release's per-target tarballs and the
// model tarball. Nothing is published here: `npm pack` only. The publish
// job is the only place that publishes (release.yml).
//
//   bun scripts/pack-npm.ts --version 0.1.0 --model-version 1.0.0 \
//     --bundle-dir release --out dist-pkg [--targets win-x64,linux-x64]
//
// Packages: `context-fern` (launcher), `@context-fern/<target>` (binary
// + sidecar), `context-fern-model` (the model, once).

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_URL } from "../packages/core/src/brand";

const ROOT = resolve(import.meta.dir, "..");
const NPM_DIR = join(ROOT, "packaging", "npm");

const TARGETS: Record<string, { os: string; cpu: string; libc?: string }> = {
  "win-x64": { os: "win32", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
};

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

const version = arg("version");
const modelVersion = arg("model-version");
const bundleDir = resolve(arg("bundle-dir"));
const out = resolve(arg("out"));
const requested = arg("targets", "").split(",").filter(Boolean);
const wanted = requested.length
  ? requested
  : Object.keys(TARGETS).filter((t) =>
      existsSync(join(bundleDir, `context-fern-${t}.tar.gz`)),
    );
if (wanted.length === 0)
  throw new Error(`no context-fern-<target>.tar.gz in ${bundleDir}`);
mkdirSync(out, { recursive: true });

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** The repository links come from brand.ts (REPO_OWNER), never from the source package.json files. */
function withRepoLinks(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    ...pkg,
    homepage: REPO_URL,
    repository: { type: "git", url: `git+${REPO_URL}.git` },
  };
}

function pack(stage: string): string {
  const name = execFileSync(
    "npm",
    ["pack", "--pack-destination", out, "--silent"],
    {
      cwd: stage,
      encoding: "utf-8",
      shell: process.platform === "win32", // npm is npm.cmd on Windows
    },
  )
    .trim()
    .split("\n")
    .pop() as string;
  console.log(`packed ${name}`);
  return name;
}

// GNU tar reads "C:\..." as host:path unless told the files are local;
// bsdtar (macOS, Windows' own tar.exe) does not know the flag.
const isGnuTar = execFileSync("tar", ["--version"], {
  encoding: "utf-8",
}).includes("GNU");

function extract(tarball: string, into: string): void {
  mkdirSync(into, { recursive: true });
  // Forward slashes: MSYS tar mangles backslashes in its path arguments.
  const slash = (p: string) => p.replaceAll("\\", "/");
  execFileSync("tar", [
    "xzf",
    slash(tarball),
    "-C",
    slash(into),
    ...(isGnuTar ? ["--force-local"] : []),
  ]);
}

const work = mkdtempSync(join(tmpdir(), "fern-pack-npm-"));
try {
  // 1. The model, once.
  const models = readdirSync(bundleDir).filter((f) =>
    /^model-.*\.tar\.gz$/.test(f),
  );
  if (models.length !== 1)
    throw new Error(
      `expected exactly one model-*.tar.gz in ${bundleDir}, found ${models.length}`,
    );
  const modelStage = join(work, "model");
  extract(join(bundleDir, models[0] as string), join(modelStage, "payload"));
  const modelPkg = readJson(join(NPM_DIR, "model", "package.json"));
  modelPkg.version = modelVersion;
  writeFileSync(
    join(modelStage, "package.json"),
    `${JSON.stringify(withRepoLinks(modelPkg), null, 2)}\n`,
  );
  cpSync(join(ROOT, "LICENSE"), join(modelStage, "LICENSE"));
  pack(modelStage);

  // 2. One platform package per target.
  const optional: Record<string, string> = {};
  for (const target of wanted) {
    const t = TARGETS[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const tarball = join(bundleDir, `context-fern-${target}.tar.gz`);
    if (!existsSync(tarball)) throw new Error(`missing ${tarball}`);
    const stage = join(work, target);
    extract(tarball, stage);
    const pkg = readJson(join(NPM_DIR, "platform", "package.json"));
    pkg.name = `@context-fern/${target}`;
    pkg.version = version;
    pkg.description = `The Context Fern binary for ${target}. Install \`context-fern\`, not this.`;
    pkg.os = [t.os];
    pkg.cpu = [t.cpu];
    if (t.libc) pkg.libc = [t.libc];
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(withRepoLinks(pkg), null, 2)}\n`,
    );
    cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
    pack(stage);
    optional[`@context-fern/${target}`] = version;
  }

  // 3. The launcher package.
  const mainStage = join(work, "main");
  cpSync(join(NPM_DIR, "context-fern", "bin"), join(mainStage, "bin"), {
    recursive: true,
  });
  const main = readJson(join(NPM_DIR, "context-fern", "package.json"));
  main.version = version;
  main.dependencies = { "context-fern-model": modelVersion };
  main.optionalDependencies = optional;
  writeFileSync(
    join(mainStage, "package.json"),
    `${JSON.stringify(withRepoLinks(main), null, 2)}\n`,
  );
  cpSync(join(ROOT, "LICENSE"), join(mainStage, "LICENSE"));
  pack(mainStage);
} finally {
  rmSync(work, { recursive: true, force: true });
}
