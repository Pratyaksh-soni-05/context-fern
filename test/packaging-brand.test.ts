// Packaging files cannot import brand.ts (JSON, JavaScript, Python), so
// this is the one place that proves they still agree with it. Names are read
// from the sources; the repository links are stamped at pack time from
// REPO_URL, so those are checked on the real packer's output.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_BINARY_NAME,
  NPM_PACKAGE,
  PYPI_PACKAGE,
  REPO_OWNER,
  REPO_URL,
} from "../packages/core/src/brand";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;
const slash = (p: string) => p.replaceAll("\\", "/");
const gnu = () =>
  execFileSync("tar", ["--version"], { encoding: "utf-8" }).includes("GNU")
    ? ["--force-local"]
    : [];

test("the npm launcher package and its platform packages are named from brand.ts", () => {
  expect(json("packaging/npm/context-fern/package.json").name).toBe(
    NPM_PACKAGE,
  );
  expect(json("packaging/npm/model/package.json").name).toBe(
    `${NPM_PACKAGE}-model`,
  );
  expect(json("packaging/npm/platform/package.json").name).toStartWith(
    `@${NPM_PACKAGE}/`,
  );
  expect(
    Object.keys(
      json("packaging/npm/context-fern/package.json").bin as object,
    ).sort(),
  ).toEqual([CLI_BINARY_NAME, "fern"].sort());
  const launcher = read("packaging/npm/context-fern/bin/launcher.js");
  expect(launcher).toContain(`@${NPM_PACKAGE}/`);
  expect(launcher).toContain(`${NPM_PACKAGE}-model`);
});

test("the wheel builder is named from brand.ts", () => {
  const py = read("packaging/pypi/build_wheels.py");
  expect(py).toContain(`PRODUCT = "${PYPI_PACKAGE}"`);
  expect(py).toContain(`MODEL_PRODUCT = "${PYPI_PACKAGE}-model"`);
});

test("REPO_OWNER lives only in brand.ts: no packaging source or packer carries it", () => {
  const sources = [
    "packaging/npm/context-fern/package.json",
    "packaging/npm/model/package.json",
    "packaging/npm/platform/package.json",
    "packaging/npm/context-fern/bin/launcher.js",
    "packaging/pypi/build_wheels.py",
    "scripts/pack-npm.ts",
  ];
  for (const f of sources) expect(read(f)).not.toContain(REPO_OWNER);
});

test("the workflow gives the wheel builder REPO_URL from brand.ts", () => {
  const yml = read(".github/workflows/release.yml");
  expect(yml).toContain("--repo-url");
  expect(yml).toContain("import { REPO_URL }");
});

// ---- the real packer's output

let work: string;
let out: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "fern-packaging-brand-"));
  const bundle = join(work, "bundle");
  mkdirSync(bundle);
  const tarball = (name: string, file: string) => {
    const stage = mkdtempSync(join(work, "stage-"));
    writeFileSync(join(stage, file), "x");
    execFileSync("tar", [
      "czf",
      slash(join(bundle, name)),
      "-C",
      slash(stage),
      ...gnu(),
      ".",
    ]);
  };
  tarball("context-fern-linux-x64.tar.gz", "context-fern");
  tarball("model-1.tar.gz", "model.onnx");
  out = join(work, "out");
  const r = spawnSync(
    "bun",
    [
      join(ROOT, "scripts/pack-npm.ts"),
      "--version",
      "0.1.0",
      "--model-version",
      "1.0.0",
      "--bundle-dir",
      bundle,
      "--out",
      out,
    ],
    { encoding: "utf-8", cwd: ROOT },
  );
  if (r.status !== 0) throw new Error(`pack-npm failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
}, 60_000);

test("every packed npm package links to the repository stamped from REPO_URL", () => {
  const tarballs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  expect(tarballs).toHaveLength(3); // model, one platform, launcher
  for (const t of tarballs) {
    const pkg = JSON.parse(
      execFileSync(
        "tar",
        ["xzOf", slash(join(out, t)), ...gnu(), "package/package.json"],
        { encoding: "utf-8" },
      ),
    ) as { homepage?: string; repository?: { type: string; url: string } };
    expect(pkg.homepage, t).toBe(REPO_URL);
    expect(pkg.repository, t).toEqual({
      type: "git",
      url: `git+${REPO_URL}.git`,
    });
  }
});
