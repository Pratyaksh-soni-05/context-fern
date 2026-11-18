import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CLI_VERSION } from "../packages/core/src/brand";
import { toPypiVersion } from "../scripts/release-version";

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
