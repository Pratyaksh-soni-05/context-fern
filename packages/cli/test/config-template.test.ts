import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@context-fern/core";
import { loadFernConfig } from "@context-fern/store";
import { renderDefaultConfigToml } from "../src/config-template";

test("the rendered default config.toml round-trips through loadFernConfig back to DEFAULT_CONFIG", async () => {
  const toml = renderDefaultConfigToml();
  const path = `${import.meta.dir}/fixtures/rendered-default-config.toml`;
  await Bun.write(path, toml);

  const config = await loadFernConfig(path);
  expect(config).toEqual(DEFAULT_CONFIG);
});
