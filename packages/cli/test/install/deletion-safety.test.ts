// The rule: install code deletes a file only if the manifest lists it (or
// it is a moved-aside file the manifest's pending list names) AND its hash
// still matches what was recorded. Everything else is left alone and
// reported. Two kinds of proof: a scan of the sources, and behaviour with
// real files, including ones the user owns and ones the user edited.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installBinary,
  locateBinarySource,
  sweepPending,
} from "../../src/install/binary";
import { installLayout } from "../../src/install/layout";
import { sha256File } from "../../src/install/manifest";
import { removeEmptyDir, removeIfHash } from "../../src/install/safe-remove";

const EXE = process.platform === "win32" ? ".exe" : "";
const INSTALL_SRC = join(import.meta.dir, "../../src/install");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-delete-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function shipped(
  version: string,
  sidecarFiles: Record<string, string> = {
    "linux-x64/onnxruntime_binding.node": `binding-${version}`,
  },
): Promise<string> {
  const dir = join(root, `src-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `context-fern${EXE}`), `exe-${version}`);
  for (const [rel, content] of Object.entries(sidecarFiles)) {
    await mkdir(join(dir, "onnxruntime-native", join(rel, "..")), {
      recursive: true,
    });
    await writeFile(join(dir, "onnxruntime-native", rel), content);
  }
  return join(dir, `context-fern${EXE}`);
}

const layout = () =>
  installLayout({
    platform: process.platform,
    env: { FERN_INSTALL_PREFIX: join(root, "prefix") },
    home: root,
  });
const src = (exe: string) =>
  locateBinarySource(exe) as NonNullable<ReturnType<typeof locateBinarySource>>;

test("source scan: nothing in install code deletes except safe-remove.ts, and nothing deletes recursively", () => {
  const DELETE_CALL =
    /\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|rimraf)\s*\(/;
  const files = readdirSync(INSTALL_SRC).filter((f) => f.endsWith(".ts"));
  expect(files).toContain("safe-remove.ts");
  for (const f of files) {
    const text = readFileSync(join(INSTALL_SRC, f), "utf-8")
      // ignore comments, which describe deletion rather than perform it
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (f === "safe-remove.ts") {
      expect(text).not.toMatch(/recursive\s*:\s*true/);
      continue;
    }
    expect({ file: f, deletes: DELETE_CALL.test(text) }).toEqual({
      file: f,
      deletes: false,
    });
    // `recursive: true` is only ever for creating directories.
    for (const line of text.split("\n")) {
      if (/recursive\s*:\s*true/.test(line)) {
        expect({
          file: f,
          line: line.trim(),
          mkdir: /mkdir/.test(line),
        }).toEqual({ file: f, line: line.trim(), mkdir: true });
      }
    }
  }
});

test("removeIfHash deletes a file only while it still has the recorded hash", async () => {
  const f = join(root, "a.bin");
  await writeFile(f, "original");
  const sha = await sha256File(f);

  await writeFile(f, "edited by the user");
  const left = await removeIfHash(f, sha);
  expect(left).toEqual({
    state: "left-alone",
    path: f,
    reason: "changed-since-install",
  });
  expect(await readFile(f, "utf-8")).toBe("edited by the user");

  await writeFile(f, "original");
  expect((await removeIfHash(f, sha)).state).toBe("removed");
  expect((await removeIfHash(f, sha)).state).toBe("missing");
});

test("removeIfHash leaves a directory alone, and removeEmptyDir leaves a non-empty one alone", async () => {
  const dir = join(root, "d");
  await mkdir(dir);
  await writeFile(join(dir, "keep.txt"), "x");
  expect((await removeIfHash(dir, "0".repeat(64))).state).toBe("left-alone");
  expect((await removeEmptyDir(dir)).state).toBe("left-alone");
  expect(await readFile(join(dir, "keep.txt"), "utf-8")).toBe("x");
  await rm(join(dir, "keep.txt"));
  expect((await removeEmptyDir(dir)).state).toBe("removed");
});

test("removeIfHash leaves a symlink alone even if the target would match", async () => {
  const target = join(root, "t.bin");
  await writeFile(target, "same");
  const link = join(root, "link.bin");
  try {
    await symlink(target, link);
  } catch {
    return; // no privilege to create symlinks here
  }
  expect((await removeIfHash(link, await sha256File(target))).state).toBe(
    "left-alone",
  );
  expect(await readFile(target, "utf-8")).toBe("same");
});

test("the pending list: a moved-aside file is deleted only if it still matches, a changed one is reported, a locked one stays listed", async () => {
  const same = join(root, "context-fern.old-1");
  const changed = join(root, "context-fern.old-2");
  const gone = join(root, "context-fern.old-3");
  await writeFile(same, "aside");
  await writeFile(changed, "aside");
  const sha = await sha256File(same);
  await writeFile(changed, "the user put something else here");

  const { remaining, leftAlone } = await sweepPending([
    { path: same, sha256: sha },
    { path: changed, sha256: sha },
    { path: gone, sha256: sha },
  ]);
  expect(await readdir(root)).toEqual([`context-fern.old-2`]);
  expect(await readFile(changed, "utf-8")).toBe(
    "the user put something else here",
  );
  expect(leftAlone).toEqual([
    { path: changed, reason: "changed-since-install" },
  ]);
  expect(remaining).toEqual([]);
});

test("files in the bin and sidecar directories that the manifest does not list are never touched, whatever their names", async () => {
  const l = layout();
  await mkdir(l.binDir, { recursive: true });
  const theirs: Record<string, string> = {
    "foo.old-2024": "user",
    [`context-fern${EXE}.old-1`]: "looks like ours, is not listed",
    [`fern${EXE}.new-1`]: "also not listed",
    mytool: "user tool",
  };
  for (const [n, c] of Object.entries(theirs)) {
    await writeFile(join(l.binDir, n), c);
  }
  const first = await installBinary(src(await shipped("one")), l);
  // The user also drops a file inside our sidecar directory.
  const userInSidecar = join(
    l.shareDir,
    "onnxruntime-native",
    "linux-x64",
    "notes.txt",
  );
  await writeFile(userInSidecar, "my notes");

  await installBinary(src(await shipped("two")), l, first.entries);

  for (const [n, c] of Object.entries(theirs)) {
    expect(await readFile(join(l.binDir, n), "utf-8")).toBe(c);
  }
  expect(await readFile(userInSidecar, "utf-8")).toBe("my notes");
});

test("a binary the manifest lists but the user has edited is left alone and init stops, naming it", async () => {
  const l = layout();
  const first = await installBinary(src(await shipped("one")), l);
  const installed = join(l.binDir, `context-fern${EXE}`);
  await writeFile(installed, "patched by the user");

  await expect(
    installBinary(src(await shipped("two")), l, first.entries),
  ).rejects.toThrow(/has changed since/);
  expect(await readFile(installed, "utf-8")).toBe("patched by the user");
  // Nothing else was changed either: the check happens before any change.
  // (`fern` is a hard link to `context-fern`, so it shows the same edit.)
  expect(
    await readFile(
      join(
        l.shareDir,
        "onnxruntime-native",
        "linux-x64",
        "onnxruntime_binding.node",
      ),
      "utf-8",
    ),
  ).toBe("binding-one");
});

test("a sidecar file an earlier install listed and the new one drops is removed only if unchanged; an edited one is reported; the directory goes only if empty", async () => {
  const l = layout();
  const first = await installBinary(
    src(
      await shipped("one", {
        "linux-x64/onnxruntime_binding.node": "binding",
        "linux-x64/old-a.so": "a",
        "linux-x64/old-b.so": "b",
        "gone/old-c.so": "c",
      }),
    ),
    l,
  );
  const root0 = join(l.shareDir, "onnxruntime-native");
  await writeFile(join(root0, "linux-x64", "old-b.so"), "edited by the user");

  const second = await installBinary(
    src(
      await shipped("two", { "linux-x64/onnxruntime_binding.node": "binding" }),
    ),
    l,
    first.entries,
  );

  expect(existsSyncSafe(join(root0, "linux-x64", "old-a.so"))).toBe(false); // unchanged: removed
  expect(await readFile(join(root0, "linux-x64", "old-b.so"), "utf-8")).toBe(
    "edited by the user",
  ); // edited: kept
  expect(second.leftAlone).toEqual([
    {
      path: join(root0, "linux-x64", "old-b.so"),
      reason: "changed-since-install",
    },
  ]);
  expect(existsSyncSafe(join(root0, "gone"))).toBe(false); // emptied by our own removal, so tidied
});

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EISDIR";
  }
}
