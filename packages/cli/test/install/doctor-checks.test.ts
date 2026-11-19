// The doctor's checks against real installs made by the real `init` code, real
// files, a real compiled stub `claude`, and (for the native library check) the
// real pinned onnxruntime files copied from node_modules. Nothing here calls
// the real claude command.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "@context-fern/core";
import { nativePinsFor } from "@context-fern/embed/native-pins";
import {
  type Check,
  collectChecks,
  type DoctorDeps,
  realDoctorDeps,
  runDoctor,
} from "../../src/commands/doctor";
import { defaultRunner } from "../../src/install/plugin-setup";
import {
  buildStubClaude,
  EXE,
  type Fixture,
  fixture,
  installFake,
} from "./stub-helpers";

let root: string;
let f: Fixture;
let stubDir: string;
let stubPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "fern-doctor-stub-"));
  stubPath = await buildStubClaude(stubDir);
}, 120_000);
afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
}, 60_000);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-doctor-test-"));
  f = fixture(root);
  for (const k of ["STUB_CLAUDE_PLUGINS", "STUB_CLAUDE_FAIL"])
    savedEnv[k] = process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
}, 60_000);

/** Deps where everything is fine and nothing touches the machine; each test overrides what it exercises. */
function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    ...realDoctorDeps(),
    env: { FERN_INSTALL_PREFIX: f.prefix, FERN_HOME: f.home, PATH: "" },
    platform: "linux",
    arch: "x64",
    home: f.home,
    cwd: root,
    execPath: join(root, `bun${EXE}`),
    which: () => null,
    runner: async () => ({ ok: false, output: "" }),
    readDaemon: async () => null,
    daemonAlive: async () => false,
    thisBuildId: () => "0.1.0+exe1",
    checkModel: async () => null,
    modelCacheDir: f.cache,
    ollamaUrl: async () => null,
    pingOllama: async () => false,
    ...over,
  };
}

const byId = (checks: Check[], id: string) =>
  checks.find((c) => c.id === id) as Check;
const bin = (name: string) => join(f.prefix, "bin", name);

// ---- install manifest

test("every file matching the install manifest is ok", async () => {
  await installFake(f);
  const c = byId(await collectChecks(deps()), "install");
  expect(c.status).toBe("ok");
  expect(c.message).toContain("match the install manifest");
});

test("a missing file and a changed file are each reported, with the one command that fixes it", async () => {
  await installFake(f);
  await rm(bin("fern"));
  await writeFile(
    join(
      f.prefix,
      "share",
      "context-fern",
      "onnxruntime-native",
      "linux-x64",
      "onnxruntime_binding.node",
    ),
    "tampered",
  );
  const c = byId(await collectChecks(deps()), "install");
  expect(c.status).toBe("problem");
  expect(c.message).toContain("missing:");
  expect(c.message).toContain("changed since install:");
  expect(c.fix).toBe("context-fern init");
});

test("with no install manifest the files are not checked, and that is said, not treated as a problem", async () => {
  const c = byId(await collectChecks(deps()), "install");
  expect(c.status).toBe("info");
});

// ---- PATH

test("PATH: the installed copy found first is ok; another copy found first is a problem naming both", async () => {
  await installFake(f);
  const installed = bin("context-fern");
  expect(
    byId(await collectChecks(deps({ which: () => installed })), "context-fern")
      .status,
  ).toBe("ok");

  const other = join(root, "elsewhere", "context-fern");
  const shadowed = byId(
    await collectChecks(deps({ which: () => other })),
    "context-fern",
  );
  expect(shadowed.status).toBe("problem");
  expect(shadowed.message).toContain("another copy");
  expect(shadowed.message).toContain(installed);
});

test("PATH: edited by init but not in this terminal says to open a new one; never edited says how to add it", async () => {
  await installFake(f, {}, { "no-plugin": "true", "add-to-path": "true" });
  const fresh = byId(await collectChecks(deps()), "context-fern");
  expect(fresh.status).toBe("problem");
  expect(fresh.fix).toBe("open a new terminal");

  await rm(f.prefix, { recursive: true, force: true });
  await installFake(f);
  const never = byId(await collectChecks(deps()), "context-fern");
  expect(never.status).toBe("problem");
  expect(never.fix).toBe("context-fern init --add-to-path");
});

