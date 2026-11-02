export const PACKAGE_NAME = "plugin-claude-code";

export { extractTouchedFiles } from "./extract-touched-files";
export { type DispatchOptions, dispatchFernCommand } from "./fern-dispatch";
export {
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
  type PostToolUseInput,
  type SessionStartInput,
  type StopInput,
  type UserPromptSubmitInput,
} from "./hook-handlers";
