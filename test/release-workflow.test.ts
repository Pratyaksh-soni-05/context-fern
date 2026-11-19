// The decisions about which tag publishes where live in release.yml's job
// conditions and one shell step. This pins them, so a later edit cannot
// quietly send a release candidate to PyPI proper or publish to npm without
// the tag guard.

import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const yml = readFileSync(
  join(import.meta.dir, "../.github/workflows/release.yml"),
  "utf-8",
);

const D = "$"; // keeps the shell's parameter expansion out of lint's template-string check

function job(name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("npm publishes both release candidates and stable releases, gated on PUBLISH_ENABLED and a public repo", () => {
  const j = job("publish-npm");
  expect(j).not.toContain("-rc.'");
  expect(j).toContain("vars.PUBLISH_ENABLED == 'true'");
  expect(j).toContain("github.event.repository.private == false");
  expect(j).toContain("environment: npm");
});

test("PyPI proper still skips release candidates and TestPyPI still takes only them", () => {
  expect(job("publish-pypi")).toContain("!contains(github.ref_name, '-rc.')");
  expect(job("publish-testpypi")).toContain(
    "contains(github.ref_name, '-rc.')",
  );
  expect(job("publish-testpypi")).not.toContain("!contains");
});

// ---- the publish step itself, run for real against stub tarballs and a fake npm

/** The `run:` body of the step called `publish` in the publish-npm job, dedented. */
function publishScript(): string {
  const lines = job("publish-npm").split("\n");
  const at = lines.findIndex((l) => l === "      - name: publish");
  const run = lines.findIndex((l, i) => i > at && l === "        run: |");
  if (at < 0 || run < 0) throw new Error("publish step not found");
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return `${body.join("\n")}\n`;
}

const slash = (p: string) => p.replaceAll("\\", "/");
const gnu = () =>
  execFileSync("tar", ["--version"], { encoding: "utf-8" }).includes("GNU")
    ? ["--force-local"]
    : [];

function stubTarball(dir: string, file: string, name: string, version: string) {
  const stage = mkdtempSync(join(dir, "stage-"));
  mkdirSync(join(stage, "package"));
  writeFileSync(
    join(stage, "package", "package.json"),
    JSON.stringify({ name, version }),
  );
  execFileSync("tar", [
    "czf",
    slash(join(dir, "packages", "npm", file)),
    "-C",
    slash(stage),
    ...gnu(),
    "package",
  ]);
}

/** Runs the real publish step. `versions` are [launcher, platforms, model]. */
function runPublish(
  refName: string,
  versions: { main: string; model: string; mixed?: string },
  options: { omit?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "fern-publish-step-"));
  try {
    mkdirSync(join(dir, "packages", "npm"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    const all: [string, string, string][] = [
      ["context-fern-model", "context-fern-model", versions.model],
      ["context-fern-win-x64", "@context-fern/win-x64", versions.main],
      ["context-fern-linux-x64", "@context-fern/linux-x64", versions.main],
      [
        "context-fern-linux-arm64",
        "@context-fern/linux-arm64",
        versions.mixed ?? versions.main,
      ],
      [
        "context-fern-darwin-arm64",
        "@context-fern/darwin-arm64",
        versions.main,
      ],
      ["context-fern", "context-fern", versions.main],
    ];
    for (const [stem, name, v] of all)
      if (stem !== options.omit) stubTarball(dir, `${stem}-${v}.tgz`, name, v);
    // A fake npm: records every call; `view` says "not published yet".
    writeFileSync(
      join(dir, "bin", "npm"),
      '#!/bin/sh\necho "$@" >> "$NPM_LOG"\n[ "$1" = view ] && exit 1\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "step.sh"), publishScript());
    const r = spawnSync("bash", ["-e", "step.sh"], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
        NPM_LOG: join(dir, "npm.log"),
        REF_NAME: refName,
      },
    });
    const log = existsSync(join(dir, "npm.log"))
      ? readFileSync(join(dir, "npm.log"), "utf-8").split("\n").filter(Boolean)
      : [];
    const publishes = log.filter((l) => l.startsWith("publish "));
    return { r, publishes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RC = { main: "0.1.0-rc.1", model: "1.0.0-rc.1" };
const STABLE = { main: "0.1.0", model: "1.0.0" };

test("a release candidate publishes all six, the launcher last, each under --tag rc", () => {
  const { r, publishes } = runPublish("v0.1.0-rc.1", RC);
  expect(r.status).toBe(0);
  expect(publishes).toHaveLength(6);
  expect(publishes[0]).toContain("context-fern-model-1.0.0-rc.1.tgz");
  expect(publishes[5]).toContain("packages/npm/context-fern-0.1.0-rc.1.tgz");
  for (const p of publishes) {
    expect(p).toContain("--tag rc");
    expect(p).toContain("--access public");
    expect(p).toContain("--provenance");
  }
}, 60_000);

test("a stable release publishes all six with no --tag, so latest moves, the launcher last", () => {
  const { r, publishes } = runPublish("v0.1.0", STABLE);
  expect(r.status).toBe(0);
  expect(publishes).toHaveLength(6);
  expect(publishes[5]).toContain("packages/npm/context-fern-0.1.0.tgz");
  for (const p of publishes) expect(p).not.toContain("--tag");
}, 60_000);

test("a release-candidate tag with a stable tarball, or a stable tag with an rc one, publishes nothing at all", () => {
  for (const [ref, versions] of [
    ["v0.1.0-rc.1", { ...RC, mixed: "0.1.0" }],
    ["v0.1.0", { ...STABLE, mixed: "0.1.0-rc.1" }],
    ["v0.1.0", RC],
    ["v0.1.0-rc.1", STABLE],
  ] as const) {
    const { r, publishes } = runPublish(ref, versions);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("refusing to publish anything");
    expect(publishes).toEqual([]);
  }
}, 60_000);

test("fewer than six tarballs publishes nothing", () => {
  const { r, publishes } = runPublish("v0.1.0-rc.1", RC, {
    omit: "context-fern-darwin-arm64",
  });
  expect(r.status).not.toBe(0);
  expect(publishes).toEqual([]);
}, 60_000);

test("the publish step uses no dist-tag command, so only 'Allow npm publish' is needed", () => {
  expect(publishScript()).not.toContain("dist-tag");
  expect(publishScript()).not.toContain("--tag latest");
});

test("the registry verification runs after publish-npm on all four platforms and reads only public data", () => {
  const j = job("verify-npm");
  expect(j).toContain("needs: [package, publish-npm]");
  for (const os of [
    "ubuntu-latest",
    "ubuntu-24.04-arm",
    "windows-latest",
    "macos-latest",
  ])
    expect(j).toContain(os);
  expect(j).not.toContain("id-token");
  expect(j).toContain("contents: read");
});

test("the packages are stamped with the release's model version, and the dry run uses the tag the real publish will", () => {
  const j = job("package");
  expect(j).toContain("steps.version.outputs.model_npm");
  expect(j).toContain("steps.version.outputs.model_pypi");
  expect(j).toContain(
    `--dry-run --access public ${D}{NPM_TAG:+--tag "$NPM_TAG"}`,
  );
  expect(j).not.toContain("cat packaging/MODEL_VERSION");
});
