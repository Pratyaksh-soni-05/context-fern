import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalSink, Stage2CallLog } from "@context-fern/core";

/**
 * Appends one JSON line per journal entry to a file — the
 * `.fern/journal.jsonl` mirror from spec §12, scoped here to exactly
 * what Stage 2 needs right now (no SQLite `decisions` table, no undo
 * registry — those stay separately scoped future work). Uses a real OS
 * append (not read-modify-write), so concurrent calls on the same path
 * don't clobber each other.
 */
export class JsonlJournalSink implements JournalSink {
  constructor(private readonly path: string) {}

  async record(entry: Stage2CallLog): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
