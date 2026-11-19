// What `npm i context-fern@rc` resolves to is decided by the exact versions
// pack-npm.ts stamps into the launcher's package.json. This runs the real
// packer on tiny synthetic bundles and reads the result back, offline, so a
// release candidate can be checked before anything is published. The same
// facts are re-checked against the real registry by verify-npm-release.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TARGETS = ["win-x64", "linux-x64", "linux-arm64", "darwin-arm64"];
const slash = (p: string) => p.replaceAll("\\", "/");
let work: string;
let bundle: string;

const isGnuTar = () =>
  execFileSync("tar", ["--version"], { encoding: "utf-8" }).includes("GNU");

function tarball(name: string, files: Record<string, string>): void {
  const stage = mkdtempSync(join(work, "stage-"));
  for (const [f, body] of Object.entries(files)) {
    const path = join(stage, f);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  execFileSync("tar", [
    "czf",
    slash(join(bundle, name)),
    "-C",
    slash(stage),
    ...(isGnuTar() ? ["--force-local"] : []),
    ".",
  ]);
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "fern-npm-resolution-"));
  bundle = join(work, "bundle");
  mkdirSync(bundle);
  for (const t of TARGETS)
    tarball(`context-fern-${t}.tar.gz`, {
      [t.startsWith("win") ? "context-fern.exe" : "context-fern"]: "x",
    });
  tarball("model-1.tar.gz", { "model.onnx": "x" });
}, 60_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
}, 60_000);

function pack(version: string, modelVersion: string) {
  const out = join(work, `out-${version}-${modelVersion}`);
  const r = spawnSync(
    "bun",
    [
      join(ROOT, "scripts/pack-npm.ts"),
      "--version",
      version,
      "--model-version",
      modelVersion,
      "--bundle-dir",
      bundle,
      "--out",
      out,
    ],
    { encoding: "utf-8", cwd: ROOT },
  );
  return { r, out };
}

function packageJsonOf(out: string, prefix: string): Record<string, unknown> {
  const file = readdirSync(out).find(
    (f) => f.startsWith(prefix) && f.endsWith(".tgz"),
  );
  if (!file) throw new Error(`no ${prefix}*.tgz in ${out}`);
  const text = execFileSync(
    "tar",
    [
      "xzOf",
      slash(join(out, file)),
      ...(isGnuTar() ? ["--force-local"] : []),
      "package/package.json",
    ],
    {
      encoding: "utf-8",
    },
  );
  return JSON.parse(text) as Record<string, unknown>;
}

test("a release candidate's launcher pins the rc version of every platform package and the rc model, exactly", () => {
  const { r, out } = pack("0.1.0-rc.2", "1.0.0-rc.2");
  expect(r.status).toBe(0);
  const main = packageJsonOf(out, "context-fern-0.1.0-rc.2");
  expect(main.version).toBe("0.1.0-rc.2");
  expect(main.optionalDependencies).toEqual(
    Object.fromEntries(
      TARGETS.map((t) => [`@context-fern/${t}`, "0.1.0-rc.2"]),
    ),
  );
  expect(main.dependencies).toEqual({ "context-fern-model": "1.0.0-rc.2" });
}, 120_000);

test("every package of a release candidate is itself an rc version, and the model one is its own rc, not 1.0.0", () => {
  const { out } = pack("0.1.0-rc.2", "1.0.0-rc.2");
  const names = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  expect(names).toHaveLength(6);
  expect(names.some((n) => n === "context-fern-model-1.0.0-rc.2.tgz")).toBe(
    true,
  );
  expect(names.every((n) => n.includes("-rc.2"))).toBe(true);
}, 120_000);

test("a stable release pins stable versions: no rc anywhere", () => {
  const { r, out } = pack("0.1.0", "1.0.0");
  expect(r.status).toBe(0);
  const main = packageJsonOf(out, "context-fern-0.1.0.tgz".replace(".tgz", ""));
  expect(JSON.stringify(main)).not.toContain("rc");
  expect(main.dependencies).toEqual({ "context-fern-model": "1.0.0" });
}, 120_000);

test("a release candidate paired with a stable model, or the reverse, is refused before anything is packed", () => {
  for (const [v, m] of [
    ["0.1.0-rc.1", "1.0.0"],
    ["0.1.0", "1.0.0-rc.1"],
  ] as const) {
    const { r, out } = pack(v, m);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("both be release candidates or both stable");
    expect(() => readdirSync(out)).toThrow();
  }
}, 120_000);
