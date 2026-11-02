// Exported handler functions behind the thin scripts/*.ts wrappers (see
// decisions.md's Phase-4 note: once a compiled fern binary exists, these
// can move behind `fern hook <event>` and end users won't need bun).
//
// Three of the four events here are passive taps — they must never make
// the user wait and never error into the session: isDaemonRunning() (no
// spawn) with a short internal timeout, swallow every failure, return
// {} (a legitimate no-op hook result) on anything that isn't a clean
// success. SessionStart's daemon-start is the one exception: it spawns
// detached and returns immediately, never polling.
//
// UserPromptSubmit's "/fern ..." interception is the other exception —
// it's a command the user typed, not a passive tap, so it's allowed to
// wait (ensureDaemonRunning, capped by hooks.json's own 5s timeout) and
// to block (spec §7's "never block" is about routing decisions on real
// prompts; see docs/decisions.md for why a command isn't one).
//
// Field names below are the REAL Claude Code hook I/O schema, captured
// from a live `claude --debug` run against this exact plugin on
// 2.1.312 (Windows) — not recalled from memory, and not the same as an
// earlier (wrong) pass at this file assumed. In particular,
// UserPromptSubmit's raw text is a flat `prompt` string field, not
// `user_input.text` — that earlier mistake is why block-path
// interception silently never fired: the hook always read an empty
// string and fell through to treating every input as a blank prompt.
// See docs/decisions.md for the dogfood incident this fixes.

import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLI_NAME } from "@context-fern/core";
import {
  findFernDir,
  isDaemonRunning,
  rawGetJson,
  rawPostJson,
  spawnDaemonDetached,
} from "@context-fern/daemon/client";
import { extractTouchedFiles } from "./extract-touched-files";
import { dispatchFernCommand } from "./fern-dispatch";

/** Internal budget for the passive, never-wait hooks — separate from hooks.json's 5s outer cap, which covers the /fern command path instead. */
const PASSIVE_TIMEOUT_MS = 300;

const ESCAPED_CLI_NAME = CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Matches both the bare form ("/fern ...") and the plugin-namespaced
// form Claude Code falls back to when no bare command is registered
// ("/fern:fern ..."). Either way this only recognizes the LITERAL
// prefix in the raw prompt text — see docs/decisions.md on why that's
// still within spec §7's "never block a real prompt".
const FERN_COMMAND_RE = new RegExp(
  `^\\/${ESCAPED_CLI_NAME}(?::${ESCAPED_CLI_NAME})?(?:\\s+(.*))?$`,
  "s",
);

