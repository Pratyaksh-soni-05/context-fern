import { CLI_NAME } from "@context-fern/core";
import { postJson } from "../daemon-client";

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

export async function runMode(mode: string | undefined): Promise<void> {
  if (!mode) {
    console.error(`usage: ${CLI_NAME} mode <observe|suggest|isolate>`);
    return;
  }
  await postJson("/mode", { projectPath: projectPath(), mode });
  console.log(`${CLI_NAME} ▸ mode ${mode}`);
}
