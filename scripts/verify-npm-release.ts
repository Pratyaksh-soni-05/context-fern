// Checks what is really on the npm registry after `publish-npm` ran, from a
// clean directory on the machine it runs on:
//
//   bun scripts/verify-npm-release.ts --version 0.1.0-rc.1 --model-version 1.0.0-rc.1 --tag rc
//   bun scripts/verify-npm-release.ts --version 0.1.0 --model-version 1.0.0 --tag next
//
// 1. All six packages are on the registry at the expected version (waits for
//    the registry to catch up).
// 2. Each package's `tag` dist-tag (`rc` or `next`) is that version, and
//    `latest` is NOT that version: this job never touches `latest`. The
//    maintainer moves it by hand once every platform is green.
// 3. `npm install context-fern@<tag>` installs the launcher, exactly this
//    machine's platform package and the model, each at the expected version,
//    and `context-fern --version` prints the release version. The registry
//    can hand out stale metadata for a minute or two after a publish, which
//    makes npm skip an optional package without an error, so a missing
//    platform package is retried in a fresh directory (see INSTALL_RETRY).
//
// The checks themselves are pure functions so test/verify-npm-release.test.ts
// can run them offline; only `main` talks to the network.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PLATFORM_PACKAGES = [
  "@context-fern/win-x64",
  "@context-fern/linux-x64",
  "@context-fern/linux-arm64",
  "@context-fern/darwin-arm64",
] as const;
export const MODEL_PACKAGE = "context-fern-model";
export const MAIN_PACKAGE = "context-fern";

const TARGET_OF: Record<string, string> = {
  "win32-x64": "win-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-arm64": "darwin-arm64",
};

export function platformPackageFor(platform: string, arch: string): string {
  const t = TARGET_OF[`${platform}-${arch}`];
  if (!t) throw new Error(`${platform}-${arch} is not a supported target`);
  return `@context-fern/${t}`;
}

export function expectedVersions(
  version: string,
  modelVersion: string,
): Record<string, string> {
  const out: Record<string, string> = {
    [MAIN_PACKAGE]: version,
    [MODEL_PACKAGE]: modelVersion,
  };
  for (const p of PLATFORM_PACKAGES) out[p] = version;
  return out;
}

/** Problems with the dist-tags of every package (`npm view <name> dist-tags --json`). */
export function checkDistTags(
  tagsByPackage: Record<string, Record<string, string> | undefined>,
  expected: Record<string, string>,
  tag: "rc" | "next",
): string[] {
  const problems: string[] = [];
  for (const [name, version] of Object.entries(expected)) {
    const tags = tagsByPackage[name];
    if (!tags) {
      problems.push(`${name}: no dist-tags (is it published?)`);
      continue;
    }
    if (tags[tag] !== version)
      problems.push(`${name}: ${tag} is ${tags[tag]}, expected ${version}`);
    if (tags.latest === version)
      problems.push(
        `${name}: latest is ${version}, but a release is only promoted to latest by hand after this check`,
      );
  }
  return problems;
}

/** Problems with what `npm install` left in node_modules (name to installed version, absent if not installed). */
export function checkInstalled(
  installed: Record<string, string | undefined>,
  platformPackage: string,
  expected: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const name of [MAIN_PACKAGE, MODEL_PACKAGE, platformPackage]) {
    if (installed[name] === undefined)
      problems.push(`${name} was not installed`);
    else if (installed[name] !== expected[name])
      problems.push(
        `${name} installed at ${installed[name]}, expected ${expected[name]}`,
      );
  }
  for (const other of PLATFORM_PACKAGES) {
    if (other !== platformPackage && installed[other] !== undefined)
      problems.push(
        `${other} was installed on a machine that needs ${platformPackage}`,
      );
  }
  return problems;
}

/** How long a missing platform package is retried: 20 tries 15 s apart (about 5 minutes). */
export const INSTALL_RETRY = { tries: 20, everyMs: 15_000 };

/**
 * True when the install left everything but this machine's platform package,
 * which npm skips without an error if the registry has not caught up. Any
 * other problem (a wrong version, a failed install) is real and is not retried.
 */
export function onlyPlatformPackageMissing(
  installed: Record<string, string | undefined>,
  platformPackage: string,
): boolean {
  return (
    installed[platformPackage] === undefined &&
    installed[MAIN_PACKAGE] !== undefined &&
    installed[MODEL_PACKAGE] !== undefined
  );
}

