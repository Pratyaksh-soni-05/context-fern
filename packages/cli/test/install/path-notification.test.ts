// The PATH edit and the PATH removal tell other windows about the change
// (WM_SETTINGCHANGE) after the registry value is written. If only that
// notification fails or times out, the edit is still a success and the user
// gets one plain note; if the registry value cannot be written, it stays a
// failure. docs/decisions.md, 2026-11-21.
//
// Everything that touches the registry uses a scratch key under HKCU, never
// the real user PATH, and a stubbed notification failure, never a real one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGlobalInit } from "../../src/install/global-init";
import { installLayout } from "../../src/install/layout";
import {
  type InstallManifest,
  writeManifest,
} from "../../src/install/manifest";
import {
  addToWindowsUserPath,
  PATH_NOTIFICATION_NOTE,
  readWindowsPathOutput,
  settleWindowsPathAdd,
  WINDOWS_PATH_SCRIPT,
} from "../../src/install/path-setup";
import { runUninstall } from "../../src/install/uninstall";
import {
  removeFromWindowsUserPath,
  settleWindowsPathRemove,
  WINDOWS_PATH_REMOVE_SCRIPT,
} from "../../src/install/uninstall-path";
import { fixture, initDeps, uninstallDeps } from "./stub-helpers";

/** Real powershell.exe, a scratch registry key; 60 s because a stalled runner can take over bun's default 5 s to start it. */
const win = (name: string, fn: () => Promise<void>) =>
  (process.platform === "win32" ? test : test.skip)(name, fn, 60_000);

// ---- what the script printed, on every platform --------------------------

test("a script that ran to its end: written, finished, and the notification outcome is the last field", () => {
  const sent = readWindowsPathOutput(
    "written|ExpandString\r\nadded|ExpandString|sent\r\n",
    "added",
  );
  expect(sent).toEqual({
    written: true,
    valueKind: "ExpandString",
    finished: true,
    notificationFailed: false,
  });
  expect(
    readWindowsPathOutput("written|String\nadded|String|skipped\n", "added")
      .notificationFailed,
  ).toBe(false);
  expect(
    readWindowsPathOutput("written|String\nadded|String|failed\n", "added"),
  ).toEqual({
    written: true,
    valueKind: "String",
    finished: true,
    notificationFailed: true,
  });
  expect(
    readWindowsPathOutput("written|String\nremoved|String|failed\n", "removed")
      .notificationFailed,
  ).toBe(true);
});

test("a process killed after the value was written (a time-out) is still a written value, with the notification in doubt", () => {
  const killed = readWindowsPathOutput("written|ExpandString\r\n", "added");
  expect(killed).toEqual({
    written: true,
    valueKind: "ExpandString",
    finished: false,
    notificationFailed: true,
  });
});

test("nothing written is not a success: no output, a crash before the write, or an already-present entry", () => {
  for (const stdout of ["", "\r\n", "already|ExpandString\r\n", "absent\n"]) {
    expect(readWindowsPathOutput(stdout, "added").written, stdout).toBe(false);
    expect(
      readWindowsPathOutput(stdout, "removed").notificationFailed,
      stdout,
    ).toBe(false);
  }
});

// What the child's end means, with the error the process reported (killed at
// the time limit, a non-zero exit) separate from what it printed.

const KILLED = Object.assign(new Error("Command failed: powershell.exe"), {
  killed: true,
  signal: "SIGTERM",
});
const DIR = "C:\\fern\\bin";

test("add: a process killed after the value was written is a success with the notification in doubt, whatever the error says", () => {
  const settled = settleWindowsPathAdd(
    KILLED,
    "written|ExpandString\r\n",
    "",
    DIR,
  );
  expect(settled).toEqual({
    result: {
      kind: "windows-user-path",
      added: DIR,
      valueKind: "ExpandString",
    },
    notificationFailed: true,
  });
});

test("add: an error with nothing written is a failure that carries the script's own message", () => {
  expect(() =>
    settleWindowsPathAdd(
      KILLED,
      "",
      "Access to the registry key is denied.",
      DIR,
    ),
  ).toThrow("Access to the registry key is denied.");
  expect(() => settleWindowsPathAdd(KILLED, "", "", DIR)).toThrow(
    "Command failed",
  );
});

test("add: the already-present entry and a script that printed nothing", () => {
  expect(
    settleWindowsPathAdd(null, "already|ExpandString\r\n", "", DIR),
  ).toEqual({ result: "already", notificationFailed: false });
  expect(() => settleWindowsPathAdd(null, "", "", DIR)).toThrow(
    "printed nothing it should have",
  );
});

