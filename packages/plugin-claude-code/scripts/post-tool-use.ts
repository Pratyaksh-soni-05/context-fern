import { handlePostToolUse, type PostToolUseInput } from "../src/hook-handlers";
import { readStdinJson, writeJson } from "../src/stdio";

if (import.meta.main) {
  const input = await readStdinJson<PostToolUseInput>();
  writeJson(await handlePostToolUse(input));
  process.exit(0);
}