/** `FERN_DEBUG=1` appends every hook's raw stdin to .fern/hook-debug.log — opt-in, since it's the project's own event stream, not something to leave on by default. */
async function debugLog(
  fernDir: string | null,
  event: string,
  raw: unknown,
): Promise<void> {
  if (process.env.FERN_DEBUG !== "1" || !fernDir) return;
  try {
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(raw)}\n`;
    await appendFile(join(fernDir, "hook-debug.log"), line, "utf-8");
  } catch {
    // never let debug logging itself break a hook
  }
}

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleUserPromptSubmit(
  input: UserPromptSubmitInput,
): Promise<Record<string, unknown>> {
  const fernDirForLog = findFernDir(input.cwd);
  await debugLog(fernDirForLog, "UserPromptSubmit", input);

  // Never silently treat a missing/wrong-shaped prompt field as an empty
  // string — that's exactly the shape of bug that made every prompt look
  // like "" (see docs/decisions.md). No-op instead, with its own clearly
  // labeled debug entry so a future schema change is loud, not silent.
  if (typeof input.prompt !== "string") {
    await debugLog(
      fernDirForLog,
      "UserPromptSubmit:missing-prompt-field",
      input,
    );
    return {};
  }

  const text = input.prompt;
  const trimmed = text.trim();

  const fernMatch = FERN_COMMAND_RE.exec(trimmed);
  if (fernMatch) {
    const rest = (fernMatch[1] ?? "").split(/\s+/).filter(Boolean);
    const fernDir = fernDirForLog;
    // "/fern init" is the one explicit user action allowed to create
    // .fern/ — every other command still no-ops in an uninitialized
    // project (CLAUDE.md: installing the plugin must never create it).
    if (!fernDir && rest[0] !== "init") return {};

    const projectPath = fernDir ? dirname(fernDir) : input.cwd;

    // Never let this hook itself wait for the daemon to start: it's a
    // real prompt the user is waiting on, and hooks.json's own 5s outer
    // timeout could fire before a cold embedder warm-up finishes —
    // which would make Claude Code treat this as a hook *failure*
    // rather than a block, letting the prompt fall through to Claude
    // Code's own "Unknown command" rejection instead of being blocked.
    // Spawn (fire-and-forget) and reply immediately if it's not already
    // up; dispatchFernCommand only ever runs once it's confirmed running.
    // Bounded like every other isDaemonRunning() call in this file — an
    // unresponsive-but-alive daemon must not be able to stall this check
    // toward hooks.json's own 5s outer timeout, which is exactly the
    // failure mode this whole branch exists to avoid.
    const daemonInfo = await isDaemonRunning(
      AbortSignal.timeout(PASSIVE_TIMEOUT_MS),
    );
    if (!daemonInfo) {
      spawnDaemonDetached();
      return {
        decision: "block",
        reason: `${CLI_NAME} ▸ daemon starting · try again in a moment`,
      };
    }

    try {
      const reason = await dispatchFernCommand({
        projectPath,
        rest,
        ensureDaemon: true,
      });
      return { decision: "block", reason };
    } catch (err) {
      return {
        decision: "block",
        reason: `${CLI_NAME} ▸ error: ${errorText(err)}`,
      };
    }
  }

  const fernDir = fernDirForLog;
  if (!fernDir) return {};
  const projectPath = dirname(fernDir);

  const info = await isDaemonRunning(AbortSignal.timeout(PASSIVE_TIMEOUT_MS));
  if (!info) return {};

  try {
    const result = await rawPostJson(
      info,
      "/prompt",
      { projectPath, prompt: text, agentSessionId: input.session_id },
      AbortSignal.timeout(PASSIVE_TIMEOUT_MS),
    );
    const output: Record<string, unknown> = {};
    // Quiet by default: a plain continue has an empty receipt, and we
    // never emit systemMessage: "" for it.
    if (typeof result.receipt === "string" && result.receipt.length > 0) {
      output.systemMessage = result.receipt;
    }
    if (typeof result.focusNote === "string" && result.focusNote.length > 0) {
      output.hookSpecificOutput = {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.focusNote,
      };
    }
    return output;
  } catch {
    return {};
  }
}

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export async function handlePostToolUse(
  input: PostToolUseInput,
): Promise<Record<string, unknown>> {
  const fernDir = findFernDir(input.cwd);
  await debugLog(fernDir, "PostToolUse", input);
  if (!fernDir) return {};
  const projectPath = dirname(fernDir);

  const filesTouched = extractTouchedFiles(
    input.tool_name,
    input.tool_input ?? {},
    projectPath,
  );
  if (filesTouched.length === 0) return {};

  const info = await isDaemonRunning(AbortSignal.timeout(PASSIVE_TIMEOUT_MS));
  if (!info) return {};

  try {
    await rawPostJson(
      info,
      "/tools",
      { projectPath, filesTouched, agentSessionId: input.session_id },
      AbortSignal.timeout(PASSIVE_TIMEOUT_MS),
    );
  } catch {
    // PostToolUse can't block anyway — a dropped call just means this
    // turn's file-overlap signal is slightly less informed.
  }
  return {};
}

export interface StopInput {
  session_id: string;
  cwd: string;
  hook_event_name: "Stop";
  last_assistant_message: string;
  stop_reason: string;
}

export async function handleStop(
  input: StopInput,
): Promise<Record<string, unknown>> {
  const fernDir = findFernDir(input.cwd);
  await debugLog(fernDir, "Stop", input);
  if (!fernDir) return {};
  const projectPath = dirname(fernDir);

  const info = await isDaemonRunning(AbortSignal.timeout(PASSIVE_TIMEOUT_MS));
  if (!info) return {};

  try {
    await rawPostJson(
      info,
      "/exchange-end",
      { projectPath },
      AbortSignal.timeout(PASSIVE_TIMEOUT_MS),
    );
  } catch {
    // silent — finalizeExchange also runs defensively at the top of the
    // next /prompt, so a dropped call here just defers it one turn.
  }
  return {};
}

export interface SessionStartInput {
  session_id: string;
  cwd: string;
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | "fork";
}

export async function handleSessionStart(
  input: SessionStartInput,
): Promise<Record<string, unknown>> {
  const fernDir = findFernDir(input.cwd);
  await debugLog(fernDir, "SessionStart", input);
  if (!fernDir) return {};
  const projectPath = dirname(fernDir);

  const info = await isDaemonRunning(AbortSignal.timeout(PASSIVE_TIMEOUT_MS));
  if (!info) {
    // "Start the daemon if needed" — fire-and-forget, never wait for it
    // to come up. Spawning unconditionally (without this check) would
    // make every resume/clear/compact/fork fight over the fixed port
    // with an already-running daemon, since spawnDaemonDetached() always
    // tries to bind, forcing a port-retry churn that orphans the warm
    // daemon and wastes the embedder's warm-up on a second process.
    spawnDaemonDetached();
    return {};
  }

  // Nothing to restore on a fresh startup; inject the brief on resume,
  // /clear, compaction, and fork — spec §7 plus "for free" per
  // decisions.md.
  if (input.source === "startup") return {};

  try {
    const result = await rawGetJson(
      info,
      `/status?projectPath=${encodeURIComponent(projectPath)}&agentSessionId=${encodeURIComponent(input.session_id)}`,
      AbortSignal.timeout(PASSIVE_TIMEOUT_MS),
    );
    const brief = typeof result.brief === "string" ? result.brief : "";
    if (!brief) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: brief,
      },
    };
  } catch {
    return {};
  }
}
