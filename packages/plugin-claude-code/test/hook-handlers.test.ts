// Note: deliberately does NOT exercise the real "no daemon running
// yet" branch of SessionStart (which calls the real, un-injectable
// spawnDaemonDetached()) — doing so for real would spawn an actual bun
// process bound to the fixed default port, racing whatever else might
// be listening there. That spawn path already gets a real,
// process-level exercise in packages/cli/test/e2e.test.ts.
// UserPromptSubmit's own "/fern ..." down-daemon branch IS exercised
// below, safely, via handleUserPromptSubmit's injectable
// spawnDaemonDetached dependency — see its own test for why that
// makes it safe where SessionStart's isn't (yet) injectable the same
// way.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllProjects,
  type DaemonHandle,
  getOrOpenProject,
  startDaemon,
} from "@context-fern/daemon";
import { FakeEmbedder } from "@context-fern/embed";
import {
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
} from "../src/hook-handlers";

// Fixture payloads built from the real field names and structure of each
// hook's stdin, confirmed via a live `claude --debug` run on 2.1.312 —
// every value in them (paths, ids, prompt text, ...) is a hand-authored
// synthetic placeholder, never captured transcript content (CLAUDE.md's
// privacy rule: fixtures must be synthetic). The old version of this
// file passed every test while hand-rolling `user_input: {type, text}`
// for UserPromptSubmit, which is not the real field (the real field is
// a flat `prompt` string) — a hand-rolled object can silently encode the
// same wrong assumption the production code makes. Loading the confirmed
// real shape here means a future schema drift fails a test instead of
// passing one silently.
// biome-ignore lint/suspicious/noExplicitAny: JSON.parse's return type; spreading it into each test's input literal deliberately bypasses excess-property checks, since the real payload carries fields (transcript_path, scratchpad_dir, prompt_id, permission_mode, effort, ...) the handler types don't declare but real Claude Code sends.
function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", name), "utf-8"),
  );
}

let fakeHome: string;
let originalFernHome: string | undefined;
let daemon: DaemonHandle | undefined;
let projectDir: string;

beforeEach(async () => {
  originalFernHome = process.env.FERN_HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "fern-home-"));
  process.env.FERN_HOME = fakeHome;
  await closeAllProjects();
  daemon = await startDaemon({ embedder: new FakeEmbedder(), firstPort: 0 });
  projectDir = await mkdtemp(join(tmpdir(), "fern-proj-"));
  await mkdir(join(projectDir, ".fern"), { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (originalFernHome === undefined) delete process.env.FERN_HOME;
  else process.env.FERN_HOME = originalFernHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  await closeAllProjects();
});

test("UserPromptSubmit no-ops entirely in a project with no .fern/ and no .git/ above it", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "fern-bare-"));
  await mkdir(join(bareDir, ".git"));
  try {
    const result = await handleUserPromptSubmit({
      ...loadFixture("user-prompt-submit.plain.json"),
      cwd: bareDir,
    });
    expect(result).toEqual({});
  } finally {
    await rm(bareDir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit no-ops when the daemon is down, even in an initialized project", async () => {
  await daemon?.stop();
  daemon = undefined;

  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
  });
  expect(result).toEqual({});
});

test("a missing/non-string prompt field is logged under FERN_DEBUG, never routed as an empty string", async () => {
  const fixture = loadFixture("user-prompt-submit.plain.json");
  delete fixture.prompt;
  const originalDebug = process.env.FERN_DEBUG;
  process.env.FERN_DEBUG = "1";
  try {
    const result = await handleUserPromptSubmit({
      ...fixture,
      cwd: projectDir,
    });
    expect(result).toEqual({});
    const log = await readFile(
      join(projectDir, ".fern", "hook-debug.log"),
      "utf-8",
    );
    expect(log).toContain("UserPromptSubmit:missing-prompt-field");
  } finally {
    if (originalDebug === undefined) delete process.env.FERN_DEBUG;
    else process.env.FERN_DEBUG = originalDebug;
  }
});

