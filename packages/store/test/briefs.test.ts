import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveOrDeleteBrief,
  createBrief,
  isBriefUnmodified,
  parseRecentEntries,
  pushRecentEntry,
  readBrief,
  writeBriefSections,
} from "../src/briefs";
import {
  type TempDir,
  withRealWorldSpacedDir,
  withTempFernDir,
} from "./test-helpers";

let dir: TempDir | undefined;

afterEach(async () => {
  if (dir) await dir.cleanup();
  dir = undefined;
});

test("createBrief writes all six empty sections, readBrief round-trips them", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth-refactor.md");
  await createBrief(path);

  const sections = await readBrief(path);
  expect(sections).toEqual({
    Goal: "",
    Decided: "",
    Open: "",
    Files: "",
    Notes: "",
    Recent: "",
  });
  expect(await isBriefUnmodified(path)).toBe(true);
});

test("createBrief is a no-op if a brief already exists at that path — never wipes real content back to blank", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "greetings.md");
  await createBrief(path);
  await writeBriefSections(path, { Goal: "real goal, already set" });
  await pushRecentEntry(path, 1, "a real prompt");

  // Simulates exactly what a second, duplicate /fern new <existing-name>
  // used to do before its own guard existed (see docs/decisions.md):
  // createFrond calling createBrief again, unconditionally, for a name
  // that already has a populated brief at the same path.
  await createBrief(path);

  const brief = await readBrief(path);
  expect(brief.Goal).toBe("real goal, already set");
  expect(brief.Recent).toBe("- t1 · a real prompt");
});

test("writeBriefSections overwrites a section the user never touched", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth-refactor.md");
  await createBrief(path);

  const result = await writeBriefSections(path, { Goal: "fix the auth bug" });
  expect(result.written).toEqual(["Goal"]);
  expect(result.keptUserText).toEqual([]);
  expect((await readBrief(path)).Goal).toBe("fix the auth bug");
});

test("a user edit to one section survives a system write to a different section", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth-refactor.md");
  await createBrief(path);
  await writeBriefSections(path, { Goal: "fix the auth bug" });

  // the user hand-edits Notes directly on disk (bypassing writeBriefSections)
  const withUserEdit = await readBrief(path);
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path,
    [
      "## Goal",
      "",
      withUserEdit.Goal,
      "",
      "## Decided",
      "",
      "",
      "## Open",
      "",
      "",
      "## Files",
      "",
      "",
      "## Notes",
      "",
      "the user's own note",
      "",
    ].join("\n"),
    "utf-8",
  );

  const result = await writeBriefSections(path, { Decided: "shipped the fix" });
  expect(result.written).toEqual(["Decided"]);

  const after = await readBrief(path);
  expect(after.Notes).toBe("the user's own note");
  expect(after.Decided).toBe("shipped the fix");
});

test("when both the user and the system changed the same section, the user's text wins", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth-refactor.md");
  await createBrief(path);
  await writeBriefSections(path, { Goal: "fix the auth bug" });

  // user hand-edits Goal directly on disk
  const fs = await import("node:fs/promises");
  const current = await readBrief(path);
  await fs.writeFile(
    path,
    [
      "## Goal",
      "",
      "actually, fix the auth bug AND add 2FA",
      "",
      "## Decided",
      "",
      current.Decided,
      "",
      "## Open",
      "",
      current.Open,
      "",
      "## Files",
      "",
      current.Files,
      "",
      "## Notes",
      "",
      current.Notes,
      "",
    ].join("\n"),
    "utf-8",
  );

  const result = await writeBriefSections(path, {
    Goal: "fix the auth bug (system retry)",
  });
  expect(result.keptUserText).toEqual(["Goal"]);
  expect((await readBrief(path)).Goal).toBe(
    "actually, fix the auth bug AND add 2FA",
  );
});

test("works under a directory path containing a space (the real project path has one)", async () => {
  dir = await withRealWorldSpacedDir();
  const path = join(dir.path, "auth-refactor.md");
  await createBrief(path);
  await writeBriefSections(path, {
    Goal: "works even with a space in the path",
  });

  expect((await readBrief(path)).Goal).toBe(
    "works even with a space in the path",
  );
});

test("pushRecentEntry prepends newest-first and caps at 5, tagging each entry with its turn", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  let turn = 1;
  for (const entry of ["one", "two", "three", "four", "five", "six"]) {
    await pushRecentEntry(path, turn++, entry);
  }

  const brief = await readBrief(path);
  expect(brief.Recent).toBe(
    [
      "- t6 · six",
      "- t5 · five",
      "- t4 · four",
      "- t3 · three",
      "- t2 · two",
    ].join("\n"),
  );
});

test("pushRecentEntry collapses a consecutive duplicate (by text, regardless of turn) instead of filling the window with repeats, keeping the first turn's tag", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await pushRecentEntry(path, 1, "fix the login bug");
  await pushRecentEntry(path, 2, "fix the login bug");
  await pushRecentEntry(path, 3, "fix the login bug");
  await pushRecentEntry(path, 4, "add a retry");

  const brief = await readBrief(path);
  expect(brief.Recent).toBe(
    ["- t4 · add a retry", "- t1 · fix the login bug"].join("\n"),
  );
});

