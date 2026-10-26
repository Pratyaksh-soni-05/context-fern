import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveOrDeleteBrief,
  createBrief,
  isBriefUnmodified,
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

test("createBrief writes all five empty sections, readBrief round-trips them", async () => {
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
  });
  expect(await isBriefUnmodified(path)).toBe(true);
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

test("archiveOrDeleteBrief: an untouched brief is deleted along with its meta file", async () => {
  dir = await withTempFernDir();
  const path = join(dir.path, "docker-build.md");
  await createBrief(path);

  await archiveOrDeleteBrief(path, "docker-build", "decision-1");

  await expect(readFile(path, "utf-8")).rejects.toThrow();
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
