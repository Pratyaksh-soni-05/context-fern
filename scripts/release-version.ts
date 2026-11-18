// One version, checked everywhere, before anything is packed.
//
//   bun scripts/release-version.ts v0.1.0-rc.1
//
// Fails unless the tag matches CLI_VERSION (packages/core/src/brand.ts)
// and the Claude Code plugin manifest's "version" — the same two strings
// `context-fern hook` compares at runtime. Prints the version in each
// registry's own spelling: npm takes semver (0.1.0-rc.1), PyPI takes PEP
// 440 (0.1.0rc1). Run by the release workflow's package job.

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
  console.log(`npm=${version}`);
  console.log(`pypi=${toPypiVersion(version)}`);
}
