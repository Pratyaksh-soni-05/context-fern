// `context-fern uninstall` against real installs made by the real `init` code,
// in temporary directories. Plugin calls go to a real compiled stub `claude`
// executable (never the real one: fern@context-fern is installed on the
// maintainer's machine from the dev checkout). The file system is real; only
// the platform label is "linux" so the same tests run on every host.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { sha256File } from "../../src/install/hash";
import { readManifest, writeManifest } from "../../src/install/manifest";
import { runUninstall } from "../../src/install/uninstall";
import {
  buildStubClaude,
  EXE,
  type Fixture,
  fixture,
  installFake,
  stubCalls,
  uninstallDeps,
} from "./stub-helpers";

let root: string;
let f: Fixture;
let stubDir: string;
let stubPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "fern-stub-claude-"));
  stubPath = await buildStubClaude(stubDir);
}, 120_000);

afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-uninstall-test-"));
  f = fixture(root);
  for (const k of ["STUB_CLAUDE_LOG", "STUB_CLAUDE_LIST", "STUB_CLAUDE_FAIL"])
    savedEnv[k] = process.env[k];
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
}, 60_000);

const out = () => f.logs.join("\n");
const bin = (name: string) => join(f.prefix, "bin", name);
const sidecar = () =>
  join(
    f.prefix,
    "share",
    "context-fern",
    "onnxruntime-native",
    "linux-x64",
    "onnxruntime_binding.node",
  );

test("a full uninstall removes every file init installed, the directories init made, and the manifest, and nothing else", async () => {
  await installFake(f);
  expect(existsSync(bin("context-fern"))).toBe(true);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(r.state).toBe("done");
  expect(r.exitCode).toBe(0);
  expect(r.leftAlone).toEqual([]);
  expect(r.failed).toEqual([]);
  expect(existsSync(f.prefix)).toBe(false); // init created the prefix, so it goes too
  expect(out()).toContain("uninstalled");
});

test("a directory that existed before init is left, however empty it becomes", async () => {
  await mkdir(f.prefix, { recursive: true });
  await installFake(f);
  await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(existsSync(f.prefix)).toBe(true);
  expect(existsSync(join(f.prefix, "bin"))).toBe(false);
});

test("running uninstall twice is safe: the second run finds nothing to do and exits 0", async () => {
  await installFake(f);
  const first = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(first.exitCode).toBe(0);
  f.logs.length = 0;
  const second = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(second.state).toBe("nothing-to-do");
  expect(second.exitCode).toBe(0);
  expect(out()).toContain("no install manifest");
});

test("--dry-run shows the plan and changes nothing", async () => {
  await installFake(f);
  const before = await readFile(f.manifestPath, "utf-8");
  const r = await runUninstall({ "dry-run": "true" }, uninstallDeps(f));
  expect(r.state).toBe("dry-run");
  expect(out()).toContain("this will remove");
  expect(out()).toContain(bin("context-fern"));
  expect(existsSync(bin("context-fern"))).toBe(true);
  expect(await readFile(f.manifestPath, "utf-8")).toBe(before);
});

test("without --yes, a non-interactive run refuses (exit 2) and an interactive 'no' removes nothing", async () => {
  await installFake(f);
  const refused = await runUninstall({}, uninstallDeps(f));
  expect(refused.state).toBe("refused");
  expect(refused.exitCode).toBe(2);
  expect(existsSync(bin("context-fern"))).toBe(true);

  const declined = await runUninstall(
    {},
    uninstallDeps(f, { interactive: true, ask: async () => false }),
  );
  expect(declined.exitCode).toBe(2);
  expect(existsSync(bin("context-fern"))).toBe(true);

  const accepted = await runUninstall(
    {},
    uninstallDeps(f, { interactive: true, ask: async () => true }),
  );
  expect(accepted.exitCode).toBe(0);
  expect(existsSync(bin("context-fern"))).toBe(false);
});

