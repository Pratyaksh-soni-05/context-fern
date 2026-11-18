import { expect, test } from "bun:test";
import { CLI_VERSION } from "@context-fern/core";
import { buildId, isShippedBinary, shippedBuildId } from "../src/build-id";

test("the shipped executable is told apart from a source checkout", () => {
  expect(isShippedBinary("C:/x/bin/context-fern.exe")).toBe(true);
  expect(isShippedBinary("/home/a/.local/bin/fern")).toBe(true);
  expect(isShippedBinary("/usr/local/bin/bun")).toBe(false);
  expect(isShippedBinary("C:/bun/bun.exe")).toBe(false);
});

test("two different builds get different ids, so an old daemon is seen as stale", () => {
  expect(shippedBuildId(111_000_000)).not.toBe(shippedBuildId(111_000_001));
  expect(shippedBuildId(111_000_000)).toBe(`${CLI_VERSION}+exe111000000`);
});

test("the same file under both names gets the same id, so fern and context-fern never replace each other's daemon", () => {
  expect(shippedBuildId(111_000_000)).toBe(shippedBuildId(111_000_000));
});

test("if the executable cannot be stat'ed the version alone is used, never a crash", () => {
  expect(shippedBuildId(null)).toBe(CLI_VERSION);
});

test("running from source keeps the checkout fingerprint (version, plus the git sha when there is one)", () => {
  expect(buildId().startsWith("0.0.0")).toBe(true);
});
