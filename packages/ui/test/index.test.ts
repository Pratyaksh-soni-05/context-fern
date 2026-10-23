import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "../src/index";

test("package name is ui", () => {
  expect(PACKAGE_NAME).toBe("ui");
});