test("add: a clean run reports no notification failure, a run whose last line says failed does", () => {
  const clean = settleWindowsPathAdd(
    null,
    "written|String\nadded|String|sent\n",
    "",
    DIR,
  );
  expect(clean.notificationFailed).toBe(false);
  const failed = settleWindowsPathAdd(
    null,
    "written|String\nadded|String|failed\n",
    "",
    DIR,
  );
  expect(failed.notificationFailed).toBe(true);
  expect(failed.result).not.toBe("already");
});

test("remove: a process killed after the value was written is a success with the notification in doubt", () => {
  expect(
    settleWindowsPathRemove(KILLED, "written|ExpandString\r\n", ""),
  ).toEqual({ result: "removed", notificationFailed: true });
});

test("remove: an error with nothing written is a failure; no error and nothing written is 'absent'", () => {
  expect(() => settleWindowsPathRemove(KILLED, "", "key is denied")).toThrow(
    "key is denied",
  );
  expect(settleWindowsPathRemove(null, "absent\r\n", "")).toEqual({
    result: "absent",
    notificationFailed: false,
  });
  expect(settleWindowsPathRemove(null, "", "")).toEqual({
    result: "absent",
    notificationFailed: false,
  });
});

test("both scripts announce the written value before they try to notify, and the notification is inside a try", () => {
  for (const script of [WINDOWS_PATH_SCRIPT, WINDOWS_PATH_REMOVE_SCRIPT]) {
    const written = script.indexOf('Write-Output "written|');
    const tryAt = script.indexOf("try {");
    const addType = script.indexOf("Add-Type");
    const send = script.indexOf("::SendMessageTimeout(");
    expect(written).toBeGreaterThan(0);
    expect(tryAt).toBeGreaterThan(written);
    expect(addType).toBeGreaterThan(tryAt);
    expect(send).toBeGreaterThan(addType);
    expect(script).toContain("} catch { }");
    // the registry write itself is not inside the try
    expect(script.indexOf("SetValue")).toBeLessThan(written);
  }
});

test("the note is one plain sentence that says the PATH was updated", () => {
  expect(PATH_NOTIFICATION_NOTE).toBe(
    "PATH was updated; other open windows may not see it until a new terminal is opened",
  );
});

// ---- the real scripts, on a scratch key ----------------------------------

function regQuery(subKey: string): string {
  return execFileSync("reg.exe", ["query", `HKCU\\${subKey}`, "/v", "Path"], {
    encoding: "utf-8",
  });
}
function regDelete(subKey: string): void {
  try {
    execFileSync("reg.exe", ["delete", `HKCU\\${subKey}`, "/f"]);
  } catch {
    // never created
  }
}
function regAdd(subKey: string, value: string): void {
  execFileSync("reg.exe", [
    "add",
    `HKCU\\${subKey}`,
    "/v",
    "Path",
    "/t",
    "REG_EXPAND_SZ",
    "/d",
    value,
    "/f",
  ]);
}

let sub: string;
beforeEach(() => {
  sub = `Software\\ContextFernTest-${process.pid}-${Date.now()}`;
});
afterEach(() => regDelete(sub));

const TARGET = "C:\\fern-notify-test\\bin";

win(
  "add: a failed notification still succeeds, the value is written, and the callback is told once",
  async () => {
    regAdd(sub, "C:\\existing");
    let told = 0;
    const r = await addToWindowsUserPath(TARGET, {
      registrySubKey: sub,
      broadcastStub: "fail",
      onNotificationFailed: () => {
        told++;
      },
    });
    expect(r).toEqual({
      kind: "windows-user-path",
      added: TARGET,
      valueKind: "ExpandString",
    });
    expect(told).toBe(1);
    expect(regQuery(sub)).toContain(`C:\\existing;${TARGET}`);
  },
);

win(
  "add: with the notification switched off nothing is reported failed",
  async () => {
    let told = 0;
    const r = await addToWindowsUserPath(TARGET, {
      registrySubKey: sub,
      broadcast: false,
      onNotificationFailed: () => {
        told++;
      },
    });
    expect(r).not.toBe("already");
    expect(told).toBe(0);
  },
);

win(
  "add: an entry that is already there is 'already', with no note",
  async () => {
    regAdd(sub, TARGET);
    let told = 0;
    const r = await addToWindowsUserPath(TARGET, {
      registrySubKey: sub,
      broadcastStub: "fail",
      onNotificationFailed: () => {
        told++;
      },
    });
    expect(r).toBe("already");
    expect(told).toBe(0);
  },
);

