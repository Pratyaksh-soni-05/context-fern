// The optional manifest fields an uninstall relies on (schema stays 1):
// created directories, the statusline entry, whether init added the
// marketplace, and the rc backup.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirTracked } from "../../src/install/dirs";
import {
  type GlobalInitDeps,
  runGlobalInit,
} from "../../src/install/global-init";
import { readManifest, writeManifest } from "../../src/install/manifest";
import {
  type CommandRunner,
  setUpPlugin,
} from "../../src/install/plugin-setup";
import { recordStatusline } from "../../src/install/record-statusline";

const EXE = process.platform === "win32" ? ".exe" : "";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-mfadd-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function shipped(): Promise<string> {
  const dir = join(root, "pkg");
  await mkdir(join(dir, "onnxruntime-native", "linux-x64"), {
    recursive: true,
  });
  await writeFile(join(dir, `context-fern${EXE}`), "exe");
  await writeFile(
    join(dir, "onnxruntime-native", "linux-x64", "onnxruntime_binding.node"),
    "b",
  );
  return join(dir, `context-fern${EXE}`);
}

const manifestPath = () =>
  join(root, "prefix", "share", "context-fern", "install-manifest.json");

function deps(execPath: string): GlobalInitDeps {
  return {
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: join(root, "prefix"), PATH: "" },
    home: join(root, "home"),
    execPath,
    interactive: false,
    ask: async () => false,
    log: () => {},
    which: () => null,
    now: () => new Date("2026-01-01T00:00:00Z"),
    modelCacheDir: join(root, "cache"),
    addToWindowsPath: async () => {
      throw new Error("not here");
    },
  };
}

test("mkdirTracked reports only the directories it really created, leaf first", async () => {
  await mkdir(join(root, "exists"));
  expect(await mkdirTracked(join(root, "exists"))).toEqual([]);
  const made = await mkdirTracked(join(root, "exists", "a", "b"));
  expect(made).toEqual([
    join(root, "exists", "a", "b"),
    join(root, "exists", "a"),
  ]);
});

test("init records the directories it created, not ones that were already there, and keeps them across runs", async () => {
  const exe = await shipped();
  // The prefix exists already (like ~/.local on a real machine); bin and share do not.
  await mkdir(join(root, "prefix"), { recursive: true });
  await runGlobalInit({ "no-plugin": "true" }, deps(exe));
  const first = (await readManifest(manifestPath()))?.createdDirs ?? [];
  expect(first).toContain(join(root, "prefix", "bin"));
  expect(first).toContain(join(root, "prefix", "share", "context-fern"));
  expect(first).toContain(
    join(
      root,
      "prefix",
      "share",
      "context-fern",
      "onnxruntime-native",
      "linux-x64",
    ),
  );
  expect(first).not.toContain(join(root, "prefix"));

  await runGlobalInit(
    { "no-plugin": "true" },
    deps(join(root, "prefix", "bin", `context-fern${EXE}`)),
  );
  expect((await readManifest(manifestPath()))?.createdDirs).toEqual(first);
});

test("the plugin record says whether init added the marketplace: not if it was already configured, yes if not, unknown if the list could not be read", async () => {
  const runnerWith =
    (listOutput: string | null): CommandRunner =>
    async (_c, args) => {
      if (args.includes("list")) {
        return listOutput === null
          ? { ok: false, output: "boom" }
          : { ok: true, output: listOutput };
      }
      return { ok: true, output: "" };
    };
  const had = await setUpPlugin(
    "claude",
    runnerWith('[{"name":"context-fern"},{"name":"other"}]'),
  );
  const none = await setUpPlugin("claude", runnerWith('[{"name":"other"}]'));
  const unknown = await setUpPlugin("claude", runnerWith(null));
  expect(had.record.marketplaceAddedByInit).toBe(false);
  expect(none.record.marketplaceAddedByInit).toBe(true);
  expect("marketplaceAddedByInit" in unknown.record).toBe(false);
});

test("the statusline entry init adds is recorded in an existing manifest, and nothing is recorded without one", async () => {
  const exe = await shipped();
  const outcome = {
    state: "added" as const,
    file: join(root, "home", ".claude", "settings.json"),
    command: "context-fern statusline",
    backupPath: null,
  };
  const where = {
    platform: "linux" as const,
    env: { FERN_INSTALL_PREFIX: join(root, "prefix") },
    home: join(root, "home"),
  };
  expect(await recordStatusline(outcome, where)).toBe(false); // no manifest yet

  await runGlobalInit({ "no-plugin": "true" }, deps(exe));
  expect(await recordStatusline(outcome, where)).toBe(true);
  expect((await readManifest(manifestPath()))?.statusline).toEqual({
    file: outcome.file,
    command: "context-fern statusline",
    backupPath: null,
  });
  // A later init keeps what was recorded.
  await runGlobalInit(
    { "no-plugin": "true" },
    deps(join(root, "prefix", "bin", `context-fern${EXE}`)),
  );
  expect((await readManifest(manifestPath()))?.statusline?.command).toBe(
    "context-fern statusline",
  );
  expect(await recordStatusline({ state: "already-present" }, where)).toBe(
    false,
  );
});

test("a manifest written before these fields existed still reads, and a later init adds them without losing anything", async () => {
  const exe = await shipped();
  await mkdir(join(root, "prefix", "share", "context-fern"), {
    recursive: true,
  });
  const old = {
    schema: 1 as const,
    version: "0.1.0",
    installedAt: "2026-11-17T00:00:00.000Z",
    platform: "linux-x64",
    prefix: join(root, "prefix"),
    binDir: join(root, "prefix", "bin"),
    shareDir: join(root, "prefix", "share", "context-fern"),
    files: [],
    pathEdit: null,
    plugin: null,
  };
  await writeManifest(manifestPath(), old);
  expect((await readManifest(manifestPath()))?.createdDirs).toBeUndefined();
  await runGlobalInit({ "no-plugin": "true" }, deps(exe));
  const after = await readManifest(manifestPath());
  expect(after?.installedAt).toBe("2026-11-17T00:00:00.000Z");
  expect(after?.files.length).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(manifestPath(), "utf-8")).schema).toBe(1);
});
