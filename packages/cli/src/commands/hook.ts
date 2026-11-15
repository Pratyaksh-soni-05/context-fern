// `context-fern hook <event>` — the Claude Code hook entrypoint, reached
// directly from packages/plugin-claude-code/hooks/hooks.json (no `bun
// run <script>.ts` in between; see docs/decisions.md's Phase-4 PR 2
// entry). Dispatches to the real handlers in ./hooks/hook-handlers —
// never reimplemented here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_BINARY_NAME, CLI_VERSION } from "@context-fern/core";
import {
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
  type PostToolUseInput,
  type SessionStartInput,
  type StopInput,
  type UserPromptSubmitInput,
} from "../hooks/hook-handlers";
import { readStdinJson, writeJson } from "../hooks/stdio";

/**
 * Claude Code exports `${CLAUDE_PLUGIN_ROOT}` as a plain env var to every
 * hook process (confirmed against the current hooks docs — see
 * docs/decisions.md), so this needs no extra arg plumbing in hooks.json:
 * read the plugin's own declared version from its manifest and compare
 * to this binary's CLI_VERSION. Returns null (never throws, never
 * blocks) if the env var is unset, the manifest is missing, or it fails
 * to parse — a hook running outside the plugin (manual testing, a dev
 * checkout) must not get a fabricated skew warning.
 */
async function pluginVersionSkew(): Promise<string | null> {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return null;
  try {
    const text = await readFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      "utf-8",
    );
    const manifest = JSON.parse(text) as { version?: unknown };
    if (
      typeof manifest.version === "string" &&
      manifest.version !== CLI_VERSION
    ) {
      return `${CLI_BINARY_NAME} ▸ plugin and binary versions differ · run ${CLI_BINARY_NAME} doctor`;
    }
  } catch {
    // Missing/unreadable/malformed manifest — never block a hook over it.
  }
  return null;
}

/** Folds the skew receipt into whatever the real handler already returned, without clobbering an existing systemMessage. */
function withSkewReceipt(
  output: Record<string, unknown>,
  skew: string | null,
): Record<string, unknown> {
  if (!skew) return output;
  const existing = output.systemMessage;
  const systemMessage =
    typeof existing === "string" && existing.length > 0
      ? `${skew}\n${existing}`
      : skew;
  return { ...output, systemMessage };
}

export async function runHook(event: string | undefined): Promise<number> {
  const skew = await pluginVersionSkew();

  switch (event) {
    case "UserPromptSubmit": {
      const input = await readStdinJson<UserPromptSubmitInput>();
      writeJson(withSkewReceipt(await handleUserPromptSubmit(input), skew));
      return 0;
    }
    case "PostToolUse": {
      const input = await readStdinJson<PostToolUseInput>();
      writeJson(withSkewReceipt(await handlePostToolUse(input), skew));
      return 0;
    }
    case "Stop": {
      const input = await readStdinJson<StopInput>();
      writeJson(withSkewReceipt(await handleStop(input), skew));
      return 0;
    }
    case "SessionStart": {
      const input = await readStdinJson<SessionStartInput>();
      writeJson(withSkewReceipt(await handleSessionStart(input), skew));
      return 0;
    }
    default:
      console.error(
        `${CLI_BINARY_NAME}: unknown hook event "${event}" (expected UserPromptSubmit|PostToolUse|Stop|SessionStart)`,
      );
      // Never block the caller over an unrecognized event — a future
      // Claude Code event this binary doesn't know about yet should be
      // a silent no-op, not a hook failure.
      writeJson({});
      return 0;
  }
}
