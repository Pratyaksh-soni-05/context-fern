import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  isAlreadyInstalled,
  locateBinarySource,
} from "../../src/install/binary";
import { installLayout } from "../../src/install/layout";
import { sha256File } from "../../src/install/manifest";
import { findModelPayload, installModel } from "../../src/install/model";

const EXE = process.platform === "win32" ? ".exe" : "";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-install-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stand-in for a shipped binary: an `<exe>` with a sidecar tree beside it (the tarball/npm layout). */
async function fakeShipped(version = "one"): Promise<string> {
  const dir = join(root, `src-${version}`);
  await mkdir(join(dir, "onnxruntime-native", "linux-x64"), {
    recursive: true,
  });
  await writeFile(join(dir, `context-fern${EXE}`), `exe-${version}`);
  await writeFile(
    join(dir, "onnxruntime-native", "linux-x64", "onnxruntime_binding.node"),
    `binding-${version}`,
  );
  return join(dir, `context-fern${EXE}`);
}

function layoutFor(name: string) {
  return installLayout({
    platform: process.platform,
    env: { FERN_INSTALL_PREFIX: join(root, name) },
    home: root,
  });
}

const source = (exe: string) =>
  locateBinarySource(exe) as NonNullable<ReturnType<typeof locateBinarySource>>;

test("a source checkout (bun, not a shipped binary) has nothing to install", () => {
  expect(locateBinarySource(join(root, `bun${EXE}`))).toBeNull();
});

test("a shipped binary with no sidecar fails with a plain-English message naming where it looked", async () => {
  const dir = join(root, "nosidecar");
  await mkdir(dir, { recursive: true });
  const exe = join(dir, `context-fern${EXE}`);
  await writeFile(exe, "x");
  expect(() => locateBinarySource(exe)).toThrow(
    /native runtime files are missing/,
  );
});

test("a pip/uv layout is found: sidecar under ../share/context-fern, exe in bin/", async () => {
  const bin = join(root, "venv", "bin");
  const sidecar = join(
    root,
    "venv",
    "share",
    "context-fern",
    "onnxruntime-native",
  );
  await mkdir(bin, { recursive: true });
  await mkdir(sidecar, { recursive: true });
  const exe = join(bin, `fern${EXE}`);
  await writeFile(exe, "x");
  expect(locateBinarySource(exe)?.sidecarDir.toLowerCase()).toBe(
    sidecar.toLowerCase(),
  );
});

test("installBinary puts both names in bin/ and the sidecar in share/, with matching hashes", async () => {
  const layout = layoutFor("a");
  const { entries, pending, leftAlone } = await installBinary(
    source(await fakeShipped()),
    layout,
  );

  expect(existsSync(join(layout.binDir, `context-fern${EXE}`))).toBe(true);
  expect(existsSync(join(layout.binDir, `fern${EXE}`))).toBe(true);
  expect(
    await readFile(
      join(
        layout.shareDir,
        "onnxruntime-native",
        "linux-x64",
        "onnxruntime_binding.node",
      ),
      "utf-8",
    ),
  ).toBe("binding-one");
  expect(entries.filter((e) => e.role === "binary").length).toBe(2);
  expect(entries.filter((e) => e.role === "sidecar").length).toBe(1);
  for (const e of entries) expect(e.sha256).toBe(await sha256File(e.path));
  expect(pending).toEqual([]);
  expect(leftAlone).toEqual([]);
  // No temporary files left behind.
  expect((await readdir(layout.binDir)).sort()).toEqual(
    [`context-fern${EXE}`, `fern${EXE}`].sort(),
  );
});

test("installing again over an install the manifest lists replaces it (upgrade) and leaves no leftovers", async () => {
  const layout = layoutFor("b");
  let previous: Awaited<ReturnType<typeof installBinary>>["entries"] = [];
  for (const v of ["one", "two"]) {
    const r = await installBinary(
      source(await fakeShipped(v)),
      layout,
      previous,
    );
    previous = r.entries;
    expect(r.pending).toEqual([]);
  }
  expect(
    await readFile(join(layout.binDir, `context-fern${EXE}`), "utf-8"),
  ).toBe("exe-two");
  expect(await readFile(join(layout.binDir, `fern${EXE}`), "utf-8")).toBe(
    "exe-two",
  );
  expect((await readdir(layout.binDir)).sort()).toEqual(
    [`context-fern${EXE}`, `fern${EXE}`].sort(),
  );
});