test("PATH: with no install manifest (a source checkout) the old message and fix are kept", async () => {
  const missing = byId(await collectChecks(deps()), "context-fern");
  expect(missing.message).toContain("not on PATH");
  expect(missing.fix).toContain('run "bun link --global" in packages/cli');
  expect(
    byId(
      await collectChecks(deps({ which: () => "/x/context-fern" })),
      "context-fern",
    ).message,
  ).toBe("on PATH (/x/context-fern)");
});

// ---- the plugin, through the real stub claude executable

const pluginDeps = () =>
  deps({
    which: (c) => (c === "claude" ? stubPath : null),
    runner: defaultRunner,
  });

test("plugin: matching version is ok, a different version is a skew problem with the update command, disabled is a problem, not installed is info", async () => {
  process.env.STUB_CLAUDE_PLUGINS = JSON.stringify([
    { id: "fern@context-fern", version: CLI_VERSION, enabled: true },
  ]);
  expect(byId(await collectChecks(pluginDeps()), "plugin").status).toBe("ok");

  process.env.STUB_CLAUDE_PLUGINS = JSON.stringify([
    { id: "fern@context-fern", version: "0.0.1", enabled: true },
  ]);
  const skew = byId(await collectChecks(pluginDeps()), "plugin");
  expect(skew.status).toBe("problem");
  expect(skew.message).toContain("0.0.1");
  expect(skew.fix).toContain("claude plugin update fern@context-fern");

  process.env.STUB_CLAUDE_PLUGINS = JSON.stringify([
    { id: "fern@context-fern", version: CLI_VERSION, enabled: false },
  ]);
  expect(byId(await collectChecks(pluginDeps()), "plugin").fix).toBe(
    "claude plugin enable fern@context-fern",
  );

  process.env.STUB_CLAUDE_PLUGINS = "[]";
  expect(byId(await collectChecks(pluginDeps()), "plugin").status).toBe("info");
});

test("plugin: no claude command, or one that cannot list, is info, never a failure of the doctor", async () => {
  expect(byId(await collectChecks(deps()), "plugin").status).toBe("info");
  process.env.STUB_CLAUDE_FAIL = "list";
  expect(byId(await collectChecks(pluginDeps()), "plugin").status).toBe("info");
});

// ---- the native library, against the real pinned files

const shippedHost = nativePinsFor(process.platform, process.arch) !== undefined;
const hostTest = shippedHost ? test : test.skip;

async function nativeInstall(): Promise<{ exe: string; dir: string }> {
  const exe = join(root, "inst", "bin", `context-fern${EXE}`);
  const dir = join(
    root,
    "inst",
    "share",
    "context-fern",
    "onnxruntime-native",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(join(root, "inst", "bin"), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(exe, "exe");
  const from = join(
    import.meta.dir,
    "../../../..",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    process.platform,
    process.arch,
  );
  for (const name of Object.keys(
    nativePinsFor(process.platform, process.arch) ?? {},
  )) {
    copyFileSync(join(from, name), join(dir, name));
  }
  return { exe, dir };
}

const nativeDeps = (exe: string) =>
  deps({ platform: process.platform, arch: process.arch, execPath: exe });

hostTest(
  "native library: the real files match their pins; one changed byte is a problem naming the file and the fix",
  async () => {
    const { exe, dir } = await nativeInstall();
    expect(
      byId(await collectChecks(nativeDeps(exe)), "native library").status,
    ).toBe("ok");

    const binding = join(dir, "onnxruntime_binding.node");
    const bytes = await readFile(binding);
    bytes[1000] = (bytes[1000] ?? 0) ^ 0xff;
    await writeFile(binding, bytes);
    const bad = byId(await collectChecks(nativeDeps(exe)), "native library");
    expect(bad.status).toBe("problem");
    expect(bad.message).toContain("onnxruntime_binding.node");
    expect(bad.fix).toBe("context-fern init");
  },
);

hostTest(
  "native library: files that are not there at all are a problem; a source checkout and an unshipped platform are info",
  async () => {
    const { exe, dir } = await nativeInstall();
    await rm(dir, { recursive: true, force: true });
    expect(
      byId(await collectChecks(nativeDeps(exe)), "native library").message,
    ).toContain("not found");

    expect(
      byId(
        await collectChecks(deps({ execPath: join(root, `bun${EXE}`) })),
        "native library",
      ).status,
    ).toBe("info");
    expect(
      byId(
        await collectChecks(
          deps({ platform: "darwin", arch: "x64", execPath: exe }),
        ),
        "native library",
      ).status,
    ).toBe("info");
  },
);

// ---- the statusline

async function writeSettings(command: unknown) {
  await mkdir(join(f.home, ".claude"), { recursive: true });
  await writeFile(
    join(f.home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command } }),
  );
}

