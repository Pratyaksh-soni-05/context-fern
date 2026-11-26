import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CLI_VERSION } from "../packages/core/src/brand";
import {
  isReleaseCandidate,
  modelVersionFor,
  npmDistTag,
  toPypiVersion,
} from "../scripts/release-version";

const SCRIPT = join(import.meta.dir, "../scripts/release-version.ts");

function run(tag: string) {
  return spawnSync("bun", [SCRIPT, tag], { encoding: "utf-8" });
}

test("a release candidate is spelled the way each registry wants it", () => {
  expect(toPypiVersion("0.1.0")).toBe("0.1.0");
  expect(toPypiVersion("0.1.0-rc.2")).toBe("0.1.0rc2");
  expect(() => toPypiVersion("0.1")).toThrow();
});

test("the tag matching CLI_VERSION and the plugin manifest passes and prints both spellings", () => {
  const r = run(`v${CLI_VERSION}`);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`npm=${CLI_VERSION}`);
  expect(r.stdout).toContain("pypi=");
});

test("a tag that disagrees with CLI_VERSION fails and says to bump both", () => {
  const r = run("v9.9.9");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Bump both");
});

test("a tag that is not a release version fails", () => {
  expect(run("release-1").status).toBe(1);
});

test("a release candidate gets an rc model version from its own rc number; a stable release keeps the model's version", () => {
  expect(modelVersionFor("1.0.0", "0.1.0-rc.3")).toBe("1.0.0-rc.3");
  expect(modelVersionFor("1.0.0", "0.1.0")).toBe("1.0.0");
  expect(() => modelVersionFor("1.0.0-rc.1", "0.1.0")).toThrow();
});

test("a release candidate is tagged rc and a stable release next, never latest; a tag and version that disagree throw", () => {
  expect(npmDistTag("v0.1.0-rc.1", "0.1.0-rc.1")).toBe("rc");
  expect(npmDistTag("v0.1.0", "0.1.0")).toBe("next");
  expect(() => npmDistTag("v0.1.0-rc.1", "0.1.0")).toThrow();
  expect(() => npmDistTag("v0.1.0", "0.1.0-rc.1")).toThrow();
  expect(isReleaseCandidate("0.1.0-rc.1")).toBe(true);
  expect(isReleaseCandidate("0.1.0")).toBe(false);
});

test("the script prints the model versions and the npm tag that matches the current version", () => {
  const r = run(`v${CLI_VERSION}`);
  expect(r.stdout).toContain("model_npm=");
  expect(r.stdout).toContain("model_pypi=");
  // rc for a release candidate, next for a stable version, never latest
  const tag = isReleaseCandidate(CLI_VERSION) ? "rc" : "next";
  expect(r.stdout).toMatch(new RegExp(`^npm_tag=${tag}$`, "m"));
});
