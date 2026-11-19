import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GlobalInitDeps,
  runGlobalInit,
  shouldRunProjectInit,
} from "../../src/install/global-init";
import { readManifest } from "../../src/install/manifest";
import type { CommandRunner } from "../../src/install/plugin-setup";

const EXE = process.platform === "win32" ? ".exe" : "";
let root: string;
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fern-ginit-test-"));
  logs = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function shippedExe(): Promise<string> {
  const dir = join(root, "pkg");
  await mkdir(join(dir, "onnxruntime-native", "linux-x64"), {
    recursive: true,
  });
  await writeFile(join(dir, `context-fern${EXE}`), "exe-bytes");
  await writeFile(
    join(dir, "onnxruntime-native", "linux-x64", "onnxruntime_binding.node"),
    "binding",
  );
  return join(dir, `context-fern${EXE}`);
}

function deps(over: Partial<GlobalInitDeps>): GlobalInitDeps {
  return {
    platform: "linux",
    env: {
      FERN_INSTALL_PREFIX: join(root, "prefix"),
      PATH: "",
      SHELL: "/bin/zsh",
    },
    home: join(root, "home"),
    execPath: join(root, `bun${EXE}`),
    interactive: false,
    ask: async () => {
      throw new Error("must not prompt when not interactive");
    },
    log: (l) => logs.push(l),
    which: () => null,
    now: () => new Date("2026-01-01T00:00:00Z"),
    modelCacheDir: join(root, "cache"),
    addToWindowsPath: async () => {
      throw new Error("PATH must not be edited here");
    },
    ...over,
  };
}

const manifestPath = () =>
  join(root, "prefix", "share", "context-fern", "install-manifest.json");

test("from a source checkout nothing outside the project is touched", async () => {
  const r = await runGlobalInit({ yes: "true" }, deps({}));
  expect(r.installedBinary).toBe(false);
  expect(existsSync(join(root, "prefix"))).toBe(false);
  expect(logs.join("\n")).toContain("source checkout");
});

test("a shipped binary is installed, the manifest records every file with its hash, and --yes alone leaves PATH alone", async () => {
  const exe = await shippedExe();
  const r = await runGlobalInit(
    { yes: "true", "no-plugin": "true" },
    deps({ execPath: exe }),
  );
  expect(r.installedBinary).toBe(true);
  expect(r.onPath).toBe(false);

  const m = await readManifest(manifestPath());
  expect(m?.schema).toBe(1);
  expect(m?.pathEdit).toBeNull(); // --yes alone never edits PATH
  expect(m?.plugin).toBeNull();
  expect(m?.files.filter((f) => f.role === "binary").length).toBe(2);
  expect(m?.files.every((f) => f.sha256.length === 64)).toBe(true);

  const out = logs.join("\n");
  expect(out).toContain("is not on your PATH");
  expect(out).toContain(
    "hooks do not run and your prompts pass through untouched",
  );
  expect(out).toContain("--add-to-path");
  expect(existsSync(join(root, "home", ".zshrc"))).toBe(false);
});

test("--add-to-path appends the marked block to the shell startup file, records it, and says to open a new terminal", async () => {
  const exe = await shippedExe();
  await mkdir(join(root, "home"), { recursive: true });
  await runGlobalInit(
    { "add-to-path": "true", "no-plugin": "true" },
    deps({ execPath: exe }),
  );
  const rc = await readFile(join(root, "home", ".zshrc"), "utf-8");
  expect(rc).toContain(join(root, "prefix", "bin"));
  const m = await readManifest(manifestPath());
  expect(m?.pathEdit?.kind).toBe("shell-rc");
  expect(logs.join("\n")).toContain("open a new terminal");
});

test("an interactive 'yes' edits PATH; an interactive 'no' does not", async () => {
  const exe = await shippedExe();
  await mkdir(join(root, "home"), { recursive: true });
  await runGlobalInit(
    { "no-plugin": "true" },
    deps({ execPath: exe, interactive: true, ask: async () => false }),
  );
  expect((await readManifest(manifestPath()))?.pathEdit).toBeNull();
  expect(existsSync(join(root, "home", ".zshrc"))).toBe(false);
});

test("the plugin is registered through claude only with consent, and the manifest says how", async () => {
  const exe = await shippedExe();
  const calls: string[] = [];
  const runner: CommandRunner = async (_c, args) => {
    calls.push(args.join(" "));
    return { ok: true, output: "" };
  };
  // No consent: nothing is run.
  await runGlobalInit(
    {},
    deps({ execPath: exe, which: () => "claude", runner }),
  );
  expect(calls).toEqual([]);
  expect(logs.join("\n")).toContain("skipped the Claude Code plugin");

  logs.length = 0;
  await runGlobalInit(
    { yes: "true" },
    deps({ execPath: exe, which: () => "claude", runner }),
  );
  // list marketplaces (to know whether init added ours), add it, install the plugin
  expect(calls.length).toBe(3);
  expect(calls[0]).toContain("marketplace list");
  expect((await readManifest(manifestPath()))?.plugin?.method).toBe(
    "claude-cli",
  );
});

