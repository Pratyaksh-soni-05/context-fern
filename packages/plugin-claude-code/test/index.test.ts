import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "../src/index";

test("package name is plugin-claude-code", () => {
  expect(PACKAGE_NAME).toBe("plugin-claude-code");
});
