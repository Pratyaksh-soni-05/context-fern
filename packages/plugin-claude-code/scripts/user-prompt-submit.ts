import {
  handleUserPromptSubmit,
  type UserPromptSubmitInput,
} from "../src/hook-handlers";
import { readStdinJson, writeJson } from "../src/stdio";

if (import.meta.main) {
  const input = await readStdinJson<UserPromptSubmitInput>();
  writeJson(await handleUserPromptSubmit(input));
  // A successful fetch to the daemon leaves a keep-alive socket open,
  // which would otherwise keep this short-lived process alive — exit
  // explicitly rather than waiting for the event loop to drain.
  process.exit(0);
}
