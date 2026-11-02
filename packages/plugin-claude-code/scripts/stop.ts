import { handleStop, type StopInput } from "../src/hook-handlers";
import { readStdinJson, writeJson } from "../src/stdio";

if (import.meta.main) {
  const input = await readStdinJson<StopInput>();
  writeJson(await handleStop(input));
  process.exit(0);
}
