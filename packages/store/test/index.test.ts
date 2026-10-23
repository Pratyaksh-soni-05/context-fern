import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "../src/index";

test("package name is store", () => {
  expect(PACKAGE_NAME).toBe("store");
});
