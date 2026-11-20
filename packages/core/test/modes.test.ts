import { expect, test } from "bun:test";
import { AVAILABLE_MODES, checkMode } from "../src/modes";

test("observe and suggest are the modes a user can pick", () => {
  expect([...AVAILABLE_MODES]).toEqual(["observe", "suggest"]);
  expect(checkMode("observe")).toEqual({ ok: true, mode: "observe" });
  expect(checkMode("suggest")).toEqual({ ok: true, mode: "suggest" });
});

test("isolate mode is refused with a message that says it is not available and what to run instead", () => {
  const checked = checkMode("isolate");
  expect(checked.ok).toBe(false);
  if (checked.ok) return;
  expect(checked.message).toContain(
    "isolate mode is not available in this release",
  );
  expect(checked.message).toContain("mode suggest");
});

test("anything else is refused as not a mode, whatever its type", () => {
  for (const bad of ["", "Suggest", "bogus", undefined, null, 3, {}]) {
    const checked = checkMode(bad);
    expect(checked.ok, String(bad)).toBe(false);
    if (!checked.ok) expect(checked.message).toContain("is not a mode");
  }
});

test("a long unknown mode is cut in the message instead of echoed whole", () => {
  const checked = checkMode("x".repeat(500));
  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.message.length).toBeLessThan(200);
});
