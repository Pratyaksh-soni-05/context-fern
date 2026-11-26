// One version, checked everywhere, before anything is packed.
//
//   bun scripts/release-version.ts v0.1.0-rc.1
//
// Fails unless the tag matches CLI_VERSION (packages/core/src/brand.ts)
// and the Claude Code plugin manifest's "version" — the same two strings
// `context-fern hook` compares at runtime. Prints the version in each
// registry's own spelling: npm takes semver (0.1.0-rc.1), PyPI takes PEP
// 440 (0.1.0rc1), and the model package's version for this release and the
// npm dist-tag to publish under (`rc` or `next`, never `latest`). Run by the
// release workflow's package job.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "../packages/core/src/brand";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-(rc)\.(\d+))?$/;

export function toPypiVersion(semver: string): string {
  const m = SEMVER.exec(semver);
  if (!m) throw new Error(`not a release version: ${semver}`);
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  return m[4] ? `${base}rc${m[5]}` : base;
}

/** True for `X.Y.Z-rc.N`, false for `X.Y.Z`; anything else is not a release version. */
export function isReleaseCandidate(semver: string): boolean {
  const m = SEMVER.exec(semver);
  if (!m) throw new Error(`not a release version: ${semver}`);
  return m[4] !== undefined;
}

/**
 * The model package's version for a release: its own version when the
 * release is stable, `<model>-rc.N` (N from the release's rc number) for a
 * release candidate. An npm version can never be published twice, so a
 * candidate must not use up the model's real version.
 */
export function modelVersionFor(model: string, release: string): string {
  const m = SEMVER.exec(model);
  if (!m || m[4]) throw new Error(`the model version must be X.Y.Z: ${model}`);
  const r = SEMVER.exec(release);
  if (!r) throw new Error(`not a release version: ${release}`);
  return r[4] ? `${model}-rc.${r[5]}` : model;
}

/**
 * The npm dist-tag a version must be published under: `rc` for a release
 * candidate, `next` for a stable version. Neither is `latest`: the
 * maintainer moves `latest` by hand once the release is verified. Throws if
 * the tag and the version disagree, so a stable release can never be tagged
 * `rc` and a candidate can never be tagged `next`.
 */
export function npmDistTag(refName: string, version: string): "rc" | "next" {
  const fromRef = isReleaseCandidate(refName.replace(/^v/, ""));
  if (fromRef !== isReleaseCandidate(version))
    throw new Error(
      `${refName} and ${version} disagree about being a release candidate`,
    );
  return fromRef ? "rc" : "next";
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) {
    console.error(
      `release-version: "${tag}" is not vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N`,
    );
    process.exit(1);
  }
  const plugin = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../packages/plugin-claude-code/.claude-plugin/plugin.json",
      ),
      "utf-8",
    ),
  ) as { version: string };
  const problems: string[] = [];
  if (CLI_VERSION !== version) problems.push(`CLI_VERSION is ${CLI_VERSION}`);
  if (plugin.version !== version)
    problems.push(`plugin.json version is ${plugin.version}`);
  if (problems.length > 0) {
    console.error(
      `release-version: tag says ${version} but ${problems.join(" and ")}. Bump both, commit, and tag again.`,
    );
    process.exit(1);
  }
  const model = readFileSync(
    join(import.meta.dir, "../packaging/MODEL_VERSION"),
    "utf-8",
  ).trim();
  const modelVersion = modelVersionFor(model, version);
  console.log(`npm=${version}`);
  console.log(`pypi=${toPypiVersion(version)}`);
  console.log(`model_npm=${modelVersion}`);
  console.log(`model_pypi=${toPypiVersion(modelVersion)}`);
  console.log(`npm_tag=${npmDistTag(tag, version)}`);
}
