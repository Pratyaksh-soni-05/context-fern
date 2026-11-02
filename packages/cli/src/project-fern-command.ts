// A project-level `.claude/commands/<CLI_NAME>.md`, written by `fern
// init` (never into ~/.claude — see docs/decisions.md). Claude Code's
// interactive TUI rejects a bare "/fern ..." as "Unknown command" before
// any hook runs at all, UNLESS a command named exactly `fern` (no
// namespace) is registered somewhere Claude Code can see — the plugin's
// own command is namespaced ("fern:fern") once installed via a
// marketplace, which the TUI's pre-check doesn't treat as a match for
// the bare name. This file's only job is to make the bare name
// recognized so the real `UserPromptSubmit` hook interception (already
// proven to work once a prompt reaches it) gets the chance to run at
// all; its own body is a true last-resort fallback, same as the
// plugin's commands/fern.md, and deliberately static — no
// `${CLAUDE_PLUGIN_ROOT}`, no bun/TS, nothing that could fail to
// resolve for a project command outside the plugin's own install.

import { CLI_NAME } from "@context-fern/core";

export function renderProjectFernCommand(): string {
  return `---
description: Context Fern status, fronds, and routing commands
disable-model-invocation: true
allowed-tools: ["Bash(echo *)"]
---

This is a last-resort fallback for \`/${CLI_NAME}\` — the \`UserPromptSubmit\`
hook intercepts \`/${CLI_NAME} ...\` before it ever reaches here and blocks
it with zero model turns. This file exists only so Claude Code's
interactive command matcher recognizes the bare \`/${CLI_NAME}\` name —
without it, typing \`/${CLI_NAME} ...\` in the interactive TUI is rejected
as "Unknown command" before any hook gets a chance to run at all (see
docs/decisions.md). This body only runs if that interception genuinely
doesn't happen — hooks disabled, or a future Claude Code version
changing hook ordering.

!\`echo "${CLI_NAME} ▸ the ${CLI_NAME} hook didn't run · try again, or run ${CLI_NAME} doctor"\`
`;
}