test("a plain prompt against a running daemon never sets 'decision' and carries a non-empty focusNote", async () => {
  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
  });
  expect(result.decision).toBeUndefined();
  const hookSpecific = result.hookSpecificOutput as
    | { hookEventName: string; additionalContext: string }
    | undefined;
  expect(hookSpecific?.hookEventName).toBe("UserPromptSubmit");
  expect(typeof hookSpecific?.additionalContext).toBe("string");
  if (result.systemMessage !== undefined) {
    expect(result.systemMessage as string).toStartWith("fern ▸ ");
  }
});

test("'/fern new docker-build' blocks with zero model turns and never carries additionalContext", async () => {
  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new docker-build",
  });
  expect(result.decision).toBe("block");
  expect(result.reason as string).toContain("docker-build");
  expect(result.hookSpecificOutput).toBeUndefined();
});

test("'/fern status' blocks with a receipt as the reason", async () => {
  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
  });
  expect(result.decision).toBe("block");
  expect(result.reason as string).toStartWith("fern ▸ ");
});

test("an unrecognized /fern subcommand still blocks, with a usage message", async () => {
  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern frobnicate",
  });
  expect(result.decision).toBe("block");
  expect(result.reason as string).toContain("usage");
});

test("'/fern status' with a faked stale/dead daemon.json and an injected stub spawn always replies with a block, never throws — no real port, no real daemon spawn", async () => {
  // Overwrite daemon.json with the exact combination from the real
  // dogfood incident (a stale buildId, a dead pid) — see
  // docs/decisions.md. The pre-existing real daemon from beforeEach
  // keeps running on its own (random) port regardless, untouched; this
  // only swaps out what daemon.json *says*. spawnDaemonDetached is
  // stubbed to a no-op via dependency injection specifically so this
  // test can assert the reply without ever binding the real, fixed
  // daemon port — unlike every other test in this file, which avoids
  // this scenario entirely for exactly that reason.
  const { writeDaemonInfo } = await import("@context-fern/daemon");
  await writeDaemonInfo({
    port: 1,
    pid: 999999,
    token: "x",
    startedAt: new Date().toISOString(),
    buildId: "stale-build-id",
  });

  let spawnCalled = false;
  const result = await handleUserPromptSubmit(
    {
      ...loadFixture("user-prompt-submit.fern-command.json"),
      cwd: projectDir,
      prompt: "/fern status",
    },
    {
      spawnDaemonDetached: () => {
        spawnCalled = true;
      },
    },
  );

  expect(result.decision).toBe("block");
  // isDaemonStale() sees the mismatched buildId regardless of
  // aliveness, so this is the "updated", not "starting", message.
  expect(result.reason).toBe("fern ▸ daemon updated · try again");
  expect(spawnCalled).toBe(true);
});

test("'/fern brief' blocks with a redirect to the plain-English phrasing, not a usage error", async () => {
  const result = await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern brief",
  });
  expect(result.decision).toBe("block");
  expect(result.reason as string).toContain("update the fern brief");
  expect(result.reason as string).not.toContain("usage");
});

test("'/fern init' works even in an uninitialized project and creates .fern/config.toml", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "fern-bare-"));
  await mkdir(join(bareDir, ".git"));
  try {
    const result = await handleUserPromptSubmit({
      ...loadFixture("user-prompt-submit.fern-command.json"),
      cwd: bareDir,
      prompt: "/fern init",
    });
    expect(result.decision).toBe("block");
    const configText = await readFile(
      join(bareDir, ".fern", "config.toml"),
      "utf-8",
    );
    expect(configText).toContain("[thresholds]");
  } finally {
    await rm(bareDir, { recursive: true, force: true });
  }
});

test("the UserPromptSubmit -> PostToolUse -> Stop lifecycle records a leaflet with the touched file, relativized", async () => {
  await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "fix the login bug",
  });

  await handlePostToolUse({
    ...loadFixture("post-tool-use.read.json"),
    cwd: projectDir,
    tool_name: "Write",
    tool_input: {
      file_path: join(projectDir, "src", "login.ts"),
      content: "x",
    },
  });

  await handleStop({
    ...loadFixture("stop.json"),
    cwd: projectDir,
    last_assistant_message: "Fixed it.",
  });

  const state = await getOrOpenProject(projectDir);
  const row = state.store.db
    .query("SELECT files_touched FROM leaflets ORDER BY idx DESC LIMIT 1")
    .get() as { files_touched: string };
  const filesTouched = JSON.parse(row.files_touched) as {
    path: string;
    source: string;
  }[];
  expect(filesTouched).toEqual([
    { path: "src/login.ts", source: "tool_input" },
  ]);
});

