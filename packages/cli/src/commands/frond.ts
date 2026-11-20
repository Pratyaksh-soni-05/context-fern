import { CLI_NAME, checkMode } from "@context-fern/core";
import { postJson } from "@context-fern/daemon/client";

function projectPath(): string {
  return process.cwd();
}

export async function runNew(name: string | undefined): Promise<void> {
  const prompt = name ? `/${CLI_NAME} new ${name}` : `/${CLI_NAME} new`;
  const res = await postJson("/prompt", { projectPath: projectPath(), prompt });
  console.log(res.receipt);
}

export async function runSwitch(name: string | undefined): Promise<void> {
  const prompt = name ? `/${CLI_NAME} switch ${name}` : `/${CLI_NAME} switch`;
  const res = await postJson("/prompt", { projectPath: projectPath(), prompt });
  console.log(res.receipt);
}

export async function runStray(): Promise<void> {
  const res = await postJson("/prompt", {
    projectPath: projectPath(),
    prompt: `/${CLI_NAME} stray`,
  });
  console.log(res.receipt);
}

export async function runUndo(): Promise<void> {
  const res = await postJson("/undo", { projectPath: projectPath() });
  console.log(res.receipt);
}

export async function runMerge(name: string | undefined): Promise<void> {
  if (!name) {
    console.error(`usage: ${CLI_NAME} merge <name> --summary`);
    return;
  }
  const res = await postJson("/merge", {
    projectPath: projectPath(),
    frondName: name,
  });
  console.log(res.receipt);
}

/** The exit code: 0 when the mode was set, 1 when it is not one a user can pick (isolate mode is not built) or is missing. Checked here first so a refused mode never starts a daemon. */
export async function runMode(mode: string | undefined): Promise<number> {
  if (!mode) {
    console.error(`usage: ${CLI_NAME} mode <observe|suggest>`);
    return 1;
  }
  const checked = checkMode(mode);
  if (!checked.ok) {
    console.error(`${CLI_NAME} ▸ ${checked.message}`);
    return 1;
  }
  await postJson("/mode", { projectPath: projectPath(), mode: checked.mode });
  console.log(`${CLI_NAME} ▸ mode ${checked.mode}`);
  return 0;
}
