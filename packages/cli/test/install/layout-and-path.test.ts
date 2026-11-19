import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executableNames, installLayout } from "../../src/install/layout";
import {
  addToShellRc,
  addToWindowsUserPath,
  isOnPath,
  pathFixCommand,
  RC_BEGIN,
  RC_END,
  shellRcFile,
} from "../../src/install/path-setup";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fern-path-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("Windows layout lives under LOCALAPPDATA and uses .exe names", () => {
  const l = installLayout({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    home: "C:\\Users\\a",
  });
  expect(l.binDir).toBe(
    join("C:\\Users\\a\\AppData\\Local", "context-fern", "bin"),
  );
  expect(executableNames(l)).toEqual(["context-fern.exe", "fern.exe"]);
  expect(l.manifestPath).toBe(
    join(l.prefix, "share", "context-fern", "install-manifest.json"),
  );
});

test("macOS and Linux share one layout under ~/.local, with plain names", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const l = installLayout({ platform, env: {}, home: "/home/a" });
    expect(l.binDir).toBe(join("/home/a", ".local", "bin"));
    expect(l.shareDir).toBe(join("/home/a", ".local", "share", "context-fern"));
    expect(executableNames(l)).toEqual(["context-fern", "fern"]);
  }
});

test("FERN_INSTALL_PREFIX moves the whole layout", () => {
  const l = installLayout({
    platform: "linux",
    env: { FERN_INSTALL_PREFIX: "/opt/x" },
    home: "/home/a",
  });
  expect(l.binDir).toBe(join(resolve("/opt/x"), "bin"));
});

test("isOnPath ignores trailing separators, and case on Windows only", () => {
  expect(isOnPath("/a/b", { PATH: "/x:/a/b/:/y" }, "linux")).toBe(true);
  expect(isOnPath("/a/b", { PATH: "/x:/A/B" }, "linux")).toBe(false);
  expect(
    isOnPath("C:\\Fern\\bin", { Path: "C:\\x;c:\\fern\\BIN\\" }, "win32"),
  ).toBe(true);
  expect(isOnPath("/a/b", {}, "linux")).toBe(false);
});

test("shellRcFile picks the right startup file and refuses to guess for other shells", () => {
  expect(shellRcFile({ SHELL: "/bin/zsh" }, "/h", "darwin")?.file).toBe(
    join("/h", ".zshrc"),
  );
  expect(shellRcFile({ SHELL: "/bin/bash" }, "/h", "darwin")?.file).toBe(
    join("/h", ".bash_profile"),
  );
  expect(shellRcFile({ SHELL: "/bin/bash" }, "/h", "linux")?.file).toBe(
    join("/h", ".bashrc"),
  );
  expect(shellRcFile({ SHELL: "/usr/bin/fish" }, "/h", "linux")).toBeNull();
  expect(pathFixCommand("/p", "linux", { SHELL: "/usr/bin/fish" })).toContain(
    "fish_add_path",
  );
});

test("addToShellRc appends one marked block, keeps the user's lines, and is idempotent", async () => {
  const rc = join(dir, ".zshrc");
  await writeFile(rc, "alias a=b", "utf-8"); // no trailing newline on purpose
  const first = await addToShellRc(rc, "/p/bin");
  expect(first).toMatchObject({
    kind: "shell-rc",
    file: rc,
    beginMarker: RC_BEGIN,
    endMarker: RC_END,
  });
  // The user's own file is copied before it is touched, byte for byte.
  const backup = (first as { backupPath?: string }).backupPath as string;
  expect(await readFile(backup, "utf-8")).toBe("alias a=b");
  const text = await readFile(rc, "utf-8");
  expect(text.startsWith("alias a=b\n")).toBe(true);
  expect(text).toContain(`export PATH='/p/bin':"$PATH"`);
  expect(await addToShellRc(rc, "/p/bin")).toBe("already");
  expect((await readFile(rc, "utf-8")).split(RC_BEGIN).length).toBe(2);
});

// The Windows edit runs against a scratch registry key under HKCU, never
// the real user PATH.
const win = process.platform === "win32" ? test : test.skip;

function regQuery(subKey: string): string {
  return execFileSync("reg.exe", ["query", `HKCU\\${subKey}`, "/v", "Path"], {
    encoding: "utf-8",
  });
}

win(
  "Windows PATH edit keeps REG_EXPAND_SZ and %VAR% entries, appends once, and is idempotent",
  async () => {
    const sub = `Software\\ContextFernTest-${process.pid}-${Date.now()}`;
    execFileSync("reg.exe", [
      "add",
      `HKCU\\${sub}`,
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      "%USERPROFILE%\\bin;C:\\existing",
      "/f",
    ]);
    try {
      const target = "C:\\Users\\x\\AppData\\Local\\context-fern\\bin";
      const first = await addToWindowsUserPath(target, {
        registrySubKey: sub,
        broadcast: false,
      });
      expect(first).toEqual({
        kind: "windows-user-path",
        added: target,
        valueKind: "ExpandString",
      });
      const after = regQuery(sub);
      expect(after).toContain("REG_EXPAND_SZ");
      expect(after).toContain(`%USERPROFILE%\\bin;C:\\existing;${target}`);
      expect(
        await addToWindowsUserPath(target, {
          registrySubKey: sub,
          broadcast: false,
        }),
      ).toBe("already");
      expect(regQuery(sub).split(target).length).toBe(2);
    } finally {
      execFileSync("reg.exe", ["delete", `HKCU\\${sub}`, "/f"]);
    }
  },
);

win("Windows PATH edit works when the value does not exist yet", async () => {
  const sub = `Software\\ContextFernTest-${process.pid}-${Date.now()}-b`;
  try {
    const r = await addToWindowsUserPath("C:\\fern\\bin", {
      registrySubKey: sub,
      broadcast: false,
    });
    expect(r).not.toBe("already");
    expect(regQuery(sub)).toContain("C:\\fern\\bin");
  } finally {
    execFileSync("reg.exe", ["delete", `HKCU\\${sub}`, "/f"]);
  }
});
