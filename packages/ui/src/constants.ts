import { CLI_NAME } from "@context-fern/core";

// Display-only fallback for the rare case window.location.port is
// empty (served from the default port of its scheme). Mirrors
// packages/daemon/src/server.ts's FIRST_PORT — not imported from
// there, since `daemon` pulls in `store`/`bun:sqlite`, which can't be
// bundled into this browser package (ui only talks to the daemon over
// its HTTP API, per CLAUDE.md's architecture rules).
export const DEFAULT_DAEMON_PORT = "7420";

// "fern ui" composed from the one real brand constant, not hard-coded —
// CLAUDE.md: the CLI name may still change before launch.
export const UI_COMMAND = `${CLI_NAME} ui`;