win(
  "remove: a failed notification still succeeds, the entry is gone, and the callback is told once",
  async () => {
    regAdd(sub, `C:\\keep;${TARGET}`);
    let told = 0;
    const r = await removeFromWindowsUserPath(TARGET, {
      registrySubKey: sub,
      broadcastStub: "fail",
      onNotificationFailed: () => {
        told++;
      },
    });
    expect(r).toBe("removed");
    expect(told).toBe(1);
    const after = regQuery(sub);
    expect(after).toContain("C:\\keep");
    expect(after).not.toContain(TARGET);
  },
);

win(
  "remove: an entry that is not there is 'absent', with no note",
  async () => {
    regAdd(sub, "C:\\keep");
    let told = 0;
    const r = await removeFromWindowsUserPath(TARGET, {
      registrySubKey: sub,
      broadcastStub: "fail",
      onNotificationFailed: () => {
        told++;
      },
    });
    expect(r).toBe("absent");
    expect(told).toBe(0);
  },
);

win(
  "a registry value that cannot be written stays a failure, with no note and nothing created",
  async () => {
    // A key name over 255 characters is refused by the registry before anything is written.
    const tooLong = `${sub}\\${"a".repeat(300)}`;
    let told = 0;
    await expect(
      addToWindowsUserPath(TARGET, {
        registrySubKey: tooLong,
        broadcastStub: "fail",
        onNotificationFailed: () => {
          told++;
        },
      }),
    ).rejects.toThrow();
    await expect(
      removeFromWindowsUserPath(TARGET, {
        registrySubKey: tooLong,
        broadcastStub: "fail",
        onNotificationFailed: () => {
          told++;
        },
      }),
    ).rejects.toThrow();
    expect(told).toBe(0);
    expect(() => regQuery(sub)).toThrow();
  },
);

// ---- what the user sees, with the registry functions stubbed -------------

test("uninstall: when only the notification failed, the PATH entry counts as removed and the note is shown", async () => {
  const root = await mkdtemp(join(tmpdir(), "fern-pathnote-"));
  try {
    const f = fixture(root);
    await mkdir(join(f.prefix, "share", "context-fern"), { recursive: true });
    const manifest: InstallManifest = {
      schema: 1,
      version: "0.1.0",
      installedAt: "t",
      platform: "win32-x64",
      prefix: f.prefix,
      binDir: join(f.prefix, "bin"),
      shareDir: join(f.prefix, "share", "context-fern"),
      files: [],
      pathEdit: {
        kind: "windows-user-path",
        added: join(f.prefix, "bin"),
        valueKind: "ExpandString",
      },
      plugin: null,
    };
    await writeManifest(f.manifestPath, manifest);

    const r = await runUninstall(
      { yes: "true" },
      uninstallDeps(f, {
        removeWindowsPath: async (_dir, opts) => {
          opts?.onNotificationFailed?.();
          return "removed";
        },
      }),
    );

    expect(r.exitCode).toBe(0);
    expect(r.removed).toContain(`${join(f.prefix, "bin")} from the user PATH`);
    const said = f.logs.join("\n");
    expect(said).toContain("from your user PATH");
    expect(said).toContain(PATH_NOTIFICATION_NOTE);
    expect(said.split(PATH_NOTIFICATION_NOTE).length).toBe(2); // once
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

win(
  "init: when only the notification failed, the PATH edit is recorded and the note is shown once",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fern-pathnote-init-"));
    try {
      const f = fixture(root);
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
        { "no-plugin": "true", "add-to-path": "true" },
        initDeps(f, join(pkg, "context-fern.exe"), {
          platform: "win32",
          env,
          addToWindowsPath: async (dir, opts) => {
            opts?.onNotificationFailed?.();
            return {
              kind: "windows-user-path",
              added: dir,
              valueKind: "ExpandString",
            };
          },
        }),
      );
      const layout = installLayout({
        platform: "win32",
        env: { FERN_INSTALL_PREFIX: f.prefix },
        home: f.home,
      });
      const said = f.logs.join("\n");
      expect(said).toContain(`added ${layout.binDir} to your user PATH`);
      expect(said.split(PATH_NOTIFICATION_NOTE).length).toBe(2); // once
      const manifest = await Bun.file(f.manifestPath).json();
      expect(manifest.pathEdit).toEqual({
        kind: "windows-user-path",
        added: layout.binDir,
        valueKind: "ExpandString",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
