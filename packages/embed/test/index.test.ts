import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "../src/index";

test("package name is embed", () => {
  expect(PACKAGE_NAME).toBe("embed");
});
