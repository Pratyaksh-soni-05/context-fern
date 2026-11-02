import {
  handleSessionStart,
  type SessionStartInput,
} from "../src/hook-handlers";
import { readStdinJson, writeJson } from "../src/stdio";

if (import.meta.main) {
  const input = await readStdinJson<SessionStartInput>();
  writeJson(await handleSessionStart(input));
  process.exit(0);
}