test("a file the user changed after install is left alone and reported; the rest is removed; exit 1", async () => {
  await installFake(f);
  await writeFile(sidecar(), "patched by the user");

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(sidecar(), "utf-8")).toBe("patched by the user");
  expect(r.leftAlone.map((l) => l.path)).toEqual([sidecar()]);
  expect(r.leftAlone[0]?.reason).toContain("changed since install");
  expect(existsSync(bin("context-fern"))).toBe(false);
  expect(r.exitCode).toBe(1);
  expect(out()).toContain("left");
});

test("files the manifest does not list are never touched, whatever their names, and keep their directories alive", async () => {
  await installFake(f);
  const theirs = [
    bin("mytool"),
    bin("context-fern.old-1"),
    join(
      f.prefix,
      "share",
      "context-fern",
      "onnxruntime-native",
      "linux-x64",
      "notes.txt",
    ),
  ];
  for (const p of theirs) await writeFile(p, "mine");

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  for (const p of theirs) expect(await readFile(p, "utf-8")).toBe("mine");
  expect(r.exitCode).toBe(0);
  expect(existsSync(bin("fern"))).toBe(false);
  expect(out()).toContain("not empty");
});

test("a manifest entry pointing outside the install directories is never acted on, even if the file matches its recorded hash", async () => {
  await installFake(f);
  const precious = join(root, "precious.txt");
  await writeFile(precious, "do not delete");
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  m.files.push({
    path: precious,
    sha256: await sha256File(precious),
    bytes: 13,
    role: "binary",
  });
  await writeManifest(f.manifestPath, m);

  await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(precious, "utf-8")).toBe("do not delete");
  expect(out()).toContain(
    "ignored a manifest entry outside the install directories",
  );
});

test("a partial install (listed files already gone) is not an error", async () => {
  await installFake(f);
  await rm(bin("fern"));
  await rm(sidecar());
  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(r.exitCode).toBe(0);
  expect(r.alreadyGone.length).toBeGreaterThanOrEqual(2);
  expect(existsSync(bin("context-fern"))).toBe(false);
});

test("an interrupted install (a manifest that lists nothing yet) uninstalls cleanly", async () => {
  await mkdir(join(f.prefix, "share", "context-fern"), { recursive: true });
  await writeManifest(f.manifestPath, {
    schema: 1,
    version: "0.1.0",
    installedAt: "t",
    platform: "linux-x64",
    prefix: f.prefix,
    binDir: join(f.prefix, "bin"),
    shareDir: join(f.prefix, "share", "context-fern"),
    files: [],
    pathEdit: null,
    plugin: null,
  });
  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(r.exitCode).toBe(0);
  expect(existsSync(f.manifestPath)).toBe(false);
});

test("a manifest from before createdDirs existed uninstalls with the conservative rule: the share directory goes, the shared bin directory stays", async () => {
  await mkdir(f.prefix, { recursive: true });
  await installFake(f);
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  const { createdDirs: _c, pendingDeletes: _p, ...older } = m;
  await writeManifest(f.manifestPath, older as typeof m);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(r.exitCode).toBe(0);
  expect(existsSync(join(f.prefix, "share", "context-fern"))).toBe(false);
  expect(existsSync(join(f.prefix, "bin"))).toBe(true); // ~/.local/bin is not ours to remove
  expect(await readdir(join(f.prefix, "bin"))).toEqual([]);
});

test("a manifest written by a newer version, or one that is not a manifest, is refused and nothing is touched", async () => {
  await installFake(f);
  const m = (await readManifest(f.manifestPath)) as object;
  await writeFile(f.manifestPath, JSON.stringify({ ...m, schema: 2 }));
  const newer = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(newer.state).toBe("refused");
  expect(newer.exitCode).toBe(1);
  expect(out()).toContain("newer");
  expect(existsSync(bin("context-fern"))).toBe(true);

  await writeFile(f.manifestPath, "not json at all");
  const junk = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(junk.state).toBe("refused");
  expect(existsSync(bin("context-fern"))).toBe(true);
});

