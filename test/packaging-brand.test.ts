// Packaging files cannot import brand.ts (JSON, JavaScript, Python), so
// this is the one place that proves they still agree with it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_BINARY_NAME,
  NPM_PACKAGE,
  PYPI_PACKAGE,
  REPO_URL,
} from "../packages/core/src/brand";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

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

test("the wheel builder is named from brand.ts and points at the repo", () => {
  const py = read("packaging/pypi/build_wheels.py");
  expect(py).toContain(`PRODUCT = "${PYPI_PACKAGE}"`);
  expect(py).toContain(`MODEL_PRODUCT = "${PYPI_PACKAGE}-model"`);
  expect(py).toContain(`HOMEPAGE = "${REPO_URL}"`);
  for (const p of ["context-fern", "model", "platform"]) {
    expect(String(json(`packaging/npm/${p}/package.json`).homepage)).toBe(
      REPO_URL,
    );
  }
});
