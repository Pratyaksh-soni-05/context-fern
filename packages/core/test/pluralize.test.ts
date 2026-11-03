import { expect, test } from "bun:test";
import { pluralize } from "../src/pluralize";

test("pluralize: singular word for exactly 1, default 's'-suffixed plural otherwise", () => {
  expect(pluralize(1, "frond")).toBe("1 frond");
  expect(pluralize(2, "frond")).toBe("2 fronds");
});

test("pluralize: 0 and anything other than exactly 1 use the plural form", () => {
  expect(pluralize(2, "stray")).toBe("2 strays");
  expect(pluralize(0, "stray")).toBe("0 strays");
  expect(pluralize(-1, "stray")).toBe("-1 strays");
});

test("pluralize: an explicit irregular plural overrides the default 's' suffix", () => {
  expect(pluralize(1, "memory", "memories")).toBe("1 memory");
  expect(pluralize(2, "memory", "memories")).toBe("2 memories");
  expect(pluralize(0, "memory", "memories")).toBe("0 memories");
});