test("a binary already running from the install directory is recognised, so init does not copy onto itself", async () => {
  const layout = layoutFor("c");
  await mkdir(layout.binDir, { recursive: true });
  expect(
    isAlreadyInstalled(join(layout.binDir, `context-fern${EXE}`), layout),
  ).toBe(true);
  expect(
    isAlreadyInstalled(join(root, "elsewhere", `context-fern${EXE}`), layout),
  ).toBe(false);
});

test("the installed copy is recognised even when the OS reports its directory under a different spelling (symlink or Windows short name)", async () => {
  const layout = layoutFor("d");
  await mkdir(layout.binDir, { recursive: true });
  const alias = join(root, "alias-of-d");
  try {
    await symlink(layout.prefix, alias, "junction");
  } catch {
    return; // cannot create a link here (no privilege): nothing to assert
  }
  expect(
    isAlreadyInstalled(join(alias, "bin", `context-fern${EXE}`), layout),
  ).toBe(true);
});

test("findModelPayload prefers the npm launcher's variable, then the pip share layout", async () => {
  const fromEnv = join(root, "env-payload");
  await mkdir(join(fromEnv, "Xenova", "all-MiniLM-L6-v2"), { recursive: true });
  expect(
    findModelPayload(
      { FERN_MODEL_PAYLOAD: fromEnv },
      join(root, "x", "bin", "c"),
    ),
  ).toBe(fromEnv);

  const shareModel = join(root, "venv", "share", "context-fern-model");
  await mkdir(join(shareModel, "Xenova", "all-MiniLM-L6-v2"), {
    recursive: true,
  });
  const found = findModelPayload({}, join(root, "venv", "bin", "context-fern"));
  expect(found?.toLowerCase()).toBe(
    join(
      root,
      "venv",
      "bin",
      "..",
      "share",
      "context-fern-model",
    ).toLowerCase(),
  );
  expect(
    findModelPayload({}, join(root, "nowhere", "bin", "context-fern")),
  ).toBeNull();
});

const PINNED_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
];

async function fakePayload(content: string): Promise<string> {
  const payload = join(root, "payload");
  const modelDir = join(payload, "Xenova", "all-MiniLM-L6-v2");
  await mkdir(join(modelDir, "onnx"), { recursive: true });
  for (const f of PINNED_FILES) await writeFile(join(modelDir, f), content);
  return payload;
}

test("a model payload whose files do not match the pinned checksums is rejected, and the files this run copied are removed again", async () => {
  const payload = await fakePayload("not the real model");
  const cache = join(root, "cache");
  const result = await installModel(payload, cache);
  expect(result.state).toBe("failed");
  for (const f of PINNED_FILES) {
    expect(existsSync(join(cache, "Xenova", "all-MiniLM-L6-v2", f))).toBe(
      false,
    );
  }
});

test("a model file already in the cache with the wrong checksum is left alone and reported, never replaced or deleted", async () => {
  const payload = await fakePayload("payload");
  const cache = join(root, "cache2");
  const existing = join(cache, "Xenova", "all-MiniLM-L6-v2", "config.json");
  await mkdir(join(cache, "Xenova", "all-MiniLM-L6-v2"), { recursive: true });
  await writeFile(existing, "the user's own file");
  const result = await installModel(payload, cache);
  expect(result.state).toBe("failed");
  expect(result.state === "failed" && result.reason).toContain("left alone");
  expect(await readFile(existing, "utf-8")).toBe("the user's own file");
});

test("with no payload and no model in the cache, installModel says so instead of failing", async () => {
  expect((await installModel(null, join(root, "empty-cache"))).state).toBe(
    "no-payload",
  );
});
