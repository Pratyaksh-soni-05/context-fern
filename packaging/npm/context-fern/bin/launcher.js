#!/usr/bin/env node
// `context-fern` / `fern` for an npm install or `npx`: finds the platform
// package that carries the real binary and runs it. No postinstall script
// and no download: the binary arrives as an optionalDependency, and the
// embedding model as the `context-fern-model` dependency. The real binary
// is what `context-fern init` copies into a stable per-user directory;
// hooks and the MCP server never go through this file.

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const TARGETS = {
  "win32-x64": "win-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-arm64": "darwin-arm64",
};

function fail(message) {
  process.stderr.write(`context-fern: ${message}\n`);
  process.exit(1);
}

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  fail(
    `${key} is not supported at launch (supported: ${Object.keys(TARGETS).join(", ")}).`,
  );
}

const pkg = `@context-fern/${target}`;
let pkgDir;
try {
  pkgDir = dirname(require.resolve(`${pkg}/package.json`));
} catch {
  fail(
    `the ${pkg} package is not installed. It is an optional dependency, so this happens when optional dependencies were skipped (--omit=optional) or the install was interrupted. Reinstall with: npm install context-fern`,
  );
}

const exe = join(
  pkgDir,
  process.platform === "win32" ? "context-fern.exe" : "context-fern",
);
if (!existsSync(exe)) fail(`${exe} is missing; reinstall context-fern.`);

const env = { ...process.env };
try {
  env.FERN_MODEL_PAYLOAD = join(
    dirname(require.resolve("context-fern-model/package.json")),
    "payload",
  );
} catch {
  // Without the model package, init says so and suggestions stay cue-phrase only.
}

const result = spawnSync(exe, process.argv.slice(2), { stdio: "inherit", env });
if (result.error) fail(`could not start ${exe}: ${result.error.message}`);
process.exit(result.status === null ? 1 : result.status);