test("the daemon is stopped, and waited for, before any file is removed", async () => {
  await installFake(f);
  const calls: string[] = [];
  await runUninstall(
    { yes: "true" },
    uninstallDeps(f, {
      stopDaemon: async () => {
        calls.push(
          `stop (binary still there: ${existsSync(bin("context-fern"))})`,
        );
        return { state: "stopped", pid: 1, waitedMs: 10 };
      },
    }),
  );
  expect(calls).toEqual(["stop (binary still there: true)"]);
  expect(existsSync(bin("context-fern"))).toBe(false);
});

test("user data is never touched: it is listed with the one command that deletes it", async () => {
  await installFake(f);
  const project = join(root, "work", "app");
  await mkdir(join(project, ".fern"), { recursive: true });
  await writeFile(join(project, ".fern", "fern.db"), "database");
  await mkdir(join(f.home, ".fern"), { recursive: true });
  await writeFile(
    join(f.home, ".fern", "projects.json"),
    JSON.stringify({ projects: [{ path: project }] }),
  );

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(join(project, ".fern", "fern.db"), "utf-8")).toBe(
    "database",
  );
  expect(existsSync(join(f.home, ".fern", "projects.json"))).toBe(true);
  expect(r.dataLocations).toEqual([
    join(project, ".fern"),
    join(f.home, ".fern"),
  ]);
  expect(out()).toContain(
    `rm -rf -- '${join(project, ".fern")}' '${join(f.home, ".fern")}'`,
  );
  expect(out()).toContain("your data was not touched");
});

// ---- the PATH block, the statusline entry

test("the PATH block init appended is removed, the user's own lines stay, and a copy is made first", async () => {
  await installFake(f, {}, { "no-plugin": "true", "add-to-path": "true" });
  const rc = join(f.home, ".zshrc");
  const written = await readFile(rc, "utf-8");
  expect(written).toContain("# >>> context-fern >>>");
  await writeFile(rc, `alias mine=1\n${written}export AFTER=1\n`);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  const after = await readFile(rc, "utf-8");
  expect(after).not.toContain("context-fern");
  expect(after).toContain("alias mine=1\n");
  expect(after).toContain("export AFTER=1\n");
  expect(r.removed.some((x) => x.startsWith("PATH block"))).toBe(true);
  const backups = (await readdir(f.home)).filter(
    (n) => n.includes("context-fern-uninstall") && n.endsWith(".bak"),
  );
  expect(backups.length).toBe(1);
});

test("a PATH block the user edited is left alone and reported", async () => {
  await installFake(f, {}, { "no-plugin": "true", "add-to-path": "true" });
  const rc = join(f.home, ".zshrc");
  const edited = (await readFile(rc, "utf-8")).replace(
    "export PATH=",
    "export PATH=/opt/x:",
  );
  await writeFile(rc, edited);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(rc, "utf-8")).toBe(edited);
  expect(r.leftAlone.some((l) => l.path === rc)).toBe(true);
  expect(r.exitCode).toBe(1);
});

test("--keep-path leaves the PATH block in place", async () => {
  await installFake(f, {}, { "no-plugin": "true", "add-to-path": "true" });
  const rc = join(f.home, ".zshrc");
  const before = await readFile(rc, "utf-8");
  await runUninstall({ yes: "true", "keep-path": "true" }, uninstallDeps(f));
  expect(await readFile(rc, "utf-8")).toBe(before);
});

const OLD_STATUSLINE = `bun run "C:\\work\\alpha\\packages\\plugin-claude-code\\scripts\\statusline.ts"`;

async function settingsWith(command: string): Promise<string> {
  await mkdir(join(f.home, ".claude"), { recursive: true });
  const settings = join(f.home, ".claude", "settings.json");
  await writeFile(
    settings,
    JSON.stringify({ model: "x", statusLine: { type: "command", command } }),
  );
  return settings;
}

async function recordStatuslineInManifest(command: string, file: string) {
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  await writeManifest(f.manifestPath, {
    ...m,
    statusline: { file, command, backupPath: null },
  });
}

test("the statusLine init recorded adding is removed, with a backup, and everything else in settings.json stays", async () => {
  await installFake(f);
  const settings = await settingsWith("context-fern statusline");
  await recordStatuslineInManifest("context-fern statusline", settings);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(JSON.parse(await readFile(settings, "utf-8"))).toEqual({ model: "x" });
  expect(
    (await readdir(join(f.home, ".claude"))).some((n) => n.endsWith(".bak")),
  ).toBe(true);
  expect(r.leftAlone).toEqual([]);
});

