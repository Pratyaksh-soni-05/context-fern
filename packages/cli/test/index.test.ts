import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "../src/index";

test("package name is cli", () => {
  expect(PACKAGE_NAME).toBe("cli");
});