function npm(args: string[], cwd?: string): string {
  return execFileSync("npm", args, {
    encoding: "utf-8",
    cwd,
    shell: process.platform === "win32", // npm is npm.cmd on Windows
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installedVersion(root: string, name: string): string | undefined {
  const file = join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf-8")) as { version: string })
    .version;
}

async function main(): Promise<number> {
  const version = arg("version");
  const modelVersion = arg("model-version");
  const tag = arg("tag") as "rc" | "next";
  if (tag !== "rc" && tag !== "next") throw new Error("--tag is rc or next");
  const expected = expectedVersions(version, modelVersion);

  // The registry can lag a few minutes behind a publish.
  const deadline = Date.now() + 10 * 60_000;
  let tagsByPackage: Record<string, Record<string, string>> = {};
  for (;;) {
    tagsByPackage = {};
    const missing: string[] = [];
    for (const [name, v] of Object.entries(expected)) {
      try {
        npm(["view", `${name}@${v}`, "version"]);
        tagsByPackage[name] = JSON.parse(
          npm(["view", name, "dist-tags", "--json"]),
        );
      } catch {
        missing.push(`${name}@${v}`);
      }
    }
    // Versions and dist-tags can both lag behind a publish, so wait for both.
    const stale =
      missing.length === 0 ? checkDistTags(tagsByPackage, expected, tag) : [];
    if (missing.length === 0 && stale.length === 0) break;
    if (Date.now() > deadline) {
      if (missing.length > 0) {
        console.error(
          `not on the registry after 10 minutes: ${missing.join(", ")}`,
        );
        return 1;
      }
      break; // the dist-tag problems are reported below
    }
    console.log(
      `waiting for the registry: ${[...missing, ...stale].join(", ")}`,
    );
    await sleep(15_000);
  }

  const problems = checkDistTags(tagsByPackage, expected, tag);

  const platformPackage = platformPackageFor(process.platform, process.arch);
  // Each attempt installs into a fresh directory; --prefer-online makes npm
  // ask the registry again instead of trusting a cached package document.
  let dir = "";
  for (let attempt = 1; ; attempt++) {
    dir = mkdtempSync(join(tmpdir(), "fern-verify-npm-"));
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"verify","private":true}\n',
    );
    const attemptProblems: string[] = [];
    try {
      npm(
        [
          "install",
          `${MAIN_PACKAGE}@${tag}`,
          "--prefer-online",
          "--no-audit",
          "--no-fund",
        ],
        dir,
      );
    } catch (e) {
      attemptProblems.push(
        `npm install ${MAIN_PACKAGE}@${tag} failed: ${(e as Error).message}`,
      );
    }
    const installed: Record<string, string | undefined> = {};
    for (const n of [MAIN_PACKAGE, MODEL_PACKAGE, ...PLATFORM_PACKAGES])
      installed[n] = installedVersion(dir, n);
    attemptProblems.push(
      ...checkInstalled(installed, platformPackage, expected),
    );
    const retry =
      onlyPlatformPackageMissing(installed, platformPackage) &&
      attempt < INSTALL_RETRY.tries;
    console.log(
      `install attempt ${attempt}/${INSTALL_RETRY.tries}: ${attemptProblems.length === 0 ? "ok" : attemptProblems.join("; ")}${retry ? `; retrying in ${INSTALL_RETRY.everyMs / 1000} s in a fresh directory` : ""}`,
    );
    if (!retry) {
      problems.push(...attemptProblems);
      break;
    }
    rmSync(dir, { recursive: true, force: true });
    await sleep(INSTALL_RETRY.everyMs);
  }
  try {
    // Run the launcher the way `npx` would, with node: no .cmd shim, no shell.
    const launcher = join(
      dir,
      "node_modules",
      MAIN_PACKAGE,
      "bin",
      "launcher.js",
    );
    try {
      const printed = execFileSync("node", [launcher, "--version"], {
        encoding: "utf-8",
      }).trim();
      if (printed !== version)
        problems.push(
          `context-fern --version printed ${JSON.stringify(printed)}, expected exactly ${version}`,
        );
    } catch (e) {
      problems.push(`context-fern --version failed: ${(e as Error).message}`);
    }
    const scoped = join(dir, "node_modules", "@context-fern");
    console.log(
      `installed ${MAIN_PACKAGE}@${tag}: ${existsSync(scoped) ? readdirSync(scoped).join(", ") : "no platform package"}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const p of problems) console.error(`PROBLEM ${p}`);
  if (problems.length === 0) console.log(`npm ${tag} verified at ${version}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
