// PostToolUse sends paths only, relativized to the project root — never
// tool_output or file contents (CLAUDE.md's no-raw-content rule). Field
// names below (file_path for Read/Edit/Write, notebook_path for
// NotebookEdit, command for Bash/PowerShell) match this environment's
// own tool schemas, confirmed against the official hooks/tools reference
// docs for PostToolUse's tool_input shape.

import { isAbsolute, relative, resolve } from "node:path";
import { extractFileMentions, type FileTouch } from "@context-fern/core";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function relativize(projectPath: string, rawPath: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(projectPath, rawPath);
  return relative(projectPath, abs).split("\\").join("/");
}

export function extractTouchedFiles(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string,
): FileTouch[] {
  const seen = new Set<string>();
  const result: FileTouch[] = [];

  function add(rawPath: string, source: FileTouch["source"]): void {
    const rel = relativize(projectPath, rawPath);
    if (seen.has(rel)) return;
    seen.add(rel);
    result.push({ path: rel, source });
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput.command;
    if (typeof command === "string") {
      for (const mention of extractFileMentions(command))
        add(mention, "command");
    }
    return result;
  }

  const direct = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof direct === "string") add(direct, "tool_input");

  return result;
}
