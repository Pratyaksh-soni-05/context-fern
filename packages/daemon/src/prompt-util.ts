import { createHash } from "node:crypto";

export function hashPrompt(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A rough, local approximation (chars/4) — no tokenizer dependency for this. */
export function approxTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** A user-facing error — the HTTP layer maps this to 400 with the message, not 500. */
export class DaemonError extends Error {}

/** A brief's Goal line: a prompt's first line, capped at maxChars. */
export function firstLine(text: string, maxChars: number): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}