test("the one old command earlier versions wrote is removed even with no record", async () => {
  await installFake(f);
  const settings = await settingsWith(OLD_STATUSLINE);

  await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(JSON.parse(await readFile(settings, "utf-8"))).toEqual({ model: "x" });
});

test("a statusLine that merely looks like fern's, with no record of init adding it, is left alone and reported", async () => {
  await installFake(f);
  const settings = await settingsWith("context-fern statusline");
  const original = await readFile(settings, "utf-8");

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(settings, "utf-8")).toBe(original);
  expect(r.leftAlone.map((l) => l.path)).toEqual([settings]);
  expect(r.leftAlone[0]?.reason).toContain("init did not record adding it");
  expect(r.exitCode).toBe(1);
  expect(
    (await readdir(join(f.home, ".claude"))).some((n) => n.endsWith(".bak")),
  ).toBe(false);
});

test("if the user changed the statusLine after init recorded it, it is left alone even though the new command is a fern one", async () => {
  await installFake(f);
  const settings = await settingsWith("context-fern statusline");
  await recordStatuslineInManifest("fern statusline --old-recorded", settings);
  const original = await readFile(settings, "utf-8");

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(settings, "utf-8")).toBe(original);
  expect(r.leftAlone[0]?.reason).toContain("not the command init recorded");
});

test("an unquoted bun run command, which fern never wrote, is the user's own and is left alone", async () => {
  await installFake(f);
  const settings = await settingsWith(
    "bun run /home/a/alpha/packages/plugin-claude-code/scripts/statusline.ts",
  );
  const original = await readFile(settings, "utf-8");
  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));
  expect(await readFile(settings, "utf-8")).toBe(original);
  expect(r.leftAlone.length).toBe(1);
});

test("a statusLine that is not fern's is the user's: left alone and reported", async () => {
  await installFake(f);
  await mkdir(join(f.home, ".claude"), { recursive: true });
  const settings = join(f.home, ".claude", "settings.json");
  const original = JSON.stringify({
    statusLine: { type: "command", command: "echo mine" },
  });
  await writeFile(settings, original);

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(settings, "utf-8")).toBe(original);
  expect(r.leftAlone.some((l) => l.path === settings)).toBe(true);
});

// ---- the plugin and its marketplace, through a real stub claude executable

async function withPlugin(extra: { marketplaceAddedByInit?: boolean } = {}) {
  await installFake(f);
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  await writeManifest(f.manifestPath, {
    ...m,
    plugin: {
      method: "claude-cli",
      marketplace: "context-fern",
      plugin: "fern@context-fern",
      ...extra,
    },
  });
  const log = join(root, "stub.log");
  process.env.STUB_CLAUDE_LOG = log;
  return log;
}

test("when init added the marketplace, uninstall removes the plugin and then the marketplace, through claude", async () => {
  const log = await withPlugin({ marketplaceAddedByInit: true });
  const r = await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
    ["plugin", "marketplace", "remove", "--", "context-fern"],
  ]);
  expect(r.exitCode).toBe(0);
});

test("when the marketplace was configured before init, only the plugin is removed", async () => {
  const log = await withPlugin({ marketplaceAddedByInit: false });
  await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
  ]);
});

test("when the manifest cannot say who added the marketplace: non-interactive leaves it and prints the command; interactive asks", async () => {
  let log = await withPlugin({});
  const quiet = await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
  ]);
  expect(quiet.manual).toContain(
    "claude plugin marketplace remove context-fern",
  );

  await rm(f.prefix, { recursive: true, force: true });
  await rm(log);
  log = await withPlugin({});
  const questions: string[] = [];
  await runUninstall(
    { yes: "true" },
    uninstallDeps(f, {
      which: () => stubPath,
      interactive: true,
      ask: async (q) => {
        questions.push(q);
        return true;
      },
    }),
  );
  expect(questions.length).toBe(1);
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
    ["plugin", "marketplace", "remove", "--", "context-fern"],
  ]);

  await rm(f.prefix, { recursive: true, force: true });
  await rm(log);
  log = await withPlugin({});
  await runUninstall(
    { yes: "true" },
    uninstallDeps(f, {
      which: () => stubPath,
      interactive: true,
      ask: async () => false,
    }),
  );
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
  ]);
});

