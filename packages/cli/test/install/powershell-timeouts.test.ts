// The installer's PowerShell child process must be allowed to run longer than
// the script's own bound on the WM_SETTINGCHANGE broadcast plus what the script
// does before it: starting powershell.exe and compiling the Add-Type shim. If it
// were not, a real user on a slow or cold machine could see init or uninstall
// fail with a timeout kill although the PATH value had already been written.
//
// Both numbers are literals in the source (the script text carries the
// broadcast bound, execFile carries the process timeout), so this reads them
// from the source and checks the relation on every platform.
// docs/decisions.md, 2026-11-20.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Measured here: powershell.exe starts in 0.3-0.4 s and the Add-Type compile takes about 0.6 s; a runner stalled ten times over still needs under 10 s. Twice that. */
const START_AND_COMPILE_ALLOWANCE_MS = 20_000;

const SOURCES = ["path-setup.ts", "uninstall-path.ts"];

function numbersIn(file: string): {
  processTimeout: number;
  broadcast: number;
} {
  const source = readFileSync(
    join(import.meta.dir, "../../src/install", file),
    "utf-8",
  );
  const processTimeout = /timeout:\s*([\d_]+),\s*windowsHide/.exec(source)?.[1];
  const sendArgs = /::SendMessageTimeout\(([^)]*)\)/.exec(source)?.[1];
  // hWnd, Msg, wParam, lParam, flags, timeout, result
  const broadcast = sendArgs?.split(",")[5]?.trim();
  expect(processTimeout, `${file}: the execFile timeout`).toBeDefined();
  expect(broadcast, `${file}: the SendMessageTimeout bound`).toMatch(/^\d+$/);
  return {
    processTimeout: Number((processTimeout ?? "").replaceAll("_", "")),
    broadcast: Number(broadcast),
  };
}

for (const file of SOURCES) {
  test(`${file}: the process timeout is longer than the 5 s broadcast bound plus a cold start and compile`, () => {
    const { processTimeout, broadcast } = numbersIn(file);
    expect(broadcast).toBe(5000);
    expect(processTimeout).toBeGreaterThanOrEqual(
      broadcast + START_AND_COMPILE_ALLOWANCE_MS,
    );
  });
}

test("the install and uninstall PATH scripts use the same bounds", () => {
  const [a, b] = SOURCES.map(numbersIn);
  expect(a).toEqual(b as { processTimeout: number; broadcast: number });
});
