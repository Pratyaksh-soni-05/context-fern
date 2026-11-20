// Which modes a user can actually pick in this release. Isolate mode needs a
// proxy between the agent and the model provider; that proxy is not built, so
// picking it must say so instead of silently behaving like suggest (spec §3
// item 6, docs/decisions.md 2026-11-20). The Mode type in types.ts still lists
// "isolate" so the stored value and the design keep their place.

import { CLI_NAME } from "./brand";

export const AVAILABLE_MODES = ["observe", "suggest"] as const;
export type AvailableMode = (typeof AVAILABLE_MODES)[number];

export type ModeCheck =
  | { ok: true; mode: AvailableMode }
  | { ok: false; message: string };

/** Says what happened and the one command that fixes it. */
export function checkMode(mode: unknown): ModeCheck {
  if (mode === "observe" || mode === "suggest") return { ok: true, mode };
  if (mode === "isolate") {
    return {
      ok: false,
      message: `isolate mode is not available in this release · to pick a mode that is: ${CLI_NAME} mode suggest (or ${CLI_NAME} mode observe)`,
    };
  }
  const shown = typeof mode === "string" ? `"${mode.slice(0, 40)}"` : "that";
  return {
    ok: false,
    message: `${shown} is not a mode · the modes are observe and suggest: ${CLI_NAME} mode suggest`,
  };
}