test("--keep-plugin never calls claude", async () => {
  const log = await withPlugin({ marketplaceAddedByInit: true });
  await runUninstall(
    { yes: "true", "keep-plugin": "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );
  expect(await stubCalls(log)).toEqual([]);
});

test("if claude refuses to uninstall the plugin, that is reported with the command to run, and the files are still removed; exit 1", async () => {
  const log = await withPlugin({ marketplaceAddedByInit: false });
  process.env.STUB_CLAUDE_FAIL = "uninstall";
  const r = await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );
  expect(await stubCalls(log)).toEqual([
    ["plugin", "uninstall", "--", "fern@context-fern"],
  ]);
  expect(r.failed.map((x) => x.what)).toEqual(["plugin fern@context-fern"]);
  expect(r.manual).toContain("claude plugin uninstall fern@context-fern");
  expect(r.exitCode).toBe(1);
  expect(existsSync(bin("context-fern"))).toBe(false);
});

test("without a claude command on PATH the exact commands are printed instead", async () => {
  await withPlugin({ marketplaceAddedByInit: true });
  const r = await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => null }),
  );
  expect(r.manual).toEqual([
    "claude plugin uninstall fern@context-fern",
    "claude plugin marketplace remove context-fern",
  ]);
});

test("no code path runs the real claude: the stub is the only executable the plugin step can reach", () => {
  // `which` is injected in every test above; this guards the test setup itself.
  expect(stubPath.startsWith(stubDir)).toBe(true);
  expect(EXE === ".exe" ? stubPath.endsWith(".exe") : true).toBe(true);
});

test("the printed delete commands quote every character that could end a quoted string, including typographic quotes in PowerShell", async () => {
  const { dataDeleteCommand } = await import("../../src/install/uninstall");
  const { manualRemoveCommand } = await import(
    "../../src/install/windows-self-delete"
  );
  const nasty = "C:/Users/Bob\u2019s \u2018project\u2019 it's/.fern";
  const ps = dataDeleteCommand("win32", [nasty]);
  // Each of ' and the typographic quotes appears doubled, so none can close the string.
  expect(ps).toContain("Bob\u2019\u2019s");
  expect(ps).toContain("\u2018\u2018project\u2019\u2019");
  expect(ps).toContain("it''s");
  expect(manualRemoveCommand(nasty)).toContain("Bob\u2019\u2019s");

  const posix = dataDeleteCommand("linux", ["/a b/it's $HOME `x`/.fern"]);
  expect(posix).toBe("rm -rf -- '/a b/it'\\''s $HOME `x`/.fern'");
});

test("createdDirs from the manifest is honoured only for absolute directories that are inside, or ancestors of, the install directories: a user's unrelated empty directory is never removed", async () => {
  await installFake(f);
  const unrelated = join(root, "my-empty-folder");
  await mkdir(unrelated, { recursive: true });
  const relative = join(root, "rel-target");
  await mkdir(relative, { recursive: true });
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  await writeManifest(f.manifestPath, {
    ...m,
    createdDirs: [...(m.createdDirs ?? []), unrelated, "rel-target"],
  });
  const before = process.cwd();
  process.chdir(root); // a relative entry would resolve here
  try {
    await runUninstall({ yes: "true" }, uninstallDeps(f));
  } finally {
    process.chdir(before);
  }
  expect(existsSync(unrelated)).toBe(true);
  expect(existsSync(relative)).toBe(true);
  expect(existsSync(f.prefix)).toBe(false); // the dirs init really made still go
});

