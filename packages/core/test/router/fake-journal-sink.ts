// A tiny local fake JournalSink for core's OWN tests — in-memory only,
// so tests can assert exactly what got journaled without touching disk.

import type { JournalEntry, JournalSink } from "../../src/types";

export function makeFakeJournalSink(): JournalSink & {
  entries: JournalEntry[];
} {
  const entries: JournalEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
}
