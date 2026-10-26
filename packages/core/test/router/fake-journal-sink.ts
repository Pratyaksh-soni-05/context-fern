// A tiny local fake JournalSink for core's OWN tests — in-memory only,
// so tests can assert exactly what got journaled without touching disk.

import type { JournalSink, Stage2CallLog } from "../../src/types";

export function makeFakeJournalSink(): JournalSink & {
  entries: Stage2CallLog[];
} {
  const entries: Stage2CallLog[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
}