test("a user's own empty folder inside the install directories is never removed, even if an edited manifest lists it as created by init", async () => {
  await installFake(f);
  const mineInBin = join(f.prefix, "bin", "my-empty-folder");
  const mineInShare = join(f.prefix, "share", "context-fern", "mine");
  const mineInSidecar = join(
    f.prefix,
    "share",
    "context-fern",
    "onnxruntime-native",
    "linux-x64",
    "mine-too",
  );
  for (const d of [mineInBin, mineInShare, mineInSidecar])
    await mkdir(d, { recursive: true });
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  await writeManifest(f.manifestPath, {
    ...m,
    createdDirs: [
      ...(m.createdDirs ?? []),
      mineInBin,
      mineInShare,
      mineInSidecar,
    ],
  });

  const r = await runUninstall({ yes: "true" }, uninstallDeps(f));

  for (const d of [mineInBin, mineInShare, mineInSidecar])
    expect(existsSync(d)).toBe(true);
  expect(out()).toContain(
    "it is not an install directory or above a file init installed",
  );
  // The directories init really made are still removed where nothing of the user's is in them.
  expect(
    existsSync(
      join(
        f.prefix,
        "share",
        "context-fern",
        "onnxruntime-native",
        "linux-x64",
        "onnxruntime_binding.node",
      ),
    ),
  ).toBe(false);
  expect(r.exitCode).toBe(0);
});

test("vetDirectories: a link is never accepted, and neither is a directory whose real path is outside the install directories, even when it sits above a listed file", async () => {
  const { vetDirectories } = await import("../../src/install/uninstall");
  await installFake(f);
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  const layout = {
    prefix: f.prefix,
    binDir: join(f.prefix, "bin"),
    shareDir: join(f.prefix, "share", "context-fern"),
    manifestPath: f.manifestPath,
    exeSuffix: "",
  };

  // Control: the real chain is accepted.
  const ok = await vetDirectories(
    [layout.binDir, layout.shareDir, f.prefix],
    m,
    layout,
    f.cache,
  );
  expect(ok).toEqual([layout.binDir, layout.shareDir, f.prefix]);

  // An empty directory elsewhere, reached through a link that sits in the file chain.
  const outside = join(root, "elsewhere");
  await mkdir(outside, { recursive: true });
  const alias = join(f.prefix, "share", "context-fern", "alias");
  try {
    await symlink(outside, alias, "junction");
  } catch {
    return; // no privilege to create links here
  }
  const crafted = {
    ...m,
    files: [
      ...m.files,
      {
        path: join(alias, "x"),
        sha256: "a",
        bytes: 1,
        role: "sidecar" as const,
      },
    ],
  };
  expect(await vetDirectories([alias], crafted, layout, f.cache)).toEqual([]);
});

test("an edited manifest cannot point the statusLine edit at another file", async () => {
  await installFake(f);
  const elsewhere = join(f.root, "not-claude-settings.json");
  const body = JSON.stringify({
    statusLine: { type: "command", command: "my-own-thing" },
  });
  await writeFile(elsewhere, body);
  await recordStatuslineInManifest("my-own-thing", elsewhere);

  await runUninstall({ yes: "true" }, uninstallDeps(f));

  expect(await readFile(elsewhere, "utf-8")).toBe(body);
  expect(out()).toContain("it was ignored");
});

test("plugin and marketplace names from the manifest that are not plain names are ignored and reported, and never reach claude", async () => {
  await installFake(f);
  const m = (await readManifest(f.manifestPath)) as NonNullable<
    Awaited<ReturnType<typeof readManifest>>
  >;
  await writeManifest(f.manifestPath, {
    ...m,
    plugin: {
      method: "claude-cli",
      marketplace: "--scope=user",
      plugin: "-x; rm -rf",
      marketplaceAddedByInit: true,
    },
  });
  const log = join(root, "stub.log");
  process.env.STUB_CLAUDE_LOG = log;

  await runUninstall(
    { yes: "true" },
    uninstallDeps(f, { which: () => stubPath }),
  );

  const calls = await stubCalls(log);
  expect(JSON.stringify(calls)).not.toContain("--scope");
  expect(JSON.stringify(calls)).not.toContain("rm -rf");
  expect(out()).toContain("not a plain name");
});