test("Stop is a silent no-op when nothing is pending", async () => {
  const result = await handleStop({
    ...loadFixture("stop.json"),
    cwd: projectDir,
    last_assistant_message: "done",
  });
  expect(result).toEqual({});
});

test("PostToolUse ignores tools with no extractable path (e.g. Glob)", async () => {
  const result = await handlePostToolUse({
    ...loadFixture("post-tool-use.read.json"),
    cwd: projectDir,
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts" },
  });
  expect(result).toEqual({});
});

test("SessionStart on startup is a no-op when a daemon is already running", async () => {
  const result = await handleSessionStart({
    ...loadFixture("session-start.startup.json"),
    cwd: projectDir,
  });
  expect(result).toEqual({});
});

test("SessionStart on resume injects the active frond's brief when one exists", async () => {
  await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new docker-build",
  });

  const state = await getOrOpenProject(projectDir);
  const fronds = await state.store.listFronds(state.sessionId);
  const frond = fronds.find((f) => f.name === "docker-build");
  if (!frond) throw new Error("frond not created");
  const { writeBriefSections } = await import("@context-fern/store");
  await writeBriefSections(frond.briefPath, { Goal: "Get CI green again." });

  const result = await handleSessionStart({
    ...loadFixture("session-start.startup.json"),
    cwd: projectDir,
    source: "resume",
  });
  const hookSpecific = result.hookSpecificOutput as
    | { hookEventName: string; additionalContext: string }
    | undefined;
  expect(hookSpecific?.hookEventName).toBe("SessionStart");
  expect(hookSpecific?.additionalContext).toContain("Get CI green again.");
  expect(hookSpecific?.additionalContext).toContain(
    "brief: .fern/fronds/docker-build.md",
  );
  // The visible receipt — additionalContext alone is model-only and
  // never shown in the transcript UI, which is why restore read as
  // silently doing nothing even when it worked (see docs/decisions.md).
  expect(result.systemMessage).toContain("restored docker-build");
  expect(result.systemMessage).toContain("brief");
});

test("SessionStart on resume still names the frond and brief path even when the brief's sections are all empty", async () => {
  await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.fern-command.json"),
    cwd: projectDir,
    prompt: "/fern new docker-build",
  });

  const result = await handleSessionStart({
    ...loadFixture("session-start.startup.json"),
    cwd: projectDir,
    source: "resume",
  });
  const hookSpecific = result.hookSpecificOutput as
    | { hookEventName: string; additionalContext: string }
    | undefined;
  expect(hookSpecific?.additionalContext).toContain(
    "Active frond: docker-build",
  );
  expect(hookSpecific?.additionalContext).toContain(
    "brief: .fern/fronds/docker-build.md",
  );
  expect(result.systemMessage).toContain("restored docker-build");
});

test("SessionStart on resume shows a visible restore receipt for the stem too, with no frond ever created — the common case", async () => {
  await handleUserPromptSubmit({
    ...loadFixture("user-prompt-submit.plain.json"),
    cwd: projectDir,
    prompt: "fix the typo in the readme",
  });

  const result = await handleSessionStart({
    ...loadFixture("session-start.startup.json"),
    cwd: projectDir,
    source: "resume",
  });
  const hookSpecific = result.hookSpecificOutput as
    | { hookEventName: string; additionalContext: string }
    | undefined;
  expect(hookSpecific?.additionalContext).toContain("Active frond: stem");
  expect(hookSpecific?.additionalContext).toContain(
    "brief: .fern/fronds/stem.md",
  );
  expect(result.systemMessage).toBe("fern ▸ restored stem · brief");
});

test("SessionStart no-ops entirely in an uninitialized project", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "fern-bare-"));
  await mkdir(join(bareDir, ".git"));
  try {
    const result = await handleSessionStart({
      ...loadFixture("session-start.startup.json"),
      cwd: bareDir,
      source: "resume",
    });
    expect(result).toEqual({});
  } finally {
    await rm(bareDir, { recursive: true, force: true });
  }
});
