import { expect, test } from "bun:test";
import { CLI_NAME, CONFIG_DIR, ENV_PREFIX, PRODUCT_NAME } from "../src/brand";

test("brand constants are set", () => {
  expect(PRODUCT_NAME).toBe("ContextTree");
  expect(CLI_NAME).toBe("ctree");
  expect(CONFIG_DIR).toBe(".contexttree");
  expect(ENV_PREFIX).toBe("CONTEXTTREE_");
});
