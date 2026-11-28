// The registry-e2e workflow installs from the real registries and must never
// be able to publish, read a secret, or run on anything but a manual dispatch.
// This pins that, so a later edit cannot quietly widen it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) =>
  readFileSync(join(import.meta.dir, "../.github/workflows", f), "utf-8");
const yml = read("registry-e2e.yml");
// the workflows that already use actions the repository allows
const existing = `${read("release.yml")}
${read("ci.yml")}`;

// the commands and settings that could publish, authenticate or write
const FORBIDDEN = [
  "write-all",
  ": write",
  "secrets: inherit",
  "curl",
  "wget",
  "npm publish",
  "uv publish",
  "twine",
  "npm dist-tag",
  "dist-tag add",
  "npm login",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "gh release",
  "gh api",
  "gh attestation",
  "git push",
  "id-token",
  "secrets.",
  "vars.",
  "environment:",
  "workflow_call",
  "pull_request",
  "schedule:",
  "workflow_run",
  "push:",
];

const D = "$"; // keeps the expression syntax out of lint's template-string check

function jobsSection(): string {
  return yml.slice(yml.indexOf("\njobs:\n"));
}

test("it runs only when started by hand", () => {
  const on = yml.slice(yml.indexOf("\non:\n"), yml.indexOf("\npermissions:"));
  expect(on).toContain("workflow_dispatch:");
  expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
});

test("it cannot publish, authenticate or read a secret", () => {
  // comments may name the things it does not do; the code may not
  const code = yml
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  for (const bad of FORBIDDEN) expect(code).not.toContain(bad);
});

test("the token is read-only everywhere: contents: read and nothing else", () => {
  // every occurrence, whatever its form: "permissions:" alone on its line
  // (a block follows), never an inline value such as write-all
  const all = yml
    .split("\n")
    .filter((l) => l.trim().startsWith("permissions:"));
  expect(all.length).toBe(3); // the workflow and both jobs
  for (const l of all) expect(l.trim()).toBe("permissions:");
  const blocks = [...yml.matchAll(/^( *)permissions:\n((?:\1 +.+\n)+)/gm)];
  expect(blocks.length).toBe(3);
  for (const [, , body] of blocks)
    expect(
      body
        ?.trim()
        .split("\n")
        .map((l) => l.trim()),
    ).toEqual(["contents: read"]);
  expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
});

test("it uses only actions the other workflows already use, pinned to the same commits", () => {
  const uses = (t: string) =>
    new Set([...t.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((m) => m[1]));
  const mine = uses(yml);
  expect(mine.size).toBeGreaterThan(0);
  const allowed = uses(existing);
  for (const u of mine) expect(allowed.has(u)).toBe(true);
  // and nothing is referenced by a tag or a branch
  expect(
    [...yml.matchAll(/uses: (\S+)/g)].every((m) =>
      /@[0-9a-f]{40}$/.test(m[1] ?? ""),
    ),
  ).toBe(true);
});

test("the input reaches a script only through the environment, never the shell text", () => {
  // the only places the input appears: the env line that hands it to a script
  // and the TestPyPI job's condition (a comparison, never run as text)
  const allowed = new Set([
    `SPEC: ${D}{{ inputs.spec }}`,
    `if: ${D}{{ inputs.spec == 'rc' || contains(inputs.spec, '-rc.') }}`,
  ]);
  for (const line of yml.split("\n")) {
    if (!line.includes("inputs.")) continue;
    expect(allowed.has(line.trim())).toBe(true);
  }
  // no run: step (a one-liner or a block, to its last indented line) holds an expression
  const lines = yml.split("\n");
  let runBlocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)(?:- )?run:/.exec(lines[i] ?? "");
    if (!m) continue;
    runBlocks++;
    const indent = (m[1] ?? "").length;
    let block = lines[i] ?? "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      block += `\n${l}`;
    }
    expect(block).not.toContain(`${D}{{`);
  }
  expect(runBlocks).toBe(2);
});

test("the npm job covers all four launch platforms and the TestPyPI job covers Linux and Windows", () => {
  const jobs = jobsSection();
  const npm = jobs.slice(
    jobs.indexOf("\n  npm:"),
    jobs.indexOf("\n  testpypi:"),
  );
  for (const os of [
    "windows-latest",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
    "macos-latest",
  ])
    expect(npm).toContain(os);
  expect(npm).toContain("scripts/registry-e2e.ts");
  const pypi = jobs.slice(jobs.indexOf("\n  testpypi:"));
  expect(pypi).toContain("os: [ubuntu-24.04, windows-latest]");
  expect(pypi).toContain("https://test.pypi.org/simple/");
  expect(pypi).toContain("https://pypi.org/simple/");
  expect(pypi).toContain("--index-strategy unsafe-best-match");
  expect(pypi).toContain("uvx");
});

test("the script that runs on the runner is dependency-free and publishes nothing", () => {
  const script = readFileSync(
    join(import.meta.dir, "../scripts/registry-e2e.ts"),
    "utf-8",
  );
  const imports = [...script.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const i of imports) expect(i?.startsWith("node:")).toBe(true);
  const code = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const bad of ["npm publish", "npm dist-tag", "uv publish", "twine"])
    expect(code).not.toContain(bad);
  // the input is checked before it is used
  expect(script).toContain("A-Za-z0-9");
});
