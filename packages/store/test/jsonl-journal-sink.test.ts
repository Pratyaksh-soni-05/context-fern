import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlJournalSink } from "../src/jsonl-journal-sink";

let testDir: string;

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

function entry(
  overrides: Partial<Parameters<JsonlJournalSink["record"]>[0]> = {},
) {
  return {
    model: "qwen3:8b",
    inputTokens: 10,
    outputTokens: 20,
    latencyMs: 123,
    escalatedAction: "continue" as const,
    escalatedConfidence: 0.5,
    succeeded: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

test("record() creates the parent directory and appends one JSON line", async () => {
  testDir = join(tmpdir(), `fern-journal-test-${Date.now()}`);
  const path = join(testDir, "nested", "journal.jsonl");
  const sink = new JsonlJournalSink(path);

  await sink.record(entry());
  await sink.record(entry({ succeeded: false, escalatedAction: "new" }));

  const content = await readFile(path, "utf-8");
  const lines = content.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0] as string)).toEqual(entry());
  expect(JSON.parse(lines[1] as string)).toEqual(
    entry({ succeeded: false, escalatedAction: "new" }),
  );
});

test("record() appends across multiple sink instances pointed at the same path", async () => {
  testDir = join(tmpdir(), `fern-journal-test-${Date.now()}-b`);
  const path = join(testDir, "journal.jsonl");

  await new JsonlJournalSink(path).record(entry());
  await new JsonlJournalSink(path).record(entry());

  const content = await readFile(path, "utf-8");
  expect(content.trim().split("\n")).toHaveLength(2);
});
