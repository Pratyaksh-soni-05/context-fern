---
description: Context Fern status, fronds, and routing commands
disable-model-invocation: true
allowed-tools: ["Bash(bun *)"]
---

This is the fallback path for `/fern` — the UserPromptSubmit hook
(scripts/user-prompt-submit.ts) intercepts `/fern ...` before it ever
reaches here and blocks it with zero model turns, confirmed to work even
when no slash command is registered with this name at all (see
docs/decisions.md). This file only runs if that interception genuinely
doesn't happen — hooks disabled, `claude --bare`, or a future Claude
Code version changing hook ordering.

It takes no arguments on purpose: `$ARGUMENTS` used to be spliced
straight into this line, and while double-quoting it closed off `;`/`|`/
`&`/newline injection, it could never close `$(...)`/backtick command
substitution, which still expands inside double quotes in both `sh` and
PowerShell. Since the hook above already handles every real `/fern ...`
command, this path only ever runs when something is already broken —
so it just reports that, with a fixed, argument-free call. No user text
reaches a shell here at all.

!`bun run "${CLAUDE_PLUGIN_ROOT}"/scripts/fern-command.ts --fallback`