test("pushRecentEntry is a no-op for an empty entry", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await pushRecentEntry(path, 1, "");
  expect((await readBrief(path)).Recent).toBe("");
});

test("pushRecentEntry is never merge-protected — unlike every other section, a user's hand-edit to Recent gets no special preservation and is just carried forward as part of the rolling window, untagged", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await writeBriefSections(path, { Goal: "something" }); // establishes a real meta file
  const fs = await import("node:fs/promises");
  const current = await fs.readFile(path, "utf-8");
  await fs.writeFile(
    path,
    current.replace("## Recent\n\n", "## Recent\n\n- the user's own line\n"),
    "utf-8",
  );

  await pushRecentEntry(path, 1, "a real prompt");
  expect((await readBrief(path)).Recent).toBe(
    "- t1 · a real prompt\n- the user's own line",
  );
});

test("pushRecentEntry never affects isBriefUnmodified/archiveOrDeleteBrief — it's not tracked in meta", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await pushRecentEntry(path, 1, "a real prompt");
  expect(await isBriefUnmodified(path)).toBe(true);

  await archiveOrDeleteBrief(path, "docker-build", "decision-1");
  await expect(readFile(path, "utf-8")).rejects.toThrow();
});

test("archiveOrDeleteBrief: an untouched brief is deleted along with its meta file", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await archiveOrDeleteBrief(path, "docker-build", "decision-1");

  await expect(readFile(path, "utf-8")).rejects.toThrow();
});

test("parseRecentEntries parses the tN tag back into a turn number, and falls back to turn:null for an untagged (hand-typed) line", () => {
  expect(parseRecentEntries("- t12 · Fix the login bug")).toEqual([
    { turn: 12, text: "Fix the login bug" },
  ]);
  expect(parseRecentEntries("- the user's own line")).toEqual([
    { turn: null, text: "the user's own line" },
  ]);
  expect(parseRecentEntries("")).toEqual([]);
});

test("archiveOrDeleteBrief: a user-edited brief is moved intact, never deleted", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  // simulate the user hand-editing the file directly (bypassing
  // writeBriefSections) — the real trigger for "don't delete this"
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path,
    "## Goal\n\n\n## Decided\n\n\n## Open\n\n\n## Files\n\n\n## Notes\n\nthe user's own investigation notes\n",
    "utf-8",
  );

  await archiveOrDeleteBrief(path, "docker-build", "decision-1");

  await expect(readFile(path, "utf-8")).rejects.toThrow();
  const archived = await readBrief(
    join(dir.path, ".undone", "docker-build-decision-1.md"),
  );
  expect(archived.Notes).toBe("the user's own investigation notes");
});

test("a reply gist is kept on the line under its prompt, tagged with the same turn, and parses back", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth.md");
  await createBrief(path);

  await pushRecentEntry(
    path,
    3,
    "fix the login bug",
    "Changed src/auth.ts to refresh the token.",
  );
  await pushRecentEntry(path, 4, "now add a test"); // no gist recorded

  const brief = await readBrief(path);
  expect(brief.Recent).toBe(
    [
      "- t4 · now add a test",
      "- t3 · fix the login bug",
      "  ↳ reply: Changed src/auth.ts to refresh the token.",
    ].join("\n"),
  );

  expect(parseRecentEntries(brief.Recent)).toEqual([
    { turn: 4, text: "now add a test" },
    {
      turn: 3,
      text: "fix the login bug",
      reply: "Changed src/auth.ts to refresh the token.",
    },
  ]);
});

test("the reply line never becomes part of a prompt's text, so the UI's promptPreview stays the prompt", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth.md");
  await createBrief(path);
  await pushRecentEntry(path, 1, "the prompt", "the gist");

  const [entry] = parseRecentEntries((await readBrief(path)).Recent);
  expect(entry?.text).toBe("the prompt");
  expect(entry?.reply).toBe("the gist");
});

test("an entry's gist rolls off with it when the window of 5 turns over", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth.md");
  await createBrief(path);
  for (let turn = 1; turn <= 6; turn++) {
    await pushRecentEntry(path, turn, `prompt ${turn}`, `gist ${turn}`);
  }
  const text = (await readBrief(path)).Recent;
  expect(text).toContain("gist 6");
  expect(text).toContain("gist 2");
  expect(text).not.toContain("gist 1");
});

test("a retried prompt keeps its entry and turn, and gains the gist its first attempt lacked", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "auth.md");
  await createBrief(path);
  await pushRecentEntry(path, 1, "same prompt");
  await pushRecentEntry(path, 2, "same prompt", "it worked");

  expect((await readBrief(path)).Recent).toBe(
    "- t1 · same prompt\n  ↳ reply: it worked",
  );
});
