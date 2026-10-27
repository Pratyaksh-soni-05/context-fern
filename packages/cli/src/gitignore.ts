// Appends a line to a project's .gitignore — append-only, never rewrites
// or reorders existing lines. No precedent for this anywhere in the
// repo; genuinely new.

import { readFile, writeFile } from "node:fs/promises";

export async function gitignoreHasEntry(
  path: string,
  entry: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return false;
  }
  return content.split("\n").some((line) => line.trim() === entry);
}

export async function appendToGitignore(
  path: string,
  entry: string,
): Promise<void> {
  let content = "";
  try {
    content = await readFile(path, "utf-8");
  } catch {
    // no .gitignore yet — create one
  }
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  await writeFile(
    path,
    `${content}${needsNewline ? "\n" : ""}${entry}\n`,
    "utf-8",
  );
}
