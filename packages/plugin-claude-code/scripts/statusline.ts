// Source-checkout entry for the statusline: the same renderer the shipped
// `context-fern statusline` command runs (packages/cli/src/commands/statusline.ts).
// Not shippable as a plugin-provided statusline: Claude Code plugins can't
// register one (confirmed against the docs, see docs/decisions.md). A shipped
// install does not use this file; `fern statusline --install` wires
// `context-fern statusline` into the user's own ~/.claude/settings.json.

import { renderStatusline } from "@context-fern/cli/statusline";

if (import.meta.main) {
  await renderStatusline();
  process.exit(0);
}
