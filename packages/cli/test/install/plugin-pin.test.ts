// The plugin marketplace is added from this binary's release tag, not from
// the default git branch: the hooks it installs run on every prompt, so they must
// be the ones released with the binary that installed them.

import { expect, test } from "bun:test";
import { CLI_VERSION, REPO_OWNER } from "@context-fern/core";
import {
  type CommandRunner,
  MARKETPLACE_NAME,
  MARKETPLACE_REF,
  MARKETPLACE_SOURCE,
  manualPluginSteps,
  setUpPlugin,
} from "../../src/install/plugin-setup";

const PINNED = `${REPO_OWNER}/context-fern#v${CLI_VERSION}`;

test("the marketplace ref is exactly v + CLI_VERSION, so it cannot drift from the binary", () => {
  expect(MARKETPLACE_REF).toBe(`v${CLI_VERSION}`);
  expect(MARKETPLACE_SOURCE).toBe(PINNED);
  expect(MARKETPLACE_SOURCE.split("#")).toEqual([
    `${REPO_OWNER}/context-fern`,
    `v${CLI_VERSION}`,
  ]);
});

test("init adds the marketplace from the pinned source", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_c, args) => {
    calls.push(args);
    return { ok: true, output: args.includes("list") ? "[]" : "" };
  };
  const r = await setUpPlugin("claude", runner);
  expect(r.state).toBe("installed");
  expect(calls.find((a) => a.includes("add"))).toEqual([
    "plugin",
    "marketplace",
    "add",
    PINNED,
  ]);
  // The unpinned source is never what init passes.
  expect(calls.flat()).not.toContain(`${REPO_OWNER}/context-fern`);
});

test("the manual commands init prints use the same pinned source", async () => {
  expect(manualPluginSteps()[0]).toBe(
    `claude plugin marketplace add ${PINNED}`,
  );
  const r = await setUpPlugin(null);
  expect(r.state).toBe("manual");
  if (r.state === "manual") expect(r.steps[0]).toContain(`add ${PINNED}`);
});

test("a build whose tag is missing gets the failure and the pinned manual commands, never a silent fallback to the default git branch", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_c, args) => {
    calls.push(args);
    if (args.includes("add"))
      return { ok: false, output: "Remote branch v0.0.0-nope not found" };
    return { ok: true, output: "[]" };
  };
  const r = await setUpPlugin("claude", runner);
  expect(r.state).toBe("manual");
  if (r.state === "manual") {
    expect(r.reason).toContain("adding the marketplace failed");
    expect(r.steps[0]).toContain(`add ${PINNED}`);
  }
  // exactly one add, with the pinned source: no retry against the default git branch
  expect(calls.filter((a) => a.includes("add"))).toEqual([
    ["plugin", "marketplace", "add", PINNED],
  ]);
});

test("the manifest records the marketplace by name only, which is what uninstall removes", async () => {
  const runner: CommandRunner = async (_c, args) => ({
    ok: true,
    output: args.includes("list") ? "[]" : "",
  });
  const r = await setUpPlugin("claude", runner);
  if (r.state !== "installed") throw new Error("expected installed");
  expect(r.record.marketplace).toBe(MARKETPLACE_NAME);
  expect(JSON.stringify(r.record)).not.toContain("#");
});
