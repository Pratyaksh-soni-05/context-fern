import { CLI_BINARY_NAME, CLI_NAME } from "./brand";

/**
 * True for the shipped executable (`context-fern` or `fern`, with or without
 * `.exe`), as opposed to `bun run` from a source checkout. Pure: it looks only
 * at the file name, so a path from any OS works.
 */
export function isShippedExecutable(execPath: string): boolean {
  const base = execPath.split(/[/]/).pop() ?? "";
  const name = base.toLowerCase().replace(/\.exe$/, "");
  return name === CLI_BINARY_NAME || name === CLI_NAME;
}
