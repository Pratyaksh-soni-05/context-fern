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

test("each PyPI job uploads one project per `uv publish`, the model wheel first, each with its own token and --check-url", () => {
  const cases = [
    {
      name: "publish-testpypi",
      env: "environment: testpypi",
      index: "https://test.pypi.org/simple/",
      extra: "--publish-url https://test.pypi.org/legacy/",
    },
    {
      name: "publish-pypi",
      env: "environment: pypi",
      index: "https://pypi.org/simple/",
      extra: "",
    },
  ];
  for (const c of cases) {
    const j = job(c.name);
    // command lines only: the comments above them mention `uv publish` too
    const calls = j.split(/^\s+uv publish /m).slice(1);
    expect(calls.length).toBe(2);
    // the model wheel first, then the platform wheels; the two globs cannot overlap
    expect(calls[0]).toContain("packages/pypi/context_fern_model-*.whl");
    expect(calls[1]).toContain("packages/pypi/context_fern-*.whl");
    for (const call of calls) {
      expect(call).toContain("--trusted-publishing always");
      expect(call).toContain(`--check-url ${c.index}`);
      if (c.extra) expect(call).toContain(c.extra);
      expect(call).not.toContain("packages/pypi/*");
    }
    // unchanged: the Environment and the permissions
    expect(j).toContain(c.env);
    expect(j).toContain("id-token: write");
  }
  // unchanged: the conditions
  expect(job("publish-testpypi")).toContain(
    "vars.PUBLISH_TEST_ENABLED == 'true'",
  );
  expect(job("publish-pypi")).toContain("vars.PUBLISH_ENABLED == 'true'");
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
  options: { omit?: string; hide?: string; already?: string[] } = {},
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
    // A fake npm: records every call. `publish` remembers name@version from
    // the tarball; `view name@version` succeeds only for a remembered one,
    // except the one named in HIDE, which never becomes visible.
    writeFileSync(
      join(dir, "bin", "npm"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$NPM_LOG"',
        'if [ "$1" = publish ]; then',
        '  tar xzOf "$2" package/package.json | node -p \'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));p.name+"@"+p.version\' >> "$NPM_PUBLISHED"',
        "  exit 0",
        "fi",
        'if [ "$1" = view ]; then',
        '  [ -n "$HIDE" ] && [ "$2" = "$HIDE" ] && exit 1',
        '  grep -qxF "$2" "$NPM_PUBLISHED" 2>/dev/null && exit 0',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // name@version pairs that are already on the registry before the step starts
    writeFileSync(
      join(dir, "published.txt"),
      (options.already ?? []).map((l) => `${l}\n`).join(""),
    );
    writeFileSync(join(dir, "step.sh"), publishScript());
    const r = spawnSync("bash", ["-e", "step.sh"], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
        NPM_LOG: join(dir, "npm.log"),
        NPM_PUBLISHED: join(dir, "published.txt"),
        HIDE: options.hide ?? "",
        VISIBLE_POLL_TRIES: "3",
        VISIBLE_POLL_SECONDS: "0",
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

test("a stable release publishes all six under --tag next, so latest does not move, the launcher last", () => {
  const { r, publishes } = runPublish("v0.1.0", STABLE);
  expect(r.status).toBe(0);
  expect(publishes).toHaveLength(6);
  expect(publishes[5]).toContain("packages/npm/context-fern-0.1.0.tgz");
  for (const p of publishes) {
    expect(p).toContain("--tag next");
    expect(p).not.toContain("--tag latest");
  }
}, 60_000);

test("the launcher is published only after the model and the four platform packages are visible on the registry", () => {
  const { r, publishes } = runPublish("v0.1.0-rc.1", RC);
  expect(r.status).toBe(0);
  expect(publishes).toHaveLength(6);
  // the launcher is the last publish, after the five others
  expect(publishes.slice(0, 5).join("\n")).not.toContain(
    "packages/npm/context-fern-0.1.0-rc.1.tgz",
  );
  expect(publishes[5]).toContain("packages/npm/context-fern-0.1.0-rc.1.tgz");
}, 60_000);

test("a re-run after the five were published (and a launcher that was not) skips the five and publishes only the launcher", () => {
  const { r, publishes } = runPublish("v0.1.0-rc.1", RC, {
    already: [
      "context-fern-model@1.0.0-rc.1",
      "@context-fern/win-x64@0.1.0-rc.1",
      "@context-fern/linux-x64@0.1.0-rc.1",
      "@context-fern/linux-arm64@0.1.0-rc.1",
      "@context-fern/darwin-arm64@0.1.0-rc.1",
    ],
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("is already published, skipping");
  expect(publishes).toHaveLength(1);
  expect(publishes[0]).toContain("packages/npm/context-fern-0.1.0-rc.1.tgz");
}, 60_000);

test("if one of the five never becomes visible, the launcher is not published and the step says so", () => {
  const { r, publishes } = runPublish("v0.1.0-rc.1", RC, {
    hide: "@context-fern/linux-arm64@0.1.0-rc.1",
  });
  expect(r.status).not.toBe(0);
  expect(r.stdout).toContain(
    "waiting for @context-fern/linux-arm64@0.1.0-rc.1 on the registry",
  );
  expect(r.stdout).toContain("the launcher was NOT published");
  expect(publishes).toHaveLength(5);
  expect(publishes.join("\n")).not.toContain("context-fern-0.1.0-rc.1.tgz");
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
    "ubuntu-24.04",
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

test("no release job runs on a moving ubuntu-latest: every Linux runner is pinned to ubuntu-24.04", () => {
  expect(yml).not.toContain("ubuntu-latest");
  for (const name of ["config", "model", "checksums", "package"]) {
    expect(job(name), name).toContain("runs-on: ubuntu-24.04\n");
  }
});

test("every action is pinned by a full commit SHA with its version in a comment, and the actions that were on Node 20 are the Node 24 releases", () => {
  const uses = [...yml.matchAll(/^\s*(?:- )?uses: (\S+)@(\S+) # (\S+)\s*$/gm)];
  expect(uses.length).toBeGreaterThan(15);
  for (const [line, action, ref, version] of uses) {
    expect(ref, line).toMatch(/^[0-9a-f]{40}$/);
    expect(version, line).toMatch(/^v\d/);
    expect(action, line).not.toContain("@");
  }
  // SHAs checked against the upstream tags (docs/decisions.md): all of these declare `using: node24`.
  const pinned = (action: string) =>
    new Set(uses.filter((u) => u[1] === action).map((u) => `${u[2]} ${u[3]}`));
  expect(pinned("actions/checkout")).toEqual(
    new Set(["3d3c42e5aac5ba805825da76410c181273ba90b1 v7.0.1"]),
  );
  expect(pinned("actions/upload-artifact")).toEqual(
    new Set(["cf430e030ddbb5b0abf93d22962f4752f3646cd9 v7.0.2"]),
  );
  expect(pinned("actions/download-artifact")).toEqual(
    new Set(["9000827ccba6bdab643e8b6fd33ac0654aef8333 v8.0.2"]),
  );
  expect(pinned("actions/setup-node")).toEqual(
    new Set(["949feb2413d6458794dcd2491c4babbbce0c15c1 v7.1.0"]),
  );
});

test("ci.yml uses the same checkout and a Node 24 setup-uv, and keeps its two required check names", () => {
  const ci = readFileSync(
    join(import.meta.dir, "../.github/workflows/ci.yml"),
    "utf-8",
  );
  expect(ci).toContain(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  );
  expect(ci).toContain(
    "astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3",
  );
  // the required checks are "test (ubuntu-latest)" and "test (windows-latest)": the job name plus matrix.os
  expect(ci).toMatch(/^ {2}test:\n {4}strategy:/m);
  expect(ci).toContain("os: [ubuntu-latest, windows-latest]");
  expect(ci).not.toMatch(/^ {4}name:/m);
});
