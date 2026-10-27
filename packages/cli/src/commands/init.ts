import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_NAME, CONFIG_DIR } from "@context-fern/core";
import { renderDefaultConfigToml } from "../config-template";
import { appendToGitignore, gitignoreHasEntry } from "../gitignore";
import { promptYesNo } from "../prompt-yes-no";

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

  console.log(
    `${CLI_NAME} ▸ ready · mode observe · run "${CLI_NAME} mode suggest" to turn on suggestions`,
  );
}
