import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * `mkdir -p` that reports which directories it created, leaf first: the
 * ancestors that did not exist beforehand. (It does not use the value
 * `mkdir` returns for `recursive`: Bun and Node disagree on it.) The install
 * manifest records them, so an uninstall removes only directories init made,
 * and only while empty.
 */
export async function mkdirTracked(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.push(d);
    if (dirname(d) === d) break;
  }
  await mkdir(dir, { recursive: true });
  return missing;
}
