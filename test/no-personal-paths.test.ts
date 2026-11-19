// No machine-specific personal string in anything that ships or runs in CI: the
// maintainer's Windows user directory, its 8.3 short form, a project folder
// named after them, or an email address. The one deliberate appearance of a
// personal account name is REPO_OWNER in packages/core/src/brand.ts (a GitHub
// slug, stamped into package metadata from there). The docs are not scanned:
// docs/decisions.md is a history and is reported on separately.
//
// The forbidden strings are assembled from parts so this file does not itself
// contain them.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));
const part = (...bits: string[]) => bits.join("");
const first = part("Pratya", "ksh");
const FORBIDDEN: [string, RegExp][] = [
  ["a Windows user directory", new RegExp(`${first} ${part("So", "ni")}`, "i")],
  [
    "its 8.3 short name",
    new RegExp(`${first.slice(0, 6).toUpperCase()}~1`, "i"),
  ],
  [
    "a project folder named after the maintainer",
    new RegExp(`${first} ${part("Pers", "onal")}`, "i"),
  ],
  [
    "a Users directory named after the maintainer",
    new RegExp(`Users[\\\\/]${first}`, "i"),
  ],
  ["a gmail address", /[A-Za-z0-9._%+-]+@gmail\.com/i],
];
const SCANNED = [
  "packages",
  "scripts",
  "test",
  "bench",
  "e2e",
  "packaging",
  ".github",
];
const BINARY =
  /\.(png|jpg|jpeg|gif|ico|woff2?|onnx|node|dylib|so|dll|exe|zip|gz|tgz|whl|pdf)$/i;
const SELF = "test/no-personal-paths.test.ts";

test("no tracked source, test, script or workflow file contains the maintainer's machine-specific names or an email address", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter((f) => f && f !== SELF && !BINARY.test(f));
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf-8");
    } catch {
      continue; // a tracked file removed in the working tree
    }
    for (const [what, re] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) hits.push(`${f}: ${what}`);
    }
  }
  expect(hits).toEqual([]);
});
