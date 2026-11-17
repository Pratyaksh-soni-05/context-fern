import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkModelFiles,
  DEFAULT_MODEL_ID,
  MODEL_FILE_SHA256,
  NoModelEmbedder,
} from "../src/index";

test("an empty cache reports the first pinned file as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fern-model-"));
  const problem = await checkModelFiles(dir);
  expect(problem?.kind).toBe("missing");
  expect(problem?.path).toBe(join(dir, DEFAULT_MODEL_ID, "config.json"));
  await rm(dir, { recursive: true, force: true });
});

test("a file whose bytes differ from the pin is a checksum failure, not a pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fern-model-"));
  for (const file of Object.keys(MODEL_FILE_SHA256)) {
    const path = join(dir, DEFAULT_MODEL_ID, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "tampered");
  }
  const problem = await checkModelFiles(dir);
  expect(problem?.kind).toBe("checksum");
  await rm(dir, { recursive: true, force: true });
});

test("NoModelEmbedder returns one zero-length vector per text", async () => {
  const vectors = await new NoModelEmbedder().embed(["a", "b"]);
  expect(vectors.map((v) => v.length)).toEqual([0, 0]);
});
