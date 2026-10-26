import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEntry, JournalSink } from "@context-fern/core";

/**
 * Appends one JSON line per journal entry to a file — the
 * `.fern/journal.jsonl` mirror from spec §12. Carries both Stage 2 LLM
 * calls and full routing `Decision`s (see docs/decisions.md, 2026-10-26)
 * — any `JournalEntry`. Uses a real OS append (not read-modify-write),
 * so concurrent calls on the same path don't clobber each other.
 */
export class JsonlJournalSink implements JournalSink {
  constructor(private readonly path: string) {}

  async record(entry: JournalEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
