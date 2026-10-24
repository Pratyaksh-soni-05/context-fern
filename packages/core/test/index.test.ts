import { expect, test } from "bun:test";
import {
  CLI_NAME,
  CONFIG_DIR,
  ENV_PREFIX,
  NPM_PACKAGE,
  PRODUCT_NAME,
  PYPI_PACKAGE,
} from "../src/brand";

test("brand constants are set", () => {
  expect(PRODUCT_NAME).toBe("Context Fern");
  expect(CLI_NAME).toBe("fern");
  expect(CONFIG_DIR).toBe(".fern");
  expect(ENV_PREFIX).toBe("FERN_");
  expect(NPM_PACKAGE).toBe("context-fern");
  expect(PYPI_PACKAGE).toBe("context-fern");
});
