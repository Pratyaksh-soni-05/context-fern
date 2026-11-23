import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEntry, JournalSink } from "@context-fern/core";

const FIRST_TAIL_BYTES = 8 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Appends one JSON line per journal entry to a file — the
 * `.fern/journal.jsonl` mirror from spec §12. Carries Stage 2 LLM calls,
 * full routing `Decision`s (see docs/decisions.md, 2026-10-26) and mode
 * changes (2026-11-20) — any `JournalEntry`. Uses a real OS append (not
 * read-modify-write), so concurrent calls on the same path don't clobber
 * each other.
 */
export class JsonlJournalSink implements JournalSink {
  constructor(private readonly path: string) {}

  async record(entry: JournalEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  /**
   * The newest entry, or null when the file is missing, empty or its last
   * line is not valid JSON. Reads only the end of the file (a few KB, more if
   * the last line is longer), never the whole journal.
   */
  async readLast(): Promise<JournalEntry | null> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return null;
    }
    if (size === 0) return null;
    const handle = await open(this.path, "r");
    try {
      for (
        let want = FIRST_TAIL_BYTES;
        ;
        want = Math.min(want * 4, MAX_TAIL_BYTES)
      ) {
        const length = Math.min(want, size);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const text = buffer.toString("utf-8").replace(/\n+$/, "");
        const newline = text.lastIndexOf("\n");
        // A complete last line is one with a line break before it, or the whole file.
        if (newline >= 0 || length === size) {
          try {
            return JSON.parse(text.slice(newline + 1)) as JournalEntry;
          } catch {
            return null;
          }
        }
        if (length >= MAX_TAIL_BYTES) return null;
      }
    } finally {
      await handle.close();
    }
  }
}
