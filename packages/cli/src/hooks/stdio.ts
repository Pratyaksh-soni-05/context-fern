// Tiny stdin/stdout plumbing shared by every thin scripts/*.ts wrapper —
// deliberately has no dependency beyond Bun's own globals, so it adds
// nothing to the lightweight hook scripts' import graph.

export async function readStdinJson<T>(): Promise<T> {
  const text = await Bun.stdin.text();
  return JSON.parse(text) as T;
}

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}
