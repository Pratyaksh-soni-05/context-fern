import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_NAME, CONFIG_DIR } from "@context-fern/core";
import { renderDefaultConfigToml } from "../config-template";
import { appendToGitignore, gitignoreHasEntry } from "../gitignore";
import { renderProjectFernCommand } from "../project-fern-command";
import { promptYesNo } from "../prompt-yes-no";
import { runStatusline } from "./statusline";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(flags: Record<string, string>): Promise<void> {
  const projectPath = process.cwd();
  const fernDir = join(projectPath, CONFIG_DIR);
  await mkdir(fernDir, { recursive: true });

  const configPath = join(fernDir, "config.toml");
  if (!(await fileExists(configPath))) {
    await writeFile(configPath, renderDefaultConfigToml(), "utf-8");
    console.log(`${CLI_NAME} ▸ created ${CONFIG_DIR}/config.toml`);
  } else {
    console.log(
      `${CLI_NAME} ▸ ${CONFIG_DIR}/config.toml already exists, left untouched`,
    );
  }

  const gitignorePath = join(projectPath, ".gitignore");
  const entry = `${CONFIG_DIR}/`;
  if (flags.no === "true") {
    console.log(`${CLI_NAME} ▸ skipped .gitignore (--no)`);
  } else if (await gitignoreHasEntry(gitignorePath, entry)) {
    console.log(`${CLI_NAME} ▸ ${entry} already in .gitignore`);
  } else {
    const confirmed =
      flags.yes === "true" ||
      (await promptYesNo(`Add ${entry} to .gitignore?`));
    if (confirmed) {
      await appendToGitignore(gitignorePath, entry);
      console.log(`${CLI_NAME} ▸ added ${entry} to .gitignore`);
    } else {
      console.log(`${CLI_NAME} ▸ left .gitignore untouched`);
    }
  }

  // `--statusline yes|no` is independent of the .gitignore offer's
  // --yes/--no on purpose: this one reaches outside the project into
  // ~/.claude/settings.json, a bigger side effect that needs its own
  // real consent — see docs/decisions.md. It falls back to --yes/--no
  // when unset, so a bare `--no` still skips everything non-interactively
  // as before. The zero-model-turn "/fern init" path (fern-dispatch.ts)
  // explicitly passes statusline: "no" so it never touches global
  // settings with no real user present to ask.
  const statuslineFlag =
    flags.statusline ??
    (flags.no === "true" ? "no" : flags.yes === "true" ? "yes" : undefined);
  if (statuslineFlag === "no") {
    console.log(`${CLI_NAME} ▸ skipped statusline`);
  } else {
    const confirmed =
      statuslineFlag === "yes" ||
      (await promptYesNo(`Install the ${CLI_NAME} statusline?`));
    if (confirmed) await runStatusline({ install: "true" });
    else console.log(`${CLI_NAME} ▸ skipped statusline`);
  }

  // A bare "/fern" is rejected by Claude Code's interactive TUI as
  // "Unknown command" before any hook runs, unless a command literally
  // named "fern" is registered — the plugin's own command is namespaced
  // ("fern:fern") once installed, which doesn't satisfy that check. A
  // project-level `.claude/commands/<name>.md` does. This is project-
  // local (never ~/.claude), so — like the .gitignore offer above, and
  // unlike the statusline offer, which reaches outside the project —
  // it falls back to --yes/--no when its own flag is unset. See
  // docs/decisions.md.
  const projectCommandPath = join(
    projectPath,
    ".claude",
    "commands",
    `${CLI_NAME}.md`,
  );
  if (await fileExists(projectCommandPath)) {
    console.log(
      `${CLI_NAME} ▸ .claude/commands/${CLI_NAME}.md already exists, left untouched`,
    );
  } else {
    const projectCommandFlag =
      flags["project-command"] ??
      (flags.no === "true" ? "no" : flags.yes === "true" ? "yes" : undefined);
    const confirmed =
      projectCommandFlag === "yes" ||
      (projectCommandFlag !== "no" &&
        (await promptYesNo(
          `Register a project-level /${CLI_NAME} command (needed for "/${CLI_NAME}" to work in Claude Code's interactive TUI)?`,
        )));
    if (confirmed) {
      await mkdir(join(projectPath, ".claude", "commands"), {
        recursive: true,
      });
      await writeFile(projectCommandPath, renderProjectFernCommand(), "utf-8");
      console.log(`${CLI_NAME} ▸ added .claude/commands/${CLI_NAME}.md`);
    } else {
      console.log(`${CLI_NAME} ▸ skipped .claude/commands/${CLI_NAME}.md`);
    }
  }

  // The daemon defaults every new session to "suggest" mode
  // (project-registry.ts) — this message used to claim "observe", which
  // was stale/never-true text: nothing in fern init ever set observe,
  // and a project in observe mode shows no suggestions or focus notes
  // at all, which isn't a sensible silent default for a tool whose
  // entire value is manual-first suggestions. See docs/decisions.md.
  console.log(
    `${CLI_NAME} ▸ ready · mode suggest · run "${CLI_NAME} mode observe" for a quiet, no-suggestions mode`,
  );
}
