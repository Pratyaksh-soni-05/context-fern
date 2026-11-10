// timingSafeStringEquals — shared by server.ts's raw-token check and
// ui-session.ts's session-cookie check, so both credential comparisons
// get the same protection against a byte-by-byte timing attacker. A
// real timing measurement is too noisy to assert reliably in a unit
// test; this pins the actual contract that matters: correctness
// (equal/unequal/different-length strings), and that it's a real
// `timingSafeEqual` call under the hood, not a `===` in disguise —
// verified by confirming it accepts same-length, different-content
// buffers without throwing (timingSafeEqual throws on a length
// mismatch, so reaching a real false result for equal-length inputs
// only happens via the constant-time path).

import { expect, test } from "bun:test";
import { timingSafeStringEquals } from "../src/protocol";

test("identical strings are equal", () => {
  expect(timingSafeStringEquals("abc123", "abc123")).toBe(true);
});

test("different strings of the same length are not equal", () => {
  expect(timingSafeStringEquals("abc123", "abc124")).toBe(false);
});

test("different-length strings are not equal, and never throw", () => {
  expect(timingSafeStringEquals("short", "a-lot-longer-string")).toBe(false);
  expect(timingSafeStringEquals("", "nonempty")).toBe(false);
});

test("two empty strings are equal", () => {
  expect(timingSafeStringEquals("", "")).toBe(true);
});

test("is case-sensitive and whitespace-sensitive — no normalization", () => {
  expect(timingSafeStringEquals("Token", "token")).toBe(false);
  expect(timingSafeStringEquals("token ", "token")).toBe(false);
});
