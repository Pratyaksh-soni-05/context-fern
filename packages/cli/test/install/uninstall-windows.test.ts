// The Windows halves of uninstall, against the real thing: the user PATH value
// (on a scratch registry key under HKCU, never the real PATH) and a real
// running executable with the real PowerShell cleanup helper. Skipped on other
// platforms (CI runs them on windows-latest).

import { afterEach, beforeEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGlobalInit } from "../../src/install/global-init";
import { sha256File } from "../../src/install/hash";
import { installLayout } from "../../src/install/layout";
import { readManifest } from "../../src/install/manifest";
import { runUninstall } from "../../src/install/uninstall";
import { removeFromWindowsUserPath } from "../../src/install/uninstall-path";
import { startDeleteHelper } from "../../src/install/windows-self-delete";
import { fixture, initDeps, uninstallDeps } from "./stub-helpers";
import { waitFor, win } from "./windows-test";

function regQuery(subKey: string): { kind: string; value: string } {
  const out = execFileSync(
    "reg.exe",
    ["query", `HKCU\\${subKey}`, "/v", "Path"],
    {
      encoding: "utf-8",
    },
  );
  const m = /Path\s+(REG_\w+)\s+(.*)\r?\n/.exec(out);
  return { kind: m?.[1] ?? "", value: (m?.[2] ?? "").trimEnd() };
}

function regAdd(subKey: string, type: string, value: string): void {
  execFileSync("reg.exe", [
    "add",
    `HKCU\\${subKey}`,
    "/v",
    "Path",
    "/t",
    type,
    "/d",
    value,
    "/f",
  ]);
}

function regDelete(subKey: string): void {
  try {
    execFileSync("reg.exe", ["delete", `HKCU\\${subKey}`, "/f"]);
  } catch {
    // never created
  }
}

let sub: string;
beforeEach(() => {
  sub = `Software\\ContextFernTest-${process.pid}-${Date.now()}`;
});
afterEach(() => regDelete(sub));

const opts = () => ({ registrySubKey: sub, broadcast: false });

win(
  "PATH removal: only the entry init added goes, the value kind and every other entry (including %VAR% forms and empty segments) are exactly as they were",
  async () => {
    regAdd(sub, "REG_EXPAND_SZ", "%USERPROFILE%\\bin;C:\\keep;;C:\\fern\\bin");
    expect(await removeFromWindowsUserPath("C:\\fern\\bin", opts())).toBe(
      "removed",
    );
    expect(regQuery(sub)).toEqual({
      kind: "REG_EXPAND_SZ",
      value: "%USERPROFILE%\\bin;C:\\keep;",
    });
  },
);

win(
  "PATH removal: a trailing backslash and different case still match; absent is reported, not an error",
  async () => {
    regAdd(sub, "REG_SZ", "C:\\a;c:\\FERN\\BIN\\;C:\\b");
    expect(await removeFromWindowsUserPath("C:\\fern\\bin", opts())).toBe(
      "removed",
    );
    expect(regQuery(sub)).toEqual({ kind: "REG_SZ", value: "C:\\a;C:\\b" });
    expect(await removeFromWindowsUserPath("C:\\fern\\bin", opts())).toBe(
      "absent",
    );
    expect(regQuery(sub).value).toBe("C:\\a;C:\\b");
  },
);

win(
  "PATH removal: if the directory appears twice only the last (the one init appended) is removed",
  async () => {
    regAdd(sub, "REG_EXPAND_SZ", "C:\\fern\\bin;C:\\x;C:\\fern\\bin");
    await removeFromWindowsUserPath("C:\\fern\\bin", opts());
    expect(regQuery(sub).value).toBe("C:\\fern\\bin;C:\\x");
  },
);

win(
  "PATH removal: a missing key or value is 'absent' and nothing is created",
  async () => {
    expect(await removeFromWindowsUserPath("C:\\fern\\bin", opts())).toBe(
      "absent",
    );
    expect(() => regQuery(sub)).toThrow();
  },
);

