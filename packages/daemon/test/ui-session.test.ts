// UiSessionStore's code/session lifecycle, with an injected `now` so
// expiry is tested deterministically — no real sleeping.

import { expect, test } from "bun:test";
import { UiSessionStore } from "../src/ui-session";

test("a freshly minted code redeems successfully exactly once, then reads as unknown (not expired) on reuse", () => {
  const store = new UiSessionStore();
  const code = store.mintCode(0);
  expect(store.redeemCode(code, 100)).toBe("ok");
  expect(store.redeemCode(code, 200)).toBe("unknown"); // consumed on first lookup
});

test("redeeming a code after its 30s TTL reads as expired, even though it's never been redeemed before", () => {
  const store = new UiSessionStore();
  const code = store.mintCode(0);
  expect(store.redeemCode(code, 30_001)).toBe("expired");
});

test("a code redeemed right at its TTL boundary still succeeds (expiresAt is exclusive, not inclusive)", () => {
  const store = new UiSessionStore();
  const code = store.mintCode(0);
  expect(store.redeemCode(code, 29_999)).toBe("ok");
});

test("redeeming an unknown code reads as unknown", () => {
  const store = new UiSessionStore();
  expect(store.redeemCode("never-minted")).toBe("unknown");
});

test("a minted session is valid immediately and stays valid before its TTL", () => {
  const store = new UiSessionStore();
  const token = store.mintSession(0);
  expect(store.isValidSession(token, 0)).toBe(true);
  expect(store.isValidSession(token, 1000)).toBe(true);
});

test("a session expires after its 24h TTL and is then rejected", () => {
  const store = new UiSessionStore();
  const token = store.mintSession(0);
  const oneDayMs = 24 * 60 * 60 * 1000;
  expect(store.isValidSession(token, oneDayMs + 1)).toBe(false);
});

test("an unknown session token is always invalid", () => {
  const store = new UiSessionStore();
  expect(store.isValidSession("never-minted")).toBe(false);
});

test("the session map is capped — minting beyond the cap evicts the oldest session first", () => {
  const store = new UiSessionStore();
  const tokens: string[] = [];
  for (let i = 0; i < 20; i++) tokens.push(store.mintSession(i));

  // All 20 are still valid — the cap hasn't been exceeded yet.
  for (const t of tokens) expect(store.isValidSession(t, 20)).toBe(true);

  // Minting a 21st evicts the very first one.
  const newest = store.mintSession(21);
  expect(store.isValidSession(tokens[0] ?? "", 22)).toBe(false);
  expect(store.isValidSession(newest, 22)).toBe(true);
  // Every other previously-minted session is still valid.
  for (const t of tokens.slice(1))
    expect(store.isValidSession(t, 22)).toBe(true);
});
