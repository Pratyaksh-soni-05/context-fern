import { expect, test } from "bun:test";
import type { BriefSections } from "@context-fern/store";
import { truncateBriefForContext } from "../src/brief-context";

function sections(overrides: Partial<BriefSections> = {}): BriefSections {
  return {
    Goal: "",
    Decided: "",
    Open: "",
    Files: "",
    Notes: "",
    ...overrides,
  };
}

test("a small brief is rendered in full, under the cap", () => {
  const text = truncateBriefForContext(
    sections({ Goal: "Ship the router.", Decided: "Stage 0 only." }),
  );
  expect(text).toContain("## Goal");
  expect(text).toContain("Ship the router.");
  expect(text).toContain("## Decided");
  expect(text).not.toContain("truncated");
});

test("empty sections are omitted entirely, not rendered as empty headings", () => {
  const text = truncateBriefForContext(sections({ Goal: "Ship it." }));
  expect(text).toContain("## Goal");
  expect(text).not.toContain("## Notes");
  expect(text).not.toContain("## Decided");
});

test("an oversized Notes section is truncated first, Goal/Decided/Open/Files stay intact", () => {
  const text = truncateBriefForContext(
    sections({
      Goal: "Ship the router.",
      Decided: "Stage 0 only.",
      Notes: "x".repeat(20_000),
    }),
    1024,
  );
  expect(text).toContain("## Goal");
  expect(text).toContain("Ship the router.");
  expect(text).toContain("## Decided");
  expect(text).toContain("Stage 0 only.");
  expect(text).toContain("truncated");
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
});

test("even with Notes emptied, output over the cap is hard-truncated and still fits", () => {
  const text = truncateBriefForContext(
    sections({ Goal: "g".repeat(5000), Notes: "n".repeat(5000) }),
    1024,
  );
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
});