win(
  "the cleanup helper deletes a file only if its hash still matches, after the process it waits for has exited",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fern-helper-test-"));
    try {
      const good = join(dir, "good.old-1");
      const changed = join(dir, "changed.old-2");
      await writeFile(good, "aside");
      await writeFile(changed, "aside");
      const sha = await sha256File(good);
      await writeFile(changed, "the user put something else here");

      // A short-lived process stands in for the uninstall process being waited for.
      const waiter = Bun.spawn({
        cmd: ["bun", "-e", "setTimeout(() => {}, 1500)"],
        stdout: "ignore",
        stderr: "ignore",
      });
      startDeleteHelper(
        [
          { path: good, sha256: sha },
          { path: changed, sha256: sha },
        ],
        [],
        waiter.pid,
      );
      // Nothing is deleted while the waited-for process is still alive.
      await Bun.sleep(300);
      expect(existsSync(good)).toBe(true);

      await waitFor(() => !existsSync(good));
      expect(existsSync(good)).toBe(false);
      expect(existsSync(changed)).toBe(true); // changed since: never deleted
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

win(
  "a running uninstall target: the other name of the hard-linked pair goes at once, the running one is renamed aside and a hash-checked helper removes it once the process exits, then the directories",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fern-winself-test-"));
    const f = fixture(root);
    let sleeper: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // A shipped-looking package whose exe is a real runnable program (a copy of bun).
      const pkg = join(root, "pkg");
      await mkdir(join(pkg, "onnxruntime-native", "win32-x64"), {
        recursive: true,
      });
      copyFileSync(process.execPath, join(pkg, "context-fern.exe"));
      await writeFile(
        join(
          pkg,
          "onnxruntime-native",
          "win32-x64",
          "onnxruntime_binding.node",
        ),
        "b",
      );
      await mkdir(f.home, { recursive: true });
      await runGlobalInit(
        { "no-plugin": "true" },
        initDeps(f, join(pkg, "context-fern.exe"), {
          platform: "win32",
          env: {
            FERN_INSTALL_PREFIX: f.prefix,
            PATH: "",
            LOCALAPPDATA: join(root, "local"),
          },
        }),
      );
      const layout = installLayout({
        platform: "win32",
        env: { FERN_INSTALL_PREFIX: f.prefix },
        home: f.home,
      });
      const running = join(layout.binDir, "context-fern.exe");
      const other = join(layout.binDir, "fern.exe");
      expect(existsSync(running) && existsSync(other)).toBe(true);

      // The installed copy is running (this stands in for the uninstall process itself).
      await writeFile(join(root, "sleep.js"), "setTimeout(() => {}, 120000)");
      sleeper = Bun.spawn({
        cmd: [running, "run", join(root, "sleep.js")],
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(800);

      const pid = sleeper.pid;
      const report = await runUninstall(
        { yes: "true" },
        uninstallDeps(f, {
          platform: "win32",
          env: {
            FERN_INSTALL_PREFIX: f.prefix,
            FERN_HOME: f.home,
            PATH: "",
            LOCALAPPDATA: join(root, "local"),
          },
          execPath: running,
          startHelper: (jobs, dirs) => startDeleteHelper(jobs, dirs, pid),
        }),
      );

      expect(report.scheduled).toEqual([running]);
      expect(existsSync(other)).toBe(false); // the other name was deleted while the image ran
      expect(existsSync(running)).toBe(false); // renamed aside
      const aside = (
        await Array.fromAsync(
          new Bun.Glob("context-fern.exe.old-*").scan({ cwd: layout.binDir }),
        )
      )[0];
      expect(aside).toBeDefined();
      // The manifest stays, listing the renamed file, until the helper has removed both.
      expect(existsSync(f.manifestPath)).toBe(true);
      expect(
        JSON.stringify((await readManifest(f.manifestPath))?.pendingDeletes),
      ).toContain("context-fern.exe.old-");
      expect(
        report.manual.some((c) => c.startsWith("Remove-Item -LiteralPath")),
      ).toBe(true);
      expect(report.exitCode).toBe(0);

      // Once the process is gone the helper removes the file, then the empty directories.
      sleeper.kill();
      await waitFor(() => !existsSync(layout.prefix));
      expect(existsSync(join(layout.binDir, aside as string))).toBe(false);
      expect(existsSync(layout.prefix)).toBe(false);
    } finally {
      sleeper?.kill();
      await Bun.sleep(300);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

win(
  "if the helper never runs, the manifest still lists the renamed exe, and running uninstall again (after the process has exited) finishes the job",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fern-winretry-test-"));
    const f = fixture(root);
    let sleeper: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const pkg = join(root, "pkg");
      await mkdir(join(pkg, "onnxruntime-native", "win32-x64"), {
        recursive: true,
      });
      copyFileSync(process.execPath, join(pkg, "context-fern.exe"));
      await writeFile(
        join(
          pkg,
          "onnxruntime-native",
          "win32-x64",
          "onnxruntime_binding.node",
        ),
        "b",
      );
      await mkdir(f.home, { recursive: true });
      const env = {
        FERN_INSTALL_PREFIX: f.prefix,
        PATH: "",
        LOCALAPPDATA: join(root, "local"),
      };
      await runGlobalInit(
        { "no-plugin": "true" },
        initDeps(f, join(pkg, "context-fern.exe"), { platform: "win32", env }),
      );
      const layout = installLayout({
        platform: "win32",
        env: { FERN_INSTALL_PREFIX: f.prefix },
        home: f.home,
      });
      const running = join(layout.binDir, "context-fern.exe");
      await writeFile(join(root, "sleep.js"), "setTimeout(() => {}, 120000)");
      sleeper = Bun.spawn({
        cmd: [running, "run", join(root, "sleep.js")],
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(800);

      // A helper that never runs (the terminal closed, the machine rebooted...).
      const first = await runUninstall(
        { yes: "true" },
        uninstallDeps(f, {
          platform: "win32",
          env: { ...env, FERN_HOME: f.home },
          execPath: running,
          startHelper: () => {},
        }),
      );
      expect(first.scheduled).toEqual([running]);
      expect(existsSync(f.manifestPath)).toBe(true);

      sleeper.kill();
      await Bun.sleep(1500);
      // Run again, as a user would after the first attempt.
      const second = await runUninstall(
        { yes: "true" },
        uninstallDeps(f, {
          platform: "win32",
          env: { ...env, FERN_HOME: f.home },
        }),
      );
      expect(second.exitCode).toBe(0);
      expect(existsSync(layout.prefix)).toBe(false);
    } finally {
      sleeper?.kill();
      await Bun.sleep(300);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

win(
  "the cleanup helper keeps retrying a file it cannot read yet (antivirus scanning a just-exited exe), instead of giving up after one pass",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fern-helper-lock-test-"));
    try {
      const file = join(dir, "context-fern.exe.old-1");
      await writeFile(file, "aside");
      const sha = await sha256File(file);

      // Another process holds the file with no sharing for a few seconds, so reading it fails.
      const holder = Bun.spawn({
        cmd: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$f = [IO.File]::Open($env:LOCKED, 'Open', 'Read', 'None'); Start-Sleep -Seconds 4; $f.Close()",
        ],
        env: { ...process.env, LOCKED: file },
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(2500); // let the holder start and take the lock
      expect(() => readFileSync(file)).toThrow(); // it really is locked

      const waiter = Bun.spawn({
        cmd: ["bun", "-e", "setTimeout(() => {}, 300)"],
        stdout: "ignore",
        stderr: "ignore",
      });
      startDeleteHelper([{ path: file, sha256: sha }], [], waiter.pid);

      // Released after ~1.5 s more; the helper must still be trying then.
      await waitFor(() => !existsSync(file), 40_000);
      expect(existsSync(file)).toBe(false);
      await holder.exited;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
