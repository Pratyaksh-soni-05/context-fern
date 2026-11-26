import { expect, test } from "bun:test";
import {
  checkDistTags,
  checkInstalled,
  expectedVersions,
  INSTALL_RETRY,
  onlyPlatformPackageMissing,
  platformPackageFor,
} from "../scripts/verify-npm-release";

const RC = expectedVersions("0.1.0-rc.1", "1.0.0-rc.1");

function tagsFor(
  tag: string,
  latest: string,
  expected = RC,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(expected).map(([n, v]) => [n, { latest, [tag]: v }]),
  );
}

test("each supported machine needs exactly its own platform package", () => {
  expect(platformPackageFor("win32", "x64")).toBe("@context-fern/win-x64");
  expect(platformPackageFor("linux", "arm64")).toBe(
    "@context-fern/linux-arm64",
  );
  expect(platformPackageFor("darwin", "arm64")).toBe(
    "@context-fern/darwin-arm64",
  );
  expect(() => platformPackageFor("darwin", "x64")).toThrow();
});

test("a release candidate with rc on every package and latest untouched passes", () => {
  expect(checkDistTags(tagsFor("rc", "0.0.0"), RC, "rc")).toEqual([]);
});

test("a release candidate that became latest on any package is a problem", () => {
  const tags = tagsFor("rc", "0.0.0");
  (tags["context-fern-model"] as Record<string, string>).latest = "1.0.0-rc.1";
  const problems = checkDistTags(tags, RC, "rc");
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("context-fern-model");
  expect(problems[0]).toContain("only promoted to latest by hand");
});

test("a package whose rc tag is wrong, or that is missing, is a problem", () => {
  const tags = tagsFor("rc", "0.0.0");
  (tags["@context-fern/win-x64"] as Record<string, string>).rc = "0.1.0-rc.0";
  delete tags["@context-fern/linux-x64"];
  const problems = checkDistTags(tags, RC, "rc");
  expect(problems.join("\n")).toContain(
    "@context-fern/win-x64: rc is 0.1.0-rc.0",
  );
  expect(problems.join("\n")).toContain(
    "@context-fern/linux-x64: no dist-tags",
  );
});

test("a stable release is checked under next, with latest left where it was", () => {
  const stable = expectedVersions("0.1.0", "1.0.0");
  expect(
    checkDistTags(tagsFor("next", "0.0.0", stable), stable, "next"),
  ).toEqual([]);
  // a package still waiting on its next tag is a problem
  const tags = tagsFor("next", "0.0.0", stable);
  (tags["context-fern-model"] as Record<string, string>).next = "0.9.0";
  expect(checkDistTags(tags, stable, "next")[0]).toContain(
    "context-fern-model: next is 0.9.0",
  );
});

test("a stable release that already moved latest is a problem: promotion is manual, after this check", () => {
  const stable = expectedVersions("0.1.0", "1.0.0");
  const tags = tagsFor("next", "0.0.0", stable);
  (tags["@context-fern/win-x64"] as Record<string, string>).latest = "0.1.0";
  const problems = checkDistTags(tags, stable, "next");
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("@context-fern/win-x64: latest is 0.1.0");
});

test("only a missing platform package is retried; a wrong version or a missing launcher is not", () => {
  const P = "@context-fern/linux-x64";
  expect(
    onlyPlatformPackageMissing(
      { "context-fern": "0.1.0-rc.1", "context-fern-model": "1.0.0-rc.1" },
      P,
    ),
  ).toBe(true);
  expect(
    onlyPlatformPackageMissing(
      {
        "context-fern": "0.1.0-rc.1",
        "context-fern-model": "1.0.0-rc.1",
        [P]: "0.1.0-rc.1",
      },
      P,
    ),
  ).toBe(false);
  expect(onlyPlatformPackageMissing({}, P)).toBe(false);
  expect(
    onlyPlatformPackageMissing({ "context-fern-model": "1.0.0-rc.1" }, P),
  ).toBe(false);
});

test("the install retry lasts several minutes, in steps of 15 s", () => {
  expect(INSTALL_RETRY.everyMs).toBe(15_000);
  const minutes = (INSTALL_RETRY.tries * INSTALL_RETRY.everyMs) / 60_000;
  expect(minutes).toBeGreaterThanOrEqual(3);
  expect(minutes).toBeLessThanOrEqual(10);
});

test("an install that got the launcher, the model and only this machine's platform package at the rc versions passes", () => {
  const installed = {
    "context-fern": "0.1.0-rc.1",
    "context-fern-model": "1.0.0-rc.1",
    "@context-fern/linux-x64": "0.1.0-rc.1",
  };
  expect(checkInstalled(installed, "@context-fern/linux-x64", RC)).toEqual([]);
});

test("an install at the wrong version, missing a package, or with another platform's package is a problem", () => {
  const problems = checkInstalled(
    {
      "context-fern": "0.0.0",
      "@context-fern/win-x64": "0.1.0-rc.1",
      "@context-fern/linux-x64": "0.1.0-rc.1",
    },
    "@context-fern/linux-x64",
    RC,
  );
  const text = problems.join("\n");
  expect(text).toContain("context-fern installed at 0.0.0");
  expect(text).toContain("context-fern-model was not installed");
  expect(text).toContain(
    "@context-fern/win-x64 was installed on a machine that needs",
  );
});