test("when claude is missing or a step fails, the exact manual commands are printed and nothing is claimed as installed", async () => {
  const exe = await shippedExe();
  await runGlobalInit(
    { yes: "true" },
    deps({ execPath: exe, which: () => null }),
  );
  const out = logs.join("\n");
  expect(out).toContain("Claude Code plugin not installed");
  expect(out).toContain("claude plugin marketplace add");
  expect(out).toContain("claude plugin install fern@context-fern");
  expect((await readManifest(manifestPath()))?.plugin?.method).toBe("manual");

  logs.length = 0;
  const failing: CommandRunner = async () => ({ ok: false, output: "boom" });
  await rm(join(root, "prefix"), { recursive: true, force: true });
  await runGlobalInit(
    { yes: "true" },
    deps({ execPath: exe, which: () => "claude", runner: failing }),
  );
  expect(logs.join("\n")).toContain("adding the marketplace failed (boom)");
});

test("running init again from the installed copy finds everything in place and keeps the original install time", async () => {
  const exe = await shippedExe();
  await runGlobalInit({ "no-plugin": "true" }, deps({ execPath: exe }));
  const first = await readManifest(manifestPath());

  logs.length = 0;
  const installed = join(root, "prefix", "bin", `context-fern${EXE}`);
  const later = await runGlobalInit(
    { "no-plugin": "true" },
    deps({ execPath: installed, now: () => new Date("2027-01-01T00:00:00Z") }),
  );
  expect(later.installedBinary).toBe(false);
  expect(logs.join("\n")).toContain("already installed");
  const second = await readManifest(manifestPath());
  expect(second?.installedAt).toBe(first?.installedAt);
  expect(second?.files.length).toBe(first?.files.length);
});

test("--no-install skips the copy but still reports PATH honestly", async () => {
  const exe = await shippedExe();
  await runGlobalInit(
    { "no-install": "true", "no-plugin": "true" },
    deps({ execPath: exe }),
  );
  expect(existsSync(join(root, "prefix", "bin"))).toBe(false);
  expect(logs.join("\n")).toContain("skipped installing the binary");
});

test("project init is skipped in the home directory (where .fern/ is the daemon's own state) and in a filesystem root", () => {
  const home = join(root, "home");
  expect(shouldRunProjectInit(home, home, {})).toBe(false);
  expect(shouldRunProjectInit(join(home, "proj"), home, {})).toBe(true);
  expect(
    shouldRunProjectInit(join(home, "proj"), home, { "no-project": "true" }),
  ).toBe(false);
  expect(
    shouldRunProjectInit(process.platform === "win32" ? "C:\\" : "/", home, {}),
  ).toBe(false);
});

test("--no-install on an existing install keeps the binary and sidecar entries in the manifest", async () => {
  const exe = await shippedExe();
  await runGlobalInit({ "no-plugin": "true" }, deps({ execPath: exe }));
  const before = await readManifest(manifestPath());
  expect(before?.files.some((f) => f.role === "sidecar")).toBe(true);

  await runGlobalInit(
    { "no-install": "true", "no-plugin": "true" },
    deps({ execPath: exe }),
  );
  const after = await readManifest(manifestPath());
  expect(after?.files.filter((f) => f.role !== "model")).toEqual(
    before?.files.filter((f) => f.role !== "model"),
  );
});

test("a PATH block that is already in the startup file is recorded as ours and reported as unchanged", async () => {
  const exe = await shippedExe();
  await mkdir(join(root, "home"), { recursive: true });
  await runGlobalInit(
    { "add-to-path": "true", "no-plugin": "true" },
    deps({ execPath: exe }),
  );
  await rm(manifestPath()); // the manifest was lost, the rc block was not
  logs.length = 0;
  const installed = join(root, "prefix", "bin", `context-fern${EXE}`);
  await runGlobalInit(
    { "add-to-path": "true", "no-plugin": "true" },
    deps({ execPath: installed }),
  );
  expect(logs.join("\n")).toContain(
    "already has the PATH block, so nothing was changed",
  );
  expect((await readManifest(manifestPath()))?.pathEdit?.kind).toBe("shell-rc");
  const rc = await readFile(join(root, "home", ".zshrc"), "utf-8");
  expect(rc.split("# >>> context-fern >>>").length).toBe(2);
});

test("if a later step fails, the files already installed are still in the manifest", async () => {
  const exe = await shippedExe();
  await expect(
    runGlobalInit(
      { "no-plugin": "true" },
      deps({
        execPath: exe,
        interactive: true,
        ask: async () => {
          throw new Error("stdin closed");
        },
      }),
    ),
  ).rejects.toThrow("stdin closed");
  const m = await readManifest(manifestPath());
  expect(m?.files.filter((f) => f.role === "binary").length).toBe(2);
});

test("a different fern already in the bin directory stops init with a message and is left alone", async () => {
  const exe = await shippedExe();
  const bin = join(root, "prefix", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fern"), "not ours");
  await expect(
    runGlobalInit({ "no-plugin": "true" }, deps({ execPath: exe })),
  ).rejects.toThrow(/not installed by context-fern/);
  expect(await readFile(join(bin, "fern"), "utf-8")).toBe("not ours");
  expect(logs.join("\n")).toContain("could not install");
});
