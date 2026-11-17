import { expect, test } from "bun:test";
import {
  alreadyOnFrondReceipt,
  alreadyOnReceipt,
  mergedReceipt,
  newSuggestionReceipt,
  onFrondReceipt,
  returnedReceipt,
  returnSuggestionReceipt,
  statuslineReceipt,
  statusReceipt,
  strayMarkedReceipt,
  strayReceipt,
  straySuggestionReceipt,
  undoneReceipt,
} from "../src/receipts";

// Literal strings from docs/spec.md §7.

test("newSuggestionReceipt matches spec §7's literal example: the signal, no invented number", () => {
  expect(newSuggestionReceipt("docker-build", null, ["cue:new"])).toBe(
    "fern ▸ new frond? docker-build · cue phrase · /fern new",
  );
});

test("a measured Stage 0 score is still shown, ahead of the signals", () => {
  expect(
    newSuggestionReceipt("docker-build", 0.86, [
      "no-frond-match",
      "file-divergence",
    ]),
  ).toBe(
    "fern ▸ new frond? docker-build · 0.86 · no frond match, file divergence · /fern new",
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

test("returnedReceipt matches spec §7's literal example: a manual switch carries no number", () => {
  expect(returnedReceipt("auth-refactor")).toBe(
    "fern ▸ returned to auth-refactor · /fern undo",
  );
});

test("alreadyOnFrondReceipt says nothing was done", () => {
  expect(alreadyOnFrondReceipt("cleanup")).toBe("fern ▸ already on cleanup");
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

test("a suggestion without a measured score shows its signal, never a number or a placeholder", () => {
  expect(newSuggestionReceipt("auth-work", null, ["cue:new"])).toBe(
    "fern ▸ new frond? auth-work · cue phrase · /fern new",
  );
  expect(straySuggestionReceipt(null, ["cue:stray"])).toBe(
    "fern ▸ stray? · cue phrase · /fern stray",
  );
  expect(returnSuggestionReceipt("auth-work", null, ["cue:return"])).toBe(
    "fern ▸ return to auth-work? · cue phrase · /fern switch",
  );
  // the degraded tag is reported elsewhere, not repeated in every receipt
  expect(
    newSuggestionReceipt("auth-work", null, [
      "cue:new",
      "degraded:no-embedding",
    ]),
  ).toBe("fern ▸ new frond? auth-work · cue phrase · /fern new");
  expect(newSuggestionReceipt(null, null, [])).toBe(
    "fern ▸ new frond? · /fern new <name>",
  );
});

test("a dash stands in only where a similarity number would have gone and no model could measure one", () => {
  // degraded, no named signal: the number's slot, honestly empty
  expect(
    newSuggestionReceipt("auth-work", null, ["degraded:no-embedding"]),
  ).toBe("fern ▸ new frond? auth-work · — · /fern new");
  // degraded but driven by a cue phrase: the cue names itself, no dash
  expect(
    newSuggestionReceipt("auth-work", null, [
      "cue:new",
      "degraded:no-embedding",
    ]),
  ).toBe("fern ▸ new frond? auth-work · cue phrase · /fern new");
  // not degraded and no score: nothing to stand in for, nothing shown
  expect(newSuggestionReceipt("auth-work", null, [])).toBe(
    "fern ▸ new frond? auth-work · /fern new",
  );
});

test("statusReceipt names the frond-opening leaflets inside the leaflet count, and stays unchanged when there are none", () => {
  expect(statusReceipt("auth", 1, 0, 5, "suggest", 1)).toBe(
    "fern ▸ auth · 1 frond · 0 strays · 5 leaflets · 1 frond opening · suggest",
  );
  expect(statusReceipt("auth", 2, 0, 7, "suggest", 2)).toBe(
    "fern ▸ auth · 2 fronds · 0 strays · 7 leaflets · 2 frond openings · suggest",
  );
  expect(statusReceipt("stem", 0, 0, 3, "suggest")).toBe(
    "fern ▸ stem · 0 fronds · 0 strays · 3 leaflets · suggest",
  );
});

test("alreadyOnReceipt says nothing was done", () => {
  expect(alreadyOnReceipt("greetings")).toBe(
    "fern ▸ greetings already exists · already on it",
  );
});
