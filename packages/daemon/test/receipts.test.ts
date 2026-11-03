import { expect, test } from "bun:test";
import {
  mergedReceipt,
  newSuggestionReceipt,
  onFrondReceipt,
  returnedReceipt,
  returnSuggestionReceipt,
  statuslineReceipt,
  statusReceipt,
  strayMarkedReceipt,
  strayReceipt,
  undoneReceipt,
} from "../src/receipts";

// Literal strings from docs/spec.md §7.

test("newSuggestionReceipt matches spec §7's literal example", () => {
  expect(
    newSuggestionReceipt("docker-build", 0.86, [
      "cue phrase",
      "no file overlap",
    ]),
  ).toBe(
    "fern ▸ new frond? docker-build · 0.86 · cue phrase, no file overlap · /fern new",
  );
});

test("newSuggestionReceipt asks for a name explicitly, never a placeholder, when none was proposed", () => {
  expect(newSuggestionReceipt(null, 0.9, ["cue phrase"])).toBe(
    "fern ▸ new frond? · 0.90 · cue phrase · /fern new <name>",
  );
});

test("onFrondReceipt matches spec §7's literal example", () => {
  expect(onFrondReceipt("docker-build", "auth-refactor")).toBe(
    "fern ▸ on docker-build · auth-refactor rests with its brief",
  );
});

test("onFrondReceipt with no resting frond (the very first topic) omits the rests clause", () => {
  expect(onFrondReceipt("docker-build", null)).toBe("fern ▸ on docker-build");
});

test("strayReceipt matches spec §7's literal example", () => {
  expect(strayReceipt()).toBe("fern ▸ stray · answered, kept off every frond");
});

test("strayMarkedReceipt matches spec §7's literal example", () => {
  expect(strayMarkedReceipt()).toBe(
    "fern ▸ stray (marked) · answered, kept off every frond · /fern undo",
  );
});

test("returnedReceipt matches spec §7's literal example", () => {
  expect(returnedReceipt("auth-refactor", 0.88)).toBe(
    "fern ▸ returned to auth-refactor · 0.88 · /fern undo",
  );
});

test("statuslineReceipt matches spec §7's format when ctx numbers are real", () => {
  expect(statuslineReceipt("auth-refactor", 4, 3, 18000, 96000)).toBe(
    "fern ▸ auth-refactor · 4 fronds · 3 strays · 18k/96k ctx",
  );
});

test("statusReceipt (fern status's own, richer receipt) includes the leaflet count and mode", () => {
  expect(statusReceipt("stem", 0, 0, 3, "suggest")).toBe(
    "fern ▸ stem · 0 fronds · 0 strays · 3 leaflets · suggest",
  );
});

test("statuslineReceipt omits the ctx clause entirely when nothing has been measured, rather than printing a fabricated 0/0", () => {
  expect(statuslineReceipt("auth-refactor", 4, 3, 0, 0)).toBe(
    "fern ▸ auth-refactor · 4 fronds · 3 strays",
  );
});

test("statuslineReceipt and statusReceipt pluralize every count correctly at exactly 1", () => {
  expect(statuslineReceipt("greetings", 1, 1, 0, 0)).toBe(
    "fern ▸ greetings · 1 frond · 1 stray",
  );
  expect(statusReceipt("greetings", 1, 1, 1, "suggest")).toBe(
    "fern ▸ greetings · 1 frond · 1 stray · 1 leaflet · suggest",
  );
});

test("returnSuggestionReceipt follows the same voice as the new-suggestion receipt", () => {
  expect(returnSuggestionReceipt("auth-refactor", 0.72, ["cue phrase"])).toBe(
    "fern ▸ return to auth-refactor? · 0.72 · cue phrase · /fern switch",
  );
});

test("undoneReceipt and mergedReceipt start with the fern ▸ voice marker", () => {
  expect(undoneReceipt("new")).toStartWith("fern ▸ ");
  expect(mergedReceipt("docker-build")).toStartWith("fern ▸ ");
});