test("statusline: the new command is ok, the old bun form is a problem with the exact line to put, a stranger's is left alone, none is info", async () => {
  expect(byId(await collectChecks(deps()), "statusline").status).toBe("info");

  await writeSettings("context-fern statusline");
  expect(byId(await collectChecks(deps()), "statusline").status).toBe("ok");

  await writeSettings(
    'bun run "C:\\work\\alpha\\packages\\plugin-claude-code\\scripts\\statusline.ts"',
  );
  const old = byId(await collectChecks(deps()), "statusline");
  expect(old.status).toBe("problem");
  expect(old.fix).toContain('statusLine.command to "context-fern statusline"');

  await writeSettings("echo mine");
  expect(byId(await collectChecks(deps()), "statusline").status).toBe("info");
});

// ---- the daemon

test("daemon: not running is info; a running one from a different build is a problem with the stop command; the same build is ok", async () => {
  const running = (buildId: string) =>
    deps({
      readDaemon: async () => ({
        port: 1,
        pid: 1,
        token: "t",
        startedAt: "x",
        buildId,
      }),
      daemonAlive: async () => true,
    });
  expect(byId(await collectChecks(deps()), "daemon").status).toBe("info");

  const mismatch = byId(
    await collectChecks(running("0.0.9+exe5")),
    "daemon build",
  );
  expect(mismatch.status).toBe("problem");
  expect(mismatch.fix).toBe("fern daemon stop");

  expect(
    byId(await collectChecks(running("0.1.0+exe1")), "daemon build").status,
  ).toBe("ok");
});

// ---- the model, and the exit code

test("a missing model is a problem; the fix depends on whether this is an installed binary", async () => {
  const missing = { kind: "missing" as const, path: join(f.cache, "x") };
  const source = byId(
    await collectChecks(deps({ checkModel: async () => missing })),
    "model",
  );
  expect(source.status).toBe("problem");
  expect(source.fix).toContain("fetch-model");

  const installed = byId(
    await collectChecks(
      deps({
        checkModel: async () => missing,
        execPath: join(root, `context-fern${EXE}`),
      }),
    ),
    "model",
  );
  expect(installed.fix).toBe("context-fern init");
});

test("exit code: 0 when nothing is wrong, 1 on any problem, and --json carries the same results", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const healthy = deps({ which: () => "/x/context-fern" });
    expect(await runDoctor({}, healthy)).toBe(0);
    expect(lines.join("\n")).toContain("all checks passed");

    lines.length = 0;
    const broken = deps({ which: () => null });
    expect(await runDoctor({}, broken)).toBe(1);
    expect(lines.join("\n")).toContain("1 problem found");
    expect(lines.join("\n")).toContain("· fix:");

    lines.length = 0;
    expect(await runDoctor({ json: "true" }, broken)).toBe(1);
    const parsed = JSON.parse(lines[0] as string) as {
      ok: boolean;
      checks: Check[];
    };
    expect(parsed.ok).toBe(false);
    expect(
      parsed.checks.filter((c) => c.status === "problem").map((c) => c.id),
    ).toEqual(["context-fern"]);
  } finally {
    console.log = log;
  }
  expect(existsSync(stubPath)).toBe(true);
});

test("a check that throws is reported as a problem of its own and does not abort the report", async () => {
  const checks = await collectChecks(
    deps({
      checkModel: async () => {
        throw new Error("disk exploded");
      },
    }),
  );
  const model = byId(checks, "model");
  expect(model.status).toBe("problem");
  expect(model.message).toContain("disk exploded");
  expect(byId(checks, "statusline")).toBeDefined(); // the checks after it still ran
});

test("plugin: only fern@context-fern counts as ours, not a plugin of the same name from another marketplace", async () => {
  process.env.STUB_CLAUDE_PLUGINS = JSON.stringify([
    { id: "fern@somebody-else", version: "9.9.9", enabled: true },
  ]);
  expect(byId(await collectChecks(pluginDeps()), "plugin").status).toBe("info");
});
