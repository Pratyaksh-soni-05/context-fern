import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("readLast() is null for a missing file, an empty file and a last line that is not JSON", async () => {
  testDir = join(tmpdir(), `fern-journal-test-last-${Date.now()}`);
  const path = join(testDir, "journal.jsonl");
  const sink = new JsonlJournalSink(path);
  expect(await sink.readLast()).toBeNull();

  await mkdir(testDir, { recursive: true });
  await writeFile(path, "", "utf-8");
  expect(await sink.readLast()).toBeNull();

  await writeFile(path, `${JSON.stringify(entry())}\nnot json\n`, "utf-8");
  expect(await sink.readLast()).toBeNull();
});

test("readLast() returns the newest entry, however many came before it", async () => {
  testDir = join(tmpdir(), `fern-journal-test-last2-${Date.now()}`);
  const sink = new JsonlJournalSink(join(testDir, "journal.jsonl"));
  for (let i = 0; i < 50; i++) await sink.record(entry({ inputTokens: i }));
  const last = (await sink.readLast()) as { inputTokens: number };
  expect(last.inputTokens).toBe(49);
});

test("readLast() reads a last line longer than the first chunk, and a single-line file", async () => {
  testDir = join(tmpdir(), `fern-journal-test-last3-${Date.now()}`);
  const sink = new JsonlJournalSink(join(testDir, "journal.jsonl"));
  await sink.record(entry({ inputTokens: 1 }));
  expect(((await sink.readLast()) as { inputTokens: number }).inputTokens).toBe(
    1,
  );

  const long = "x".repeat(40 * 1024);
  await sink.record(entry({ inputTokens: 2, model: long }));
  const last = (await sink.readLast()) as {
    inputTokens: number;
    model: string;
  };
  expect(last.inputTokens).toBe(2);
  expect(last.model.length).toBe(long.length);
});
